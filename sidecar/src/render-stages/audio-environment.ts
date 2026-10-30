/**
 * What the clip audio stages need from the machine: whether optional FFmpeg
 * filters exist and where the bundled RNNoise model lives on disk. Both are
 * resolved lazily, once, and only when a clip actually needs them, so clips
 * without isolation or pitch effects never probe FFmpeg.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeFilterPath } from "../../../shared/audio.ts";
import bundledModel from "../../assets/rnnoise/somnolent-hogwash.rnnn" with {
	type: "file",
};
import { parseFfmpegFilters } from "../ffmpeg-capabilities.ts";
import { mediaBinary } from "../media.ts";

export type OptionalAudioFilter = "arnndn" | "rubberband";

export interface AudioRenderEnvironment {
	hasFilter(name: OptionalAudioFilter): boolean;
	/** Filter-escaped path of the RNNoise model, or null when unavailable. */
	rnnoiseModel(): string | null;
}

/** A fixed environment, for tests and verification scripts. */
export function staticAudioEnvironment(
	filters: Partial<Record<OptionalAudioFilter, boolean>>,
	modelPath: string | null = "/models/rnnoise.rnnn"
): AudioRenderEnvironment {
	return {
		hasFilter: (name) => filters[name] ?? false,
		rnnoiseModel: () => (modelPath ? escapeFilterPath(modelPath) : null),
	};
}

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/**
 * Refuse a cache directory another user could tamper with: it must be a real
 * directory (not a symlink), owned by this process's user, and closed to group
 * and others. Created 0700 when missing.
 */
export function assertPrivateDirectory(directory: string): void {
	if (!existsSync(directory)) {
		mkdirSync(directory, { mode: 0o700, recursive: true });
	}
	const stats = lstatSync(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Model cache ${directory} is not a plain directory.`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`Model cache ${directory} is owned by another user.`);
	}
	// POSIX permission bits; Windows reports no group/other bits to check.
	if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
		throw new Error(`Model cache ${directory} is accessible to other users.`);
	}
}

/** True when `path` is a regular file (not a symlink) holding exactly `digest`. */
function holdsDigest(path: string, digest: string): boolean {
	try {
		const stats = lstatSync(path);
		return stats.isFile() && sha256(readFileSync(path)) === digest;
	} catch {
		return false;
	}
}

let processCacheDirectory: string | undefined;

/** A fresh 0700 directory unique to this process (created once, lazily). */
function privateCacheDirectory(): string {
	processCacheDirectory ??= mkdtempSync(
		join(tmpdir(), "ryu-video-studio-rnnoise-")
	);
	return processCacheDirectory;
}

/**
 * Inside a compiled sidecar the embedded model lives on Bun's virtual file
 * system, which FFmpeg cannot open, so it is copied out first: into a private
 * per-process directory by default, or into `directory` once that is verified
 * private to this user. An existing copy is reused only when its bytes hash to
 * the embedded model; otherwise it is replaced atomically (unique temp name,
 * then rename), so a partial or planted file is never handed to FFmpeg.
 */
export function materializeModel(
	embeddedPath: string,
	directory?: string
): string {
	const virtual =
		embeddedPath.includes("$bunfs") || embeddedPath.includes("~BUN");
	if (!virtual && existsSync(embeddedPath)) {
		return embeddedPath;
	}
	const bytes = readFileSync(embeddedPath);
	const digest = sha256(bytes);
	const cache = directory ?? privateCacheDirectory();
	assertPrivateDirectory(cache);
	const target = join(cache, `voice-isolation-${digest.slice(0, 16)}.rnnn`);
	if (holdsDigest(target, digest)) {
		return target;
	}
	const staging = join(
		cache,
		`.voice-isolation-${process.pid}-${randomUUID()}.tmp`
	);
	try {
		writeFileSync(staging, bytes, { flag: "wx", mode: 0o600 });
		renameSync(staging, target);
	} finally {
		rmSync(staging, { force: true });
	}
	if (!holdsDigest(target, digest)) {
		throw new Error("The voice isolation model could not be written intact.");
	}
	return target;
}

function probeFilters(): ReadonlySet<string> {
	try {
		const result = Bun.spawnSync(
			[mediaBinary("ffmpeg"), "-hide_banner", "-filters"],
			{
				stderr: "ignore",
				stdout: "pipe",
			}
		);
		return result.success
			? parseFfmpegFilters(result.stdout.toString())
			: new Set();
	} catch {
		return new Set();
	}
}

let voiceModel: string | null | undefined;

/**
 * Plain (unescaped) path of the bundled RNNoise model, extracted from the
 * compiled binary on first use; null when it cannot be materialized.
 */
export function bundledVoiceModelPath(): string | null {
	if (voiceModel === undefined) {
		try {
			voiceModel = materializeModel(bundledModel);
		} catch {
			voiceModel = null;
		}
	}
	return voiceModel;
}

/** The process environment: probes FFmpeg once and extracts the model once. */
export function processAudioEnvironment(): AudioRenderEnvironment {
	let filters: ReadonlySet<string> | undefined;
	let model: string | null | undefined;
	return {
		hasFilter(name) {
			filters ??= probeFilters();
			return filters.has(name);
		},
		rnnoiseModel() {
			if (model === undefined) {
				const path = bundledVoiceModelPath();
				model = path ? escapeFilterPath(path) : null;
			}
			return model;
		},
	};
}

let current: AudioRenderEnvironment | undefined;

/** The environment the audio stages read by default. */
export function audioEnvironment(): AudioRenderEnvironment {
	current ??= processAudioEnvironment();
	return current;
}
