import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { link, mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegFrameRate } from "../../shared/frame-rate.ts";
import {
	maskedGraphicRaster,
	maskedGraphicRasterHalf,
} from "../../shared/graphic-masks.ts";
import type { Graphic, Project } from "../../shared/project.ts";
import {
	type FrameSize,
	graphicAnimatedValue,
	graphicAnimationExpression,
	graphicBaseValue,
	graphicBoxPx,
	graphicFrameState,
	graphicRotationOf,
	graphicShapeAt,
	hasGraphicKeyframes,
	hasGraphicShapeKeyframes,
	MAX_RASTER_SIDE,
	usesLegacyDrawbox,
} from "../../shared/shape-geometry.ts";
import { compositeLayer } from "./render-composite.ts";
import { encodeRgbaPng } from "./render-graphics-png.ts";

export interface OverlayChain {
	filters: string[];
	/** Label of the composite after the last statement, without brackets. */
	last: string;
}

export interface GraphicsFilterOptions {
	/**
	 * A single-frame render's time: animated shapes write only the frames
	 * around it instead of their whole sequence.
	 */
	frameTime?: number;
	/**
	 * Directory for shape rasters and opacity command files. Defaults to a
	 * private directory per process under the OS temp directory, removed when
	 * the process exits (and swept by the next process if it was killed).
	 */
	rasterDirectory?: string;
	/**
	 * Frame sequences of shape-keyframed graphics written ahead of the graph
	 * by `prepareShapeSequences`, by sequence name. A graphic whose sequence
	 * is longer than `MAX_INLINE_SHAPE_FRAMES` must be here: drawing it while
	 * the graph is built would block the sidecar's event loop.
	 */
	shapeSequences?: ReadonlyMap<string, string>;
	/**
	 * A chunk's window: a shape sequence is read from the window's first
	 * frame (one frame of slack) instead of decoding it from its start.
	 */
	window?: { startFrame: number };
}

function graphicPosition(graphic: Graphic): { x: string; y: string } {
	const progress = graphic.entryDuration
		? `min(1,max(0,(t-${graphic.start})/${graphic.entryDuration}))`
		: "1";
	const offset = `(1-(${progress}))*0.08`;
	const x =
		graphic.animation === "slide-left"
			? `${graphic.x}-(${offset})`
			: graphic.animation === "slide-right"
				? `${graphic.x}+(${offset})`
				: String(graphic.x);
	const y =
		graphic.animation === "slide-up"
			? `${graphic.y}+(${offset})`
			: graphic.animation === "slide-down"
				? `${graphic.y}-(${offset})`
				: String(graphic.y);
	return { x, y };
}

const formatNumber = (value: number): string => {
	const rounded = Number(value.toFixed(6));
	return `${Object.is(rounded, -0) ? 0 : rounded}`;
};

/**
 * Escapes a file path as the value of a filter option inside
 * `-filter_complex`: first the option level (`\ ' :`), then the graph level
 * (`\ ' [ ] , ;`).
 */
export function filtergraphPath(path: string): string {
	const optionLevel = path.replace(/[\\':]/g, (character) => `\\${character}`);
	return optionLevel.replace(/[\\'[\],;]/g, (character) => `\\${character}`);
}

const RASTER_DIRECTORY_PREFIX = "ryu-video-studio-shapes-";
const RASTER_DIRECTORY_PATTERN = /^ryu-video-studio-shapes-(\d+)-/;
let defaultRasterDirectory: string | undefined;
interface WrittenRaster {
	offset: { x: number; y: number };
	path: string;
	pixelSize: number;
	size: number;
}
const writtenRasters = new Map<string, WrittenRaster>();
const MAX_REMEMBERED_RASTERS = 256;

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * Removes raster directories left by sidecar processes that were killed
 * before their exit cleanup ran. Directory names carry the owner's pid.
 */
export function sweepStaleRasterDirectories(
	root: string = tmpdir(),
	isAlive: (pid: number) => boolean = processAlive
): string[] {
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		const match = RASTER_DIRECTORY_PATTERN.exec(name);
		const pid = Number(match?.[1]);
		if (!(match && Number.isSafeInteger(pid)) || pid === process.pid) {
			continue;
		}
		if (!isAlive(pid)) {
			rmSync(join(root, name), { force: true, recursive: true });
			removed.push(name);
		}
	}
	return removed;
}

function rasterDirectory(options: GraphicsFilterOptions): string {
	if (options.rasterDirectory) {
		return options.rasterDirectory;
	}
	if (!defaultRasterDirectory) {
		sweepStaleRasterDirectories();
		const created = mkdtempSync(
			join(tmpdir(), `${RASTER_DIRECTORY_PREFIX}${process.pid}-`)
		);
		defaultRasterDirectory = created;
		process.once("exit", () => {
			rmSync(created, { force: true, recursive: true });
		});
	}
	// Recreated if something removed it while the process was running.
	mkdirSync(defaultRasterDirectory, { recursive: true });
	return defaultRasterDirectory;
}

/** Writes `content` once under a content-addressed name and returns the path. */
function writeContentFile(
	directory: string,
	prefix: string,
	extension: string,
	content: Uint8Array | string
): string {
	const name = createHash("sha256").update(content).digest("hex").slice(0, 32);
	const path = join(directory, `${prefix}-${name}.${extension}`);
	if (!existsSync(path)) {
		writeFileSync(path, content);
	}
	return path;
}

/**
 * Writes the raster as a content-addressed PNG (once per process and
 * directory) and returns its path.
 */
function rasterFile(
	graphic: Graphic,
	frame: FrameSize,
	bake: { opacity: number; rotation: number },
	options: GraphicsFilterOptions
): WrittenRaster {
	const directory = rasterDirectory(options);
	const key = JSON.stringify([
		directory,
		frame,
		bake,
		graphic.shape,
		graphic.width,
		graphic.height,
		graphic.fill,
		graphic.stroke,
		graphic.strokeWidth,
		graphic.strokeAlign,
		graphic.sides,
		graphic.points,
		graphic.innerRadius,
		graphic.cornerRadius,
		graphic.masks,
	]);
	const remembered = writtenRasters.get(key);
	if (remembered && existsSync(remembered.path)) {
		return remembered;
	}
	const raster = maskedGraphicRaster(graphic, frame, bake);
	const path = writeContentFile(
		directory,
		"shape",
		"png",
		encodeRgbaPng(raster.pixelSize, raster.pixelSize, raster.pixels)
	);
	if (writtenRasters.size >= MAX_REMEMBERED_RASTERS) {
		writtenRasters.clear();
	}
	const written = {
		offset: raster.offset,
		path,
		pixelSize: raster.pixelSize,
		size: raster.size,
	};
	writtenRasters.set(key, written);
	return written;
}

/**
 * `sendcmd` lines that set the opacity filter's alpha at every output frame
 * inside the graphic where the keyframed opacity changes (W2-V11). A frame
 * render enters every interval up to its time at once, so the last value
 * before it wins. Returns the opacity at the graphic's first frame too.
 */
export function opacityCommands(
	graphic: Graphic,
	fps: number,
	target: string
): { commands: string; initial: number } {
	const sample = (time: number) =>
		Number(
			Math.max(
				0,
				Math.min(
					1,
					graphicAnimatedValue(graphic, "opacity", time - graphic.start)
				)
			).toFixed(4)
		);
	const initial = sample(graphic.start);
	const lines: string[] = [];
	let previous = initial;
	const first = Math.ceil(graphic.start * fps - 1e-6);
	const last = Math.floor(graphic.end * fps + 1e-6);
	for (let frame = first; frame <= last; frame++) {
		const time = frame / fps;
		const value = sample(time);
		if (value !== previous) {
			lines.push(
				`${formatNumber(time)} ${target} a ${opacityExpression(value)};`
			);
			previous = value;
		}
	}
	return { commands: lines.join("\n"), initial };
}

/** `lut` alpha expression for a scalar opacity. */
const opacityExpression = (opacity: number): string =>
	`round(val*${formatNumber(opacity)})`;

/** Entry-slide offset expressions (normalized), or undefined on that axis. */
function slideOffset(graphic: Graphic): { x?: string; y?: string } {
	const progress = graphic.entryDuration
		? `min(1,max(0,(t-${graphic.start})/${graphic.entryDuration}))`
		: "1";
	const offset = `(1-(${progress}))*0.08`;
	switch (graphic.animation) {
		case "slide-left":
			return { x: `-${offset}` };
		case "slide-right":
			return { x: offset };
		case "slide-up":
			return { y: offset };
		case "slide-down":
			return { y: `-${offset}` };
		default:
			return {};
	}
}

/** Normalized x/y expression: keyframed or static, plus the entry slide. */
function rasterPosition(graphic: Graphic): { x: string; y: string } {
	const clock = `(t-${graphic.start})`;
	const slide = slideOffset(graphic);
	const axis = (property: "x" | "y") => {
		const value = hasGraphicKeyframes(graphic, property)
			? `(${graphicAnimationExpression(graphic, property, clock)})`
			: formatNumber(graphicBaseValue(graphic, property));
		const offset = slide[property];
		return offset ? `${value}+(${offset})` : value;
	};
	return { x: axis("x"), y: axis("y") };
}

/**
 * The PNG as a two-frame stream: the raster (scaled up once when it was
 * capped at `MAX_RASTER_SIDE`) at the graphic's start and again at its end,
 * then end of stream. Overlays hold the start frame through the window, so
 * nothing is produced or processed outside it and a frame render at any
 * time inside the window reads the start frame.
 */
function rasterSource(
	graphic: Graphic,
	raster: WrittenRaster,
	output: string,
	pixelFormat: "rgba" | "yuva420p"
): string {
	const scale =
		raster.pixelSize === raster.size
			? ""
			: `,scale=${raster.size}:${raster.size}:flags=bicubic`;
	const convert = pixelFormat === "rgba" ? "" : `,format=${pixelFormat}`;
	const span = Math.max(0, graphic.end - graphic.start);
	const timing =
		span > 0
			? `loop=loop=1:size=1,settb=AVTB,setpts=${formatNumber(graphic.start)}/TB+N*${formatNumber(span)}/TB`
			: `settb=AVTB,setpts=${formatNumber(graphic.start)}/TB`;
	return `movie=filename=${filtergraphPath(raster.path)},format=rgba${scale}${convert},${timing}[${output}]`;
}

/**
 * Disk one shape-keyframed graphic's frame sequence may use. Repeated frames
 * are hard links to one file, so only distinct frames count.
 */
export const MAX_SHAPE_SEQUENCE_BYTES = 2 * 1024 * 1024 * 1024;
/** Disk the frame sequences of one raster directory may use together. */
export const MAX_SHAPE_CACHE_BYTES = 4 * 1024 * 1024 * 1024;
/** Sequences used this recently (ms) are never evicted. */
const SHAPE_SEQUENCE_IN_USE_MS = 10 * 60_000;
const SEQUENCE_PREFIX = "shape-seq-";
const SEQUENCE_DONE = ".complete";

/** One distinct raster of a shape-keyframed graphic and when it starts showing. */
export interface ShapeSample {
	bake: { opacity: number; rotation: number };
	/** Output frame (project rate) the raster first shows on. */
	frame: number;
	shape: Graphic;
	time: number;
}

/** First and last output frames (project rate) a graphic shows on. */
export function shapeFrameSpan(
	graphic: Graphic,
	fps: number
): { first: number; last: number } {
	const first = Math.ceil(graphic.start * fps - 1e-6);
	const last = Math.max(first, Math.ceil(graphic.end * fps - 1e-6) - 1);
	return { first, last };
}

/**
 * The rasters a graphic whose size, stroke, corners or colors are keyframed
 * needs: its resolved shape (`graphicShapeAt`) with rotation and opacity at
 * every output frame inside it, consecutive identical frames merged. Every
 * frame is resolved; there is no sampling cap.
 */
export function shapeSamples(graphic: Graphic, fps: number): ShapeSample[] {
	const { first, last } = shapeFrameSpan(graphic, fps);
	const samples: ShapeSample[] = [];
	let previousKey = "";
	for (let frame = first; frame <= last; frame++) {
		const time = frame === first ? graphic.start : frame / fps;
		const state = graphicFrameState(graphic, time);
		const shape = graphicShapeAt(graphic, time - graphic.start);
		const bake = {
			opacity: Number(state.opacity.toFixed(4)),
			rotation: Number(state.rotation.toFixed(2)),
		};
		const key = JSON.stringify([
			bake,
			shape.width,
			shape.height,
			shape.fill,
			shape.stroke,
			shape.strokeWidth,
			shape.cornerRadius,
			shape.innerRadius,
		]);
		if (key !== previousKey) {
			samples.push({ bake, frame, shape, time });
			previousKey = key;
		}
	}
	return samples;
}

/** Bytes a finished sequence recorded in its completion marker. */
function sequenceBytes(path: string): number {
	try {
		return Number(readFileSync(join(path, SEQUENCE_DONE), "utf8")) || 0;
	} catch {
		return 0;
	}
}

/**
 * Remove the least recently used frame sequences in `directory` (other than
 * `keep`) until they fit `MAX_SHAPE_CACHE_BYTES`, never one used in the
 * last ten minutes. Unfinished sequences of dead writers are removed too.
 */
function evictShapeSequences(directory: string, keep: string) {
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return;
	}
	const now = Date.now();
	const finished: { bytes: number; path: string; used: number }[] = [];
	for (const name of names) {
		if (!name.startsWith(SEQUENCE_PREFIX)) {
			continue;
		}
		const path = join(directory, name);
		if (path === keep) {
			continue;
		}
		const writer = /\.tmp-(\d+)-/.exec(name);
		if (writer) {
			if (!processAlive(Number(writer[1]))) {
				rmSync(path, { force: true, recursive: true });
			}
			continue;
		}
		try {
			const used = statSync(join(path, SEQUENCE_DONE)).mtimeMs;
			finished.push({ bytes: sequenceBytes(path), path, used });
		} catch {
			// A sequence without a marker is being written by another render.
		}
	}
	let total =
		sequenceBytes(keep) +
		finished.reduce((sum, sequence) => sum + sequence.bytes, 0);
	for (const sequence of finished.sort((a, b) => a.used - b.used)) {
		if (total <= MAX_SHAPE_CACHE_BYTES) {
			break;
		}
		if (now - sequence.used < SHAPE_SEQUENCE_IN_USE_MS) {
			continue;
		}
		rmSync(sequence.path, { force: true, recursive: true });
		total -= sequence.bytes;
	}
}

/**
 * Longest frame sequence (output frames) drawn while the graph is built.
 * Single-frame renders write only the frames around their time; anything
 * longer is drawn ahead by `prepareShapeSequences`.
 */
export const MAX_INLINE_SHAPE_FRAMES = 3;
/**
 * Directory entries (frames) the shape sequences of one render may hold
 * together; repeats are hard links, which still take one entry each.
 */
export const MAX_SHAPE_RENDER_FRAMES = 432_000;
/** Drawn frames between explicit event-loop yields while preparing. */
const SHAPE_YIELD_FRAMES = 4;

const SHAPE_SEQUENCE_TOO_LARGE = `This animated shape needs more than ${MAX_SHAPE_SEQUENCE_BYTES / 1024 ** 3} GiB of frames; shorten its keyframed span or its size.`;
export const SHAPE_SEQUENCE_TIMEOUT_MESSAGE =
	"Drawing animated shapes ran past the export's time limit.";
const SHAPE_SEQUENCE_UNPREPARED =
	"Animated shapes are drawn before the export graph; this render was not given them.";

/** What one shape-keyframed graphic's sequence holds and where it lives. */
interface ShapeSequencePlan {
	/** Half side of every raster (they share one square). */
	half: number;
	/** Content name of the sequence (`shape-seq-<name>`). */
	name: string;
	samples: ShapeSample[];
	span: { from: number; to: number };
}

function shapeSequencePlan(
	graphic: Graphic,
	fps: number,
	frame: FrameSize,
	frameTime: number | undefined
): ShapeSequencePlan {
	const samples = shapeSamples(graphic, fps);
	const half = Math.max(
		1,
		...samples.map((sample) => maskedGraphicRasterHalf(sample.shape, frame))
	);
	const { first, last } = shapeFrameSpan(graphic, fps);
	const at =
		frameTime === undefined
			? undefined
			: Math.min(last, Math.max(first, Math.round(frameTime * fps)));
	const span =
		at === undefined
			? { from: first, to: last }
			: { from: Math.max(first, at - 1), to: Math.min(last, at + 1) };
	const name = createHash("sha256")
		.update(JSON.stringify([graphic, frame, fps, half, span]))
		.digest("hex")
		.slice(0, 32);
	return { half, name, samples, span };
}

/** Encode one sample's raster as a PNG on the sequence's common square. */
function drawShapeFrame(
	sample: ShapeSample,
	frame: FrameSize,
	half: number
): Uint8Array {
	const raster = maskedGraphicRaster(sample.shape, frame, sample.bake, half);
	return encodeRgbaPng(raster.pixelSize, raster.pixelSize, raster.pixels);
}

/**
 * The files of a sequence in order: `000000.png` onwards, one per output
 * frame of the span, each either a new raster (`draw`) or a repeat of the
 * previous one (`repeat`, written as a hard link).
 */
function* sequenceFrames(
	plan: ShapeSequencePlan
): Generator<{ file: string; repeat: boolean; sample: ShapeSample }> {
	let index = 0;
	let drawn = false;
	for (let frame = plan.span.from; frame <= plan.span.to; frame++) {
		// The sample showing on this frame is the last one starting at or before it.
		while (
			index + 1 < plan.samples.length &&
			(plan.samples[index + 1]?.frame ?? Number.POSITIVE_INFINITY) <= frame
		) {
			index++;
			drawn = false;
		}
		const sample = plan.samples[index];
		if (!sample) {
			throw new Error("An animated shape has no frame to draw.");
		}
		yield {
			file: `${String(frame - plan.span.from).padStart(6, "0")}.png`,
			repeat: drawn,
			sample,
		};
		drawn = true;
	}
}

const sequenceFolder = (directory: string, plan: ShapeSequencePlan) =>
	join(directory, `${SEQUENCE_PREFIX}${plan.name}`);
const sequenceWorkFolder = (directory: string, plan: ShapeSequencePlan) =>
	join(
		directory,
		`${SEQUENCE_PREFIX}${plan.name}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
	);

/**
 * Write a short sequence (at most `MAX_INLINE_SHAPE_FRAMES`, a frame
 * render's neighbourhood) synchronously while the graph is built. Built in
 * a private folder and renamed into place, so a render never reads a
 * partial one, and reused while its content matches.
 */
function writeInlineShapeSequence(
	directory: string,
	plan: ShapeSequencePlan,
	frame: FrameSize
): string {
	const target = sequenceFolder(directory, plan);
	if (existsSync(join(target, SEQUENCE_DONE))) {
		const now = new Date();
		utimesSync(join(target, SEQUENCE_DONE), now, now);
		return target;
	}
	const work = sequenceWorkFolder(directory, plan);
	mkdirSync(work, { recursive: true });
	try {
		let bytes = 0;
		let current = "";
		for (const { file, repeat, sample } of sequenceFrames(plan)) {
			const path = join(work, file);
			if (repeat) {
				linkSync(current, path);
				continue;
			}
			const png = drawShapeFrame(sample, frame, plan.half);
			bytes += png.length;
			if (bytes > MAX_SHAPE_SEQUENCE_BYTES) {
				throw new Error(SHAPE_SEQUENCE_TOO_LARGE);
			}
			writeFileSync(path, png);
			current = path;
		}
		writeFileSync(join(work, SEQUENCE_DONE), String(bytes));
		try {
			renameSync(work, target);
		} catch (error) {
			// Another render finished the same sequence first.
			if (!existsSync(join(target, SEQUENCE_DONE))) {
				throw error;
			}
			rmSync(work, { force: true, recursive: true });
		}
	} catch (error) {
		rmSync(work, { force: true, recursive: true });
		throw error;
	}
	evictShapeSequences(directory, target);
	return target;
}

/** Options of `prepareShapeSequences`. */
export interface ShapeSequenceOptions {
	/**
	 * Bytes the new sequences may write (the export's remaining work
	 * budget). Sequences already on disk and reused do not count.
	 */
	budgetBytes?: number;
	/**
	 * Where the sequences are written: an export passes its work folder so
	 * they count against its budget and are removed with it. Defaults to the
	 * process raster directory (see `GraphicsFilterOptions.rasterDirectory`).
	 */
	rasterDirectory?: string;
	/** Milliseconds left before the operation's deadline. */
	remainingMs?: () => number;
	signal?: AbortSignal;
}

/** Sequences written ahead of a render, for `GraphicsFilterOptions`. */
export interface PreparedShapeSequences {
	/** Bytes newly written (reused sequences count zero). */
	bytes: number;
	/** Sequence folders by sequence name. */
	sequences: Map<string, string>;
}

const yieldToEventLoop = () =>
	new Promise<void>((resolve) => {
		setImmediate(resolve);
	});

/**
 * Draw the whole frame sequence of every shape-keyframed graphic in
 * `project` ahead of the render graph, without blocking the event loop:
 * each frame is drawn, then written or hard-linked with awaited I/O, and
 * the loop yields every few frames so cancellation, the deadline timer and
 * progress polling keep running. Every frame checks the signal and the
 * deadline. Limits: `MAX_SHAPE_SEQUENCE_BYTES` per sequence,
 * `options.budgetBytes` across the new ones, and `MAX_SHAPE_RENDER_FRAMES`
 * directory entries across all of them.
 */
export async function prepareShapeSequences(
	project: Pick<Project, "fps" | "graphics" | "height" | "width">,
	options: ShapeSequenceOptions = {}
): Promise<PreparedShapeSequences> {
	const sequences = new Map<string, string>();
	const frame = { height: project.height, width: project.width };
	const plans = project.graphics
		.filter(
			(graphic) =>
				!usesLegacyDrawbox(graphic) && hasGraphicShapeKeyframes(graphic)
		)
		.map((graphic) =>
			shapeSequencePlan(graphic, project.fps, frame, undefined)
		);
	if (plans.length === 0) {
		return { bytes: 0, sequences };
	}
	const entries = plans.reduce(
		(sum, plan) => sum + plan.span.to - plan.span.from + 1,
		0
	);
	if (entries > MAX_SHAPE_RENDER_FRAMES) {
		throw new Error(
			`Animated shapes in this render need ${entries} frames, more than the ${MAX_SHAPE_RENDER_FRAMES} one render may write; shorten their keyframed spans.`
		);
	}
	const directory = options.rasterDirectory ?? rasterDirectory({});
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const check = () => {
		if (options.signal?.aborted) {
			throw new Error("Operation canceled.");
		}
		const remaining = options.remainingMs?.();
		if (remaining !== undefined && !(remaining > 0)) {
			throw new Error(SHAPE_SEQUENCE_TIMEOUT_MESSAGE);
		}
	};
	let written = 0;
	for (const plan of plans) {
		check();
		const target = sequenceFolder(directory, plan);
		if (sequences.has(plan.name)) {
			continue;
		}
		if (existsSync(join(target, SEQUENCE_DONE))) {
			const now = new Date();
			await utimes(join(target, SEQUENCE_DONE), now, now);
			sequences.set(plan.name, target);
			continue;
		}
		const work = sequenceWorkFolder(directory, plan);
		await mkdir(work, { recursive: true });
		try {
			let bytes = 0;
			let current = "";
			let drawn = 0;
			for (const { file, repeat, sample } of sequenceFrames(plan)) {
				check();
				const path = join(work, file);
				if (repeat) {
					await link(current, path);
					continue;
				}
				const png = drawShapeFrame(sample, frame, plan.half);
				bytes += png.length;
				if (bytes > MAX_SHAPE_SEQUENCE_BYTES) {
					throw new Error(SHAPE_SEQUENCE_TOO_LARGE);
				}
				if (
					options.budgetBytes !== undefined &&
					written + bytes > options.budgetBytes
				) {
					throw new Error(
						"Animated shape frames exceed the export's working-file budget, which free disk space also caps. Export a shorter range or a smaller output size, or free disk space."
					);
				}
				await writeFile(path, png);
				current = path;
				drawn++;
				if (drawn % SHAPE_YIELD_FRAMES === 0) {
					await yieldToEventLoop();
				}
			}
			await writeFile(join(work, SEQUENCE_DONE), String(bytes));
			try {
				await rename(work, target);
				written += bytes;
			} catch (error) {
				// Another render finished the same sequence first.
				if (!existsSync(join(target, SEQUENCE_DONE))) {
					throw error;
				}
				await rm(work, { force: true, recursive: true });
			}
		} catch (error) {
			await rm(work, { force: true, recursive: true });
			throw error;
		}
		sequences.set(plan.name, target);
	}
	if (!options.rasterDirectory) {
		for (const target of sequences.values()) {
			evictShapeSequences(directory, target);
		}
	}
	return { bytes: written, sequences };
}

/**
 * Image2 assumes 25 fps when no rate is given; `movie`'s `seek_point` is in
 * seconds on that clock, so frame k of a sequence is at k / 25 s.
 */
const IMAGE2_DEFAULT_RATE = 25;

/**
 * A shape-keyframed graphic as one stream: every output frame's raster,
 * padded to a common square around the (fixed) box center, written as a
 * PNG sequence (`prepareShapeSequences`, or inline for a frame render) and
 * read by one `movie` image2 input. Each frame is stamped at its own output
 * time, so the overlay shows the raster of exactly that frame. Rotation and
 * opacity are baked into each raster; position stays an overlay
 * expression. A chunk seeks the sequence to its window's first frame.
 */
function animatedShapeFilters(
	graphic: Graphic,
	index: number,
	project: Pick<Project, "fps">,
	frame: FrameSize,
	base: string,
	options: GraphicsFilterOptions
): OverlayChain {
	const label = (name: string) => `graphic${index}${name}`;
	const enable = `between(t,${graphic.start},${graphic.end})`;
	const fps = project.fps;
	const plan = shapeSequencePlan(graphic, fps, frame, options.frameTime);
	const { half, span } = plan;
	const { first } = shapeFrameSpan(graphic, fps);
	const prepared = options.shapeSequences?.get(plan.name);
	let sequence: string;
	if (prepared) {
		sequence = prepared;
	} else if (span.to - span.from + 1 <= MAX_INLINE_SHAPE_FRAMES) {
		sequence = writeInlineShapeSequence(rasterDirectory(options), plan, frame);
	} else {
		throw new Error(SHAPE_SEQUENCE_UNPREPARED);
	}
	// Every raster shares the half side `half` (see `graphicRaster`).
	const size = half * 2;
	const pixelSize = Math.min(size, MAX_RASTER_SIDE);
	const scale =
		pixelSize === size ? "" : `,scale=${size}:${size}:flags=bicubic`;
	const box = graphicBoxPx(graphic, frame);
	const position = rasterPosition(graphic);
	const out = `graphic${index}shape`;
	// A chunk starts reading one frame before its window.
	const skip = options.window
		? Math.min(
				span.to - span.from,
				Math.max(0, options.window.startFrame - 1 - span.from)
			)
		: 0;
	const seek =
		skip > 0 ? `:sp=${formatNumber(skip / IMAGE2_DEFAULT_RATE)}` : "";
	// Frame k of what is read is output frame `span.from + skip + k`; the
	// graphic's first frame shows from its own start.
	const rate = ffmpegFrameRate(fps);
	const from = span.from + skip;
	const stamp =
		from === first
			? `if(eq(N\\,0)\\,${formatNumber(graphic.start)}\\,(${from}+N)/(${rate}))`
			: `(${from}+N)/(${rate})`;
	return {
		filters: [
			`movie=filename=${filtergraphPath(join(sequence, "%06d.png"))}:f=image2${seek},format=rgba${scale},settb=AVTB,setpts=${stamp}/TB[${label("png")}]`,
			...compositeLayer({
				base,
				enable,
				layer: label("png"),
				out,
				s: graphic,
				x: `${frame.width}*(${position.x})+(${formatNumber(box.width / 2 - half)})`,
				y: `${frame.height}*(${position.y})+(${formatNumber(box.height / 2 - half)})`,
			}),
		],
		last: out,
	};
}

/**
 * A rasterized graphic (W2-V11), composited with `compositeLayer` so blend
 * modes apply.
 *
 * - Static rotation and opacity are baked into the PNG, which is composited
 *   straight from `rasterSource`: no per-frame work outside the window.
 * - Keyframed rotation or opacity needs a layer frame at every composite
 *   frame, so a transparent canvas follows the composite's frames (its 2x2
 *   corner, made transparent and padded: one fill per frame, so frame
 *   renders keep their timestamps). The whole branch is `yuva420p`, the
 *   composite's own format plus alpha, so nothing is converted per frame
 *   outside the window. The PNG, rotation and opacity are only applied
 *   while the graphic is enabled. Over the canvas's zero alpha, `overlay`
 *   keeps the PNG's straight colour and copies its alpha. Opacity is a cheap
 *   `lut` on the alpha plane whose factor `sendcmd` updates per frame
 *   (`opacityCommands`).
 */
function rasterGraphicFilters(
	graphic: Graphic,
	index: number,
	project: Pick<Project, "fps">,
	frame: FrameSize,
	base: string,
	options: GraphicsFilterOptions
): OverlayChain {
	if (hasGraphicShapeKeyframes(graphic)) {
		return animatedShapeFilters(graphic, index, project, frame, base, options);
	}
	const label = (name: string) => `graphic${index}${name}`;
	const enable = `between(t,${graphic.start},${graphic.end})`;
	const clock = `(t-${graphic.start})`;
	const animatedRotation = hasGraphicKeyframes(graphic, "rotation");
	const animatedOpacity = hasGraphicKeyframes(graphic, "opacity");
	const raster = rasterFile(
		graphic,
		frame,
		{
			opacity: animatedOpacity ? 1 : graphic.opacity,
			rotation: animatedRotation ? 0 : graphicRotationOf(graphic),
		},
		options
	);
	const animated = animatedRotation || animatedOpacity;
	const filters = [
		rasterSource(graphic, raster, label("png"), animated ? "yuva420p" : "rgba"),
	];
	let under = base;
	let layer = label("png");
	if (animated) {
		const opacityFilter = `lut@${label("opacity")}`;
		const opacity = animatedOpacity
			? opacityCommands(graphic, project.fps, opacityFilter)
			: undefined;
		const commands = opacity?.commands
			? `sendcmd=f=${filtergraphPath(
					writeContentFile(
						rasterDirectory(options),
						"opacity",
						"cmd",
						opacity.commands
					)
				)},`
			: "";
		filters.push(
			`[${base}]split=2[${label("under")}][${label("clock")}]`,
			`[${label("clock")}]${commands}crop=2:2:0:0,format=yuva420p,lut=a=0,pad=${raster.size}:${raster.size}:0:0:color=black@0[${label("canvas")}]`,
			`[${label("canvas")}][${layer}]overlay=x=0:y=0:format=yuv420:enable='${enable}'[${label("raster")}]`
		);
		under = label("under");
		layer = label("raster");
		if (animatedRotation) {
			const angle = graphicAnimationExpression(graphic, "rotation", clock);
			filters.push(
				`[${layer}]rotate=a='(${angle})*PI/180':c=none:ow=iw:oh=ih:enable='${enable}'[${label("rotated")}]`
			);
			layer = label("rotated");
		}
		if (opacity) {
			filters.push(
				`[${layer}]${opacityFilter}=a=${opacityExpression(opacity.initial)}:enable='${enable}'[${label("faded")}]`
			);
			layer = label("faded");
		}
	}
	const position = rasterPosition(graphic);
	const out = `graphic${index}shape`;
	filters.push(
		...compositeLayer({
			base: under,
			enable,
			layer,
			out,
			s: graphic,
			x: `${frame.width}*(${position.x})+(${formatNumber(raster.offset.x)})`,
			y: `${frame.height}*(${position.y})+(${formatNumber(raster.offset.y)})`,
		})
	);
	return { filters, last: out };
}

/**
 * Shape graphics drawn onto the composite, in start order.
 *
 * Legacy graphics (`usesLegacyDrawbox`) keep `drawbox`: rectangles are one
 * box (or a border box plus an inset fill), lines one thin box, and ellipses
 * and triangles sixteen horizontal slices. Every other graphic (polygons,
 * stars, hearts, arrows, rounded rectangles, aligned strokes, rotation,
 * keyframes or a blend mode) is rasterized (`rasterGraphicFilters`).
 */
export function graphicsFilters(
	p: Project,
	input: string,
	options: GraphicsFilterOptions = {}
): OverlayChain {
	const filters: string[] = [];
	let last = input;
	const frame = { height: p.height, width: p.width };
	for (const [index, graphic] of [...p.graphics]
		.sort((a, b) => a.start - b.start)
		.entries()) {
		if (!usesLegacyDrawbox(graphic)) {
			const chain = rasterGraphicFilters(
				graphic,
				index,
				p,
				frame,
				last,
				options
			);
			filters.push(...chain.filters);
			last = chain.last;
			continue;
		}
		const { x, y } = graphicPosition(graphic);
		const enable = `between(t,${graphic.start},${graphic.end})`;
		const fill = `${graphic.fill.replace("#", "0x")}@${graphic.opacity}`;
		const stroke = `${graphic.stroke.replace("#", "0x")}@${graphic.opacity}`;
		const drawBox = (
			boxX: string,
			boxY: string,
			boxWidth: string,
			boxHeight: string,
			color: string,
			part: string
		) => {
			const output = `graphic${index}${part}`;
			filters.push(
				`[${last}]drawbox=x='iw*(${boxX})':y='ih*(${boxY})':w='iw*${boxWidth}':h='ih*${boxHeight}':color=${color}:t=fill:enable='${enable}'[${output}]`
			);
			last = output;
		};
		if (graphic.shape === "line") {
			const thickness = Math.max(graphic.strokeWidth, 0.006);
			drawBox(
				x,
				`(${y}+${graphic.height / 2}-${thickness / 2})`,
				String(graphic.width),
				String(thickness),
				stroke,
				"line"
			);
			continue;
		}
		if (graphic.shape === "rectangle") {
			const width = String(graphic.width);
			const height = String(graphic.height);
			if (graphic.strokeWidth > 0) {
				const border = graphic.strokeWidth;
				drawBox(x, y, width, height, stroke, "border");
				drawBox(
					`(${x}+${border})`,
					`(${y}+${border})`,
					String(Math.max(0.02, graphic.width - border * 2)),
					String(Math.max(0.02, graphic.height - border * 2)),
					fill,
					"fill"
				);
			} else {
				drawBox(x, y, width, height, fill, "rect");
			}
			continue;
		}
		const slices = 16;
		for (let slice = 0; slice < slices; slice++) {
			const fraction = (slice + 0.5) / slices;
			const sliceHeight = graphic.height / slices;
			const sliceWidth =
				graphic.shape === "ellipse"
					? graphic.width * Math.sqrt(Math.max(0, 1 - (2 * fraction - 1) ** 2))
					: graphic.width * fraction;
			drawBox(
				`(${x}+(${graphic.width}-${sliceWidth})/2)`,
				`(${y}+${slice * sliceHeight})`,
				String(Math.max(0.004, sliceWidth)),
				String(sliceHeight + 0.001),
				fill,
				`${graphic.shape}${slice}`
			);
		}
	}
	return { filters, last };
}
