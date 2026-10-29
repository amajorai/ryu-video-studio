import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useRef, useState } from "react";
import { MAX_CANVAS } from "../../../shared/limits.ts";
import {
	type MatteRequest,
	MIN_MATTE_EDGE,
	matteRequestSchema,
} from "../../../shared/matte.ts";
import { assetSchema } from "../../../shared/project.ts";
import { request, studioResponseSchema } from "../bridge.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	importLottie,
	type LottieImportOptions,
	lottieAssetName,
	readLottieFile,
} from "../import/lottie-import.ts";

/** Sidecar call that creates a matte (injectable for tests). */
export type MatteSend = (body: MatteRequest) => Promise<unknown>;

const defaultMatteSend: MatteSend = (body) =>
	request(studioResponseSchema, "/matte", "POST", body);

/** Create a solid color matte asset and add it to the library. */
export const createMatte = (
	runtime: Pick<EditorRuntime, "act" | "setAssets" | "setStatus">,
	input: MatteRequest,
	send: MatteSend = defaultMatteSend
) =>
	runtime.act(async () => {
		const asset = assetSchema.parse(
			await send(matteRequestSchema.parse(input))
		);
		runtime.setAssets((current) => [asset, ...current]);
		runtime.setStatus(
			`${asset.name} created. Add it to the timeline from the library.`
		);
	});

type LottieFileOptions = Pick<
	LottieImportOptions,
	"createRenderer" | "onEncoding" | "send" | "signal"
>;

/** Render, upload and encode a picked Lottie JSON or `.lottie` as a video with alpha. */
export const importLottieFile = (
	runtime: Pick<EditorRuntime, "act" | "setAssets" | "setStatus">,
	file: File,
	projectFps: number,
	options: LottieFileOptions = {}
) => runtime.act(() => runLottieImport(runtime, file, projectFps, options));

/**
 * The Lottie import without the editor's busy wrapper, for callers already
 * inside `runtime.act` (the media import of dropped or picked files).
 */
export const runLottieImport = (
	runtime: Pick<EditorRuntime, "setAssets" | "setStatus">,
	file: File,
	projectFps: number,
	options: LottieFileOptions = {}
) =>
	(async () => {
		const animation = await readLottieFile(file);
		const { asset, preview } = await importLottie({
			...options,
			animation,
			name: lottieAssetName(file.name),
			onProgress: (fraction) =>
				runtime.setStatus(
					fraction < 1
						? `Rendering ${file.name} · ${Math.round(fraction * 100)}%`
						: `Encoding ${file.name} with alpha…`
				),
			projectFps,
		});
		// The preview copy is a proxy of `asset` (derivedFromAssetId), chosen
		// by the preview's proxy selection; timelines reference only `asset`.
		runtime.setAssets((current) =>
			preview ? [asset, preview, ...current] : [asset, ...current]
		);
		runtime.setStatus(
			`${asset.name} imported as a video with transparency. Add it to the timeline from the library.`
		);
	})();

/**
 * A matte edge typed into a field, or `undefined` while the text is not a
 * whole pixel count in range. Fields keep the raw text while the user types;
 * only a complete, valid value enables Create.
 */
export function parseMatteEdge(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) {
		return;
	}
	const value = Number(trimmed);
	return value >= MIN_MATTE_EDGE && value <= MAX_CANVAS ? value : undefined;
}

/** "New media" actions: solid color mattes and Lottie animations. */
export function NewMediaMenu() {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const { busy, project } = runtime;
	const picker = useRef<HTMLInputElement>(null);
	const lottieAbort = useRef<AbortController | null>(null);
	const [lottiePhase, setLottiePhase] = useState<
		"encoding" | "idle" | "rendering"
	>("idle");
	const [matteOpen, setMatteOpen] = useState(false);
	const [color, setColor] = useState("#000000");
	// Raw field text; `null` follows the project canvas.
	const [widthText, setWidthText] = useState<string | null>(null);
	const [heightText, setHeightText] = useState<string | null>(null);
	const widthValue = widthText ?? String(project.width);
	const heightValue = heightText ?? String(project.height);
	const matte = matteRequestSchema.safeParse({
		color,
		height: parseMatteEdge(heightValue),
		width: parseMatteEdge(widthValue),
	});

	const startLottie = async (file: File) => {
		const controller = new AbortController();
		lottieAbort.current = controller;
		setLottiePhase("rendering");
		try {
			await importLottieFile(runtime, file, project.fps, {
				// The encode cannot be interrupted once it is sent, so Cancel
				// is withdrawn instead of pretending to work.
				onEncoding: () => setLottiePhase("encoding"),
				signal: controller.signal,
			});
		} finally {
			lottieAbort.current = null;
			setLottiePhase("idle");
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<RyuAppActions>
				<Button
					aria-expanded={matteOpen}
					disabled={busy}
					onClick={() => setMatteOpen((open) => !open)}
					variant="outline"
				>
					New color matte
				</Button>
				<Button
					disabled={busy}
					onClick={() => picker.current?.click()}
					variant="outline"
				>
					Import Lottie
				</Button>
				{lottiePhase === "rendering" && (
					<Button onClick={() => lottieAbort.current?.abort()} variant="ghost">
						Cancel Lottie import
					</Button>
				)}
			</RyuAppActions>
			{matteOpen && (
				<div className="flex flex-col gap-2">
					<RyuAppField label="Color">
						<Input
							aria-label="Matte color"
							disabled={busy}
							onChange={(event) => setColor(event.target.value)}
							type="color"
							value={color}
						/>
					</RyuAppField>
					<div className="studio-inline-fields">
						<RyuAppField label="Width (px)">
							<Input
								aria-invalid={parseMatteEdge(widthValue) === undefined}
								aria-label="Matte width"
								disabled={busy}
								max={MAX_CANVAS}
								min={MIN_MATTE_EDGE}
								onChange={(event) => setWidthText(event.target.value)}
								step={1}
								type="number"
								value={widthValue}
							/>
						</RyuAppField>
						<RyuAppField label="Height (px)">
							<Input
								aria-invalid={parseMatteEdge(heightValue) === undefined}
								aria-label="Matte height"
								disabled={busy}
								max={MAX_CANVAS}
								min={MIN_MATTE_EDGE}
								onChange={(event) => setHeightText(event.target.value)}
								step={1}
								type="number"
								value={heightValue}
							/>
						</RyuAppField>
					</div>
					<RyuAppActions>
						<Button
							disabled={busy || !matte.success}
							onClick={() => {
								if (matte.success) {
									void createMatte(runtime, matte.data);
								}
							}}
						>
							Create matte
						</Button>
					</RyuAppActions>
					<small>
						{tl(
							"Mattes default to the project canvas. Like any still, a matte is placed for 5 seconds and holds for any length you trim it to. Width and height are whole pixels from {minEdge} to {maxEdge}.",
							{ maxEdge: String(MAX_CANVAS), minEdge: String(MIN_MATTE_EDGE) }
						)}
					</small>
				</div>
			)}
			<input
				accept="application/json,.json,.lottie"
				aria-label="Lottie JSON or .lottie file"
				hidden
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) {
						void startLottie(file);
					}
				}}
				ref={picker}
				type="file"
			/>
		</div>
	);
}
