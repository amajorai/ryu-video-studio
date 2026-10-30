import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	LOTTIE_MAX_FRAME_BYTES,
	type LottieFramesRequest,
	type LottieFramesResponse,
	type LottieMeta,
	lottieFrameRateArgument,
} from "../../shared/lottie.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { ffmpegCapabilities } from "./ffmpeg-capabilities.ts";
import { pngDimensions } from "./matte.ts";
import { probe, runMedia, thumbnail } from "./media.ts";
import { sweepMediaLeftovers } from "./media-leftovers.ts";
import {
	acquireMediaOperation,
	type MediaOperation,
} from "./media-operation.ts";
import {
	ConflictError,
	type MediaReservation,
	type StudioStore,
} from "./store.ts";

/**
 * Lottie frame sessions and the alpha encode (G60). The editor renders the
 * animation and uploads PNG frames in ordered chunks; `finish` encodes them
 * as ProRes 4444 (`yuva444p10le`) so the alpha survives into the render,
 * plus a VP9 WebM copy with alpha (`yuva420p`) that the browser preview can
 * play. Frames live in a private work directory that is removed on finish,
 * abort or idle expiry (a per-session timer); work directories left by a
 * stopped sidecar are swept the first time the store is used again.
 */

/** Open frame sessions per library. */
export const MAX_LOTTIE_SESSIONS = 2;
/** A session with no chunk for this long is discarded. */
export const LOTTIE_SESSION_IDLE_MS = 10 * 60_000;
const ENCODE_TIMEOUT_MS = 20 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
/** Headroom for container overhead on top of the per-pixel estimate. */
const OUTPUT_OVERHEAD_BYTES = 16 * 1024 * 1024;
const FRAME_PATTERN = "frame-%05d.png";
const OUTPUT_NAME = "lottie.mov";
const PREVIEW_NAME = "lottie-preview.webm";
/** Preview keyframe interval: short GOPs keep scrubbing responsive. */
const PREVIEW_GOP = 12;

/**
 * Schedules a session's idle expiry. Production uses real, unref'd timers;
 * tests inject a manual scheduler so expiry does not race wall-clock sleeps.
 */
export interface LottieIdleScheduler {
	clear(handle: unknown): void;
	set(callback: () => void, ms: number): unknown;
}

const realIdleScheduler: LottieIdleScheduler = {
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	set: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		timer.unref?.();
		return timer;
	},
};

interface LottieSession {
	busy: boolean;
	directory: string;
	id: string;
	/** Idle time after which the session expires, in milliseconds. */
	idleMs: number;
	meta: LottieMeta;
	received: number;
	reservation: MediaReservation;
	/** Schedules the idle-expiry timer. */
	scheduler: LottieIdleScheduler;
	/** Idle-expiry timer; unref'd so it never keeps the sidecar alive. */
	timer: unknown;
	updated: number;
}

/** What `finish` produced: the alpha master and, when possible, its preview copy. */
export interface LottieFinishResult {
	/** The ProRes 4444 master the render reads (`derivation: "lottie"`). */
	asset: Asset;
	/**
	 * A VP9 WebM copy with alpha for the browser preview, stored as a
	 * `derivation: "proxy"` asset linked by `derivedFromAssetId`. Absent when
	 * this FFmpeg has no `libvpx-vp9` or the preview encode failed.
	 */
	preview?: Asset;
}

const sessionsByStore = new WeakMap<StudioStore, Map<string, LottieSession>>();

function sessionsOf(store: StudioStore): Map<string, LottieSession> {
	let sessions = sessionsByStore.get(store);
	if (!sessions) {
		sessions = new Map();
		sessionsByStore.set(store, sessions);
	}
	return sessions;
}

function frameName(index: number): string {
	return `frame-${String(index).padStart(5, "0")}.png`;
}

async function discard(
	sessions: Map<string, LottieSession>,
	session: LottieSession
): Promise<void> {
	sessions.delete(session.id);
	session.scheduler.clear(session.timer);
	session.timer = undefined;
	session.reservation.release();
	await rm(session.directory, { recursive: true, force: true });
}

/** Remove idle sessions and their frames. Returns the ids removed. */
export async function pruneLottieSessions(
	store: StudioStore,
	now = Date.now()
): Promise<string[]> {
	const sessions = sessionsOf(store);
	const expired = [...sessions.values()].filter(
		(session) => !session.busy && now - session.updated > LOTTIE_SESSION_IDLE_MS
	);
	for (const session of expired) {
		await discard(sessions, session);
	}
	return expired.map((session) => session.id);
}

/** Number of open frame sessions (for tests and diagnostics). */
export function lottieSessionCount(store: StudioStore): number {
	return sessionsOf(store).size;
}

/** Disk budget a session reserves for its PNG frames. */
export function lottieFramesBudget(meta: LottieMeta): number {
	return meta.frameCount * LOTTIE_MAX_FRAME_BYTES;
}

/** Upper bound for the encoded ProRes 4444 file, in bytes. */
export function lottieOutputBudget(
	meta: Pick<LottieMeta, "frameCount" | "height" | "width">
): number {
	return Math.min(
		MAX_OUTPUT_BYTES,
		meta.frameCount * meta.width * meta.height * 2 + OUTPUT_OVERHEAD_BYTES
	);
}

/**
 * (Re)start a session's idle timer. When it fires the session is discarded
 * unless a chunk or the encode is in progress, in which case it re-arms.
 */
function armIdleTimer(store: StudioStore, session: LottieSession): void {
	session.scheduler.clear(session.timer);
	session.timer = session.scheduler.set(() => {
		session.timer = undefined;
		const sessions = sessionsOf(store);
		if (sessions.get(session.id) !== session) {
			return;
		}
		if (session.busy) {
			armIdleTimer(store, session);
			return;
		}
		discard(sessions, session).catch(() => undefined);
	}, session.idleMs);
}

async function openSession(
	store: StudioStore,
	sessionId: string,
	meta: LottieMeta,
	now: number,
	idleMs: number,
	scheduler: LottieIdleScheduler
): Promise<LottieSession> {
	const sessions = sessionsOf(store);
	if (sessions.has(sessionId)) {
		throw new ConflictError("This Lottie import session already started.");
	}
	if (sessions.size >= MAX_LOTTIE_SESSIONS) {
		throw new Error(
			"Two Lottie imports are already running. Wait for one to finish."
		);
	}
	const reservation = store.reserveMediaStorage(lottieFramesBudget(meta));
	const session: LottieSession = {
		busy: false,
		directory: join(store.directory, "media", `.lottie-${sessionId}`),
		id: sessionId,
		idleMs,
		meta,
		received: 0,
		reservation,
		scheduler,
		timer: undefined,
		updated: now,
	};
	try {
		await mkdir(session.directory, { recursive: true, mode: 0o700 });
	} catch (error) {
		reservation.release();
		throw error;
	}
	sessions.set(sessionId, session);
	armIdleTimer(store, session);
	return session;
}

function decodeFrame(data: string, meta: LottieMeta): Buffer {
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > LOTTIE_MAX_FRAME_BYTES) {
		throw new Error("A Lottie frame is too large.");
	}
	const size = pngDimensions(bytes);
	if (!size) {
		throw new Error("Lottie frames must be PNG images.");
	}
	if (size.width !== meta.width || size.height !== meta.height) {
		throw new Error(
			`Lottie frames must be ${meta.width}x${meta.height}; got ${size.width}x${size.height}.`
		);
	}
	return bytes;
}

/**
 * Store one ordered chunk of frames. The first chunk opens the session;
 * every later chunk must start exactly at the next missing frame, so a
 * retried or reordered chunk is refused with a conflict instead of
 * corrupting the sequence.
 */
export async function appendLottieFrames(
	store: StudioStore,
	input: LottieFramesRequest,
	now = Date.now(),
	options: { idleMs?: number; scheduler?: LottieIdleScheduler } = {}
): Promise<LottieFramesResponse> {
	await sweepMediaLeftovers(store);
	await pruneLottieSessions(store, now);
	const sessions = sessionsOf(store);
	const session = input.meta
		? await openSession(
				store,
				input.sessionId,
				input.meta,
				now,
				options.idleMs ?? LOTTIE_SESSION_IDLE_MS,
				options.scheduler ?? realIdleScheduler
			)
		: sessions.get(input.sessionId);
	if (!session) {
		throw new ConflictError("The Lottie import session expired. Start again.");
	}
	if (session.busy) {
		throw new ConflictError("A Lottie frame chunk is already being stored.");
	}
	if (input.index !== session.received) {
		throw new ConflictError(
			`Expected Lottie frame ${session.received}, got ${input.index}.`
		);
	}
	if (session.received + input.frames.length > session.meta.frameCount) {
		throw new Error("More Lottie frames than the session declared.");
	}
	session.busy = true;
	try {
		const frames = input.frames.map((frame) =>
			decodeFrame(frame, session.meta)
		);
		for (const [offset, bytes] of frames.entries()) {
			await writeFile(
				join(session.directory, frameName(input.index + offset)),
				bytes,
				{ mode: 0o600 }
			);
		}
		session.received += frames.length;
		session.updated = now;
		armIdleTimer(store, session);
	} catch (error) {
		session.busy = false;
		if (input.meta) {
			await discard(sessions, session);
		}
		throw error;
	}
	session.busy = false;
	return {
		frameCount: session.meta.frameCount,
		received: session.received,
		sessionId: session.id,
	};
}

/** Cancel a session and delete its frames. Returns whether it existed. */
export async function abortLottieSession(
	store: StudioStore,
	sessionId: string
): Promise<boolean> {
	await sweepMediaLeftovers(store);
	const sessions = sessionsOf(store);
	const session = sessions.get(sessionId);
	if (!session) {
		return false;
	}
	if (session.busy) {
		throw new ConflictError("The Lottie import is busy. Try again.");
	}
	await discard(sessions, session);
	return true;
}

/** FFmpeg arguments that encode the numbered PNG frames in `cwd` to ProRes 4444 with alpha. */
export function lottieEncodeArgs(
	meta: Pick<LottieMeta, "fps" | "frameCount">
): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file",
		"-format_whitelist",
		"image2",
		"-f",
		"image2",
		"-framerate",
		lottieFrameRateArgument(meta.fps),
		"-start_number",
		"0",
		"-i",
		FRAME_PATTERN,
		"-frames:v",
		String(meta.frameCount),
		"-c:v",
		"prores_ks",
		"-profile:v",
		"4",
		"-pix_fmt",
		"yuva444p10le",
		"-alpha_bits",
		"16",
		"-vendor",
		"apl0",
		"-an",
		"-sn",
		"-dn",
		"-f",
		"mov",
		OUTPUT_NAME,
	];
}

/**
 * FFmpeg arguments that encode the numbered PNG frames in `cwd` to a VP9
 * WebM with alpha (`yuva420p`) for the browser preview. Chromium plays VP9
 * alpha natively; the render never reads this copy.
 */
export function lottiePreviewArgs(
	meta: Pick<LottieMeta, "fps" | "frameCount">
): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file",
		"-format_whitelist",
		"image2",
		"-f",
		"image2",
		"-framerate",
		lottieFrameRateArgument(meta.fps),
		"-start_number",
		"0",
		"-i",
		FRAME_PATTERN,
		"-frames:v",
		String(meta.frameCount),
		"-c:v",
		"libvpx-vp9",
		"-pix_fmt",
		"yuva420p",
		"-b:v",
		"0",
		"-crf",
		"32",
		"-deadline",
		"realtime",
		"-cpu-used",
		"8",
		"-row-mt",
		"1",
		"-auto-alt-ref",
		"0",
		"-g",
		String(PREVIEW_GOP),
		"-an",
		"-sn",
		"-dn",
		"-f",
		"webm",
		PREVIEW_NAME,
	];
}

/** Upper bound for the VP9 preview copy, in bytes. */
export function lottiePreviewBudget(
	meta: Pick<LottieMeta, "frameCount" | "height" | "width">
): number {
	return Math.min(
		MAX_OUTPUT_BYTES,
		Math.ceil((meta.frameCount * meta.width * meta.height) / 2) +
			OUTPUT_OVERHEAD_BYTES
	);
}

/**
 * Best effort: encode the browser preview copy of a finished session and
 * register it as a proxy of `master`. Any failure leaves only the master.
 */
async function encodePreview(
	store: StudioStore,
	session: LottieSession,
	master: Asset,
	operation: MediaOperation
): Promise<Asset | undefined> {
	const budget = lottiePreviewBudget(session.meta);
	const output = join(session.directory, PREVIEW_NAME);
	let reservation: MediaReservation | undefined;
	try {
		reservation = store.reserveMediaStorage(budget);
		await runMedia(lottiePreviewArgs(session.meta), {
			cwd: session.directory,
			maxOutputBytes: budget,
			outputPath: output,
			signal: operation.signal,
			timeoutMs: operation.remainingMs(),
		});
		operation.check();
		const info = await probe(output, operation.signal);
		operation.check();
		if (info.kind !== "video") {
			return;
		}
		const preview = assetSchema.parse({
			...info,
			createdAt: new Date().toISOString(),
			derivation: "proxy",
			derivedFromAssetId: master.id,
			id: crypto.randomUUID(),
			name: `${master.name} (preview)`.slice(0, 200),
		});
		await rename(output, store.mediaPath(preview.id));
		store.putAsset(preview);
		reservation.commit();
		return preview;
	} catch {
		return;
	} finally {
		reservation?.release();
	}
}

/**
 * Encode a complete session into a `derivation: "lottie"` video asset and
 * its browser preview copy. Once the media operation starts, the session is
 * consumed whether the encode succeeds or fails.
 */
export async function finishLottieSession(
	store: StudioStore,
	sessionId: string,
	options: { signal?: AbortSignal } = {}
): Promise<LottieFinishResult> {
	await sweepMediaLeftovers(store);
	const sessions = sessionsOf(store);
	const session = sessions.get(sessionId);
	if (!session) {
		throw new ConflictError("The Lottie import session expired. Start again.");
	}
	if (session.busy) {
		throw new ConflictError("The Lottie import is busy. Try again.");
	}
	if (session.received !== session.meta.frameCount) {
		throw new Error(
			`The Lottie import has ${session.received} of ${session.meta.frameCount} frames.`
		);
	}
	const capabilities = await ffmpegCapabilities();
	if (capabilities.renderer && !capabilities.encoders.prores_ks) {
		await discard(sessions, session);
		throw new Error(
			"This FFmpeg build has no ProRes encoder (prores_ks), so Lottie import is unavailable."
		);
	}
	// A busy media queue refuses here and keeps the session for a retry.
	const operation = acquireMediaOperation(ENCODE_TIMEOUT_MS, options.signal);
	session.busy = true;
	const budget = lottieOutputBudget(session.meta);
	const output = join(session.directory, OUTPUT_NAME);
	let reservation: MediaReservation | undefined;
	try {
		reservation = store.reserveMediaStorage(budget);
		await runMedia(lottieEncodeArgs(session.meta), {
			cwd: session.directory,
			maxOutputBytes: budget,
			outputPath: output,
			signal: operation.signal,
			timeoutMs: operation.remainingMs(),
		});
		operation.check();
		const info = await probe(output, operation.signal);
		operation.check();
		if (info.kind !== "video") {
			throw new Error("The Lottie encode produced no video.");
		}
		const asset = assetSchema.parse({
			...info,
			createdAt: new Date().toISOString(),
			derivation: "lottie",
			id: crypto.randomUUID(),
			name: session.meta.name,
		});
		await rename(output, store.mediaPath(asset.id));
		store.putAsset(asset);
		reservation.commit();
		const preview = capabilities.encoders["libvpx-vp9"]
			? await encodePreview(store, session, asset, operation)
			: undefined;
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id,
			operation.signal
		).catch(() => undefined);
		return preview ? { asset, preview } : { asset };
	} finally {
		reservation?.release();
		operation.release();
		session.busy = false;
		await discard(sessions, session);
	}
}
