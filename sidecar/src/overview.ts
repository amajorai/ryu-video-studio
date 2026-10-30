import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Project, projectDuration } from "../../shared/project.ts";
import { renderTimelineFrame } from "./capture.ts";
import { runMedia } from "./media.ts";
import { withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/** Frames an overview samples when the caller does not ask for a count. */
export const DEFAULT_OVERVIEW_COUNT = 24;
/** Most frames one overview renders (each is a full timeline composite). */
export const MAX_OVERVIEW_COUNT = 48;
/** Thumbnail height when the caller does not ask for one. */
export const DEFAULT_OVERVIEW_HEIGHT = 90;
export const MIN_OVERVIEW_HEIGHT = 18;
export const MAX_OVERVIEW_HEIGHT = 180;
/** Tile columns when the caller does not ask for a layout. */
export const DEFAULT_OVERVIEW_COLUMNS = 8;
const MAX_OVERVIEW_BYTES = 64 * 1024 * 1024;

export const overviewRequestSchema = z
	.object({
		columns: z.number().int().min(1).max(MAX_OVERVIEW_COUNT).optional(),
		count: z
			.number()
			.int()
			.min(1)
			.max(MAX_OVERVIEW_COUNT)
			.default(DEFAULT_OVERVIEW_COUNT),
		end: z.number().finite().min(0).max(7200).optional(),
		height: z
			.number()
			.int()
			.min(MIN_OVERVIEW_HEIGHT)
			.max(MAX_OVERVIEW_HEIGHT)
			.default(DEFAULT_OVERVIEW_HEIGHT),
		start: z.number().finite().min(0).max(7200).default(0),
	})
	.strict();

export type OverviewRequest = z.infer<typeof overviewRequestSchema>;

export interface OverviewLayout {
	columns: number;
	/** Sprite height in pixels. */
	height: number;
	rows: number;
	thumbHeight: number;
	thumbWidth: number;
	/** Sprite width in pixels. */
	width: number;
}

export const overviewResultSchema = z
	.object({
		columns: z.number().int().min(1),
		data: z.string(),
		height: z.number().int().min(1),
		mimeType: z.literal("image/png"),
		projectId: z.string(),
		revision: z.number().int().nonnegative(),
		rows: z.number().int().min(1),
		thumbHeight: z.number().int().min(1),
		thumbWidth: z.number().int().min(1),
		times: z.array(z.number().finite().min(0)),
		width: z.number().int().min(1),
	})
	.strict();

export type OverviewResult = z.infer<typeof overviewResultSchema>;

/** Even pixel count, at least 2, as FFmpeg's scalers expect. */
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Sprite layout for `count` thumbnails `thumbHeight` pixels tall. The
 * thumbnail keeps the canvas aspect ratio; tiles fill row by row.
 */
export function overviewLayout(
	canvas: { height: number; width: number },
	count: number,
	thumbHeight: number,
	columns = DEFAULT_OVERVIEW_COLUMNS
): OverviewLayout {
	const height = even(thumbHeight);
	const width = even((height * canvas.width) / Math.max(1, canvas.height));
	const cols = Math.max(1, Math.min(columns, count));
	const rows = Math.ceil(count / cols);
	return {
		columns: cols,
		height: height * rows,
		rows,
		thumbHeight: height,
		thumbWidth: width,
		width: width * cols,
	};
}

/**
 * Evenly spaced sample times across `[start, end)`: the centre of each of
 * `count` equal slices, snapped down to a frame boundary so the overview
 * shows frames the timeline can actually display.
 */
export function overviewTimes(
	start: number,
	end: number,
	count: number,
	fps: number
): number[] {
	if (!(end > start)) {
		throw new Error("Choose an overview range that has a duration.");
	}
	const slice = (end - start) / count;
	const lastFrame = Math.max(start, end - 1 / fps);
	return Array.from({ length: count }, (_, index) => {
		const centre = start + slice * (index + 0.5);
		const snapped = Math.floor(centre * fps + 1e-9) / fps;
		return Number(Math.min(lastFrame, Math.max(start, snapped)).toFixed(6));
	});
}

/** Time budget for one overview: a fixed base plus a share per frame. */
export const overviewTimeoutMs = (count: number) =>
	Math.min(600_000, 30_000 + count * 8000);

/**
 * Render `count` evenly spaced composited timeline frames and tile them into
 * one PNG sprite, under a single media admission.
 */
export async function renderOverview(
	store: StudioStore,
	project: Project,
	input: OverviewRequest,
	options: { signal?: AbortSignal } = {}
): Promise<OverviewResult> {
	const duration = projectDuration(project);
	if (!duration) {
		throw new Error("Add media, graphics, or an avatar before an overview.");
	}
	const end = Math.min(input.end ?? duration, duration);
	const times = overviewTimes(input.start, end, input.count, project.fps);
	const layout = overviewLayout(
		project,
		input.count,
		input.height,
		input.columns
	);
	return await withMediaOperation(
		overviewTimeoutMs(input.count),
		options,
		async (operation) => {
			const work = join(
				store.directory,
				"renders",
				`overview-${crypto.randomUUID()}`
			);
			await mkdir(work, { recursive: true });
			try {
				for (const [index, time] of times.entries()) {
					const frame = await renderTimelineFrame(store, project, time, {
						operation,
					});
					operation.check();
					await Bun.write(
						join(work, `frame-${String(index).padStart(3, "0")}.png`),
						frame
					);
				}
				const sprite = join(work, "overview.png");
				await runMedia(
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-nostdin",
						"-y",
						"-framerate",
						"1",
						"-start_number",
						"0",
						"-i",
						"frame-%03d.png",
						"-vf",
						[
							`scale=${layout.thumbWidth}:${layout.thumbHeight}:flags=area`,
							"setsar=1",
							`tile=${layout.columns}x${layout.rows}:color=black`,
						].join(","),
						"-frames:v",
						"1",
						"-update",
						"1",
						"overview.png",
					],
					{
						cwd: work,
						signal: operation.signal,
						timeoutMs: operation.remainingMs(),
						outputPath: sprite,
						maxOutputBytes: MAX_OVERVIEW_BYTES,
					}
				);
				operation.check();
				const bytes = await Bun.file(sprite).arrayBuffer();
				return overviewResultSchema.parse({
					columns: layout.columns,
					data: Buffer.from(bytes).toString("base64"),
					height: layout.height,
					mimeType: "image/png",
					projectId: project.id,
					revision: project.revision,
					rows: layout.rows,
					thumbHeight: layout.thumbHeight,
					thumbWidth: layout.thumbWidth,
					times,
					width: layout.width,
				});
			} finally {
				await rm(work, { recursive: true, force: true });
			}
		}
	);
}
