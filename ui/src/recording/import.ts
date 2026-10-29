import { z } from "zod";
import { type Asset, assetSchema } from "../../../shared/project.ts";
import { request, studioResponseSchema, uploadMedia } from "../bridge.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { placeRecording } from "./place.ts";

/** Library folder recordings are filed under. */
export const RECORDING_FOLDER = "Recordings";
/**
 * Request body cap of the sidecar's HTTP server (`maxRequestBodySize` in
 * `sidecar/src/server.ts`). A test keeps the two in sync.
 */
export const SIDECAR_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
/**
 * Largest recording sent inline through `/assets/import`; larger ones use
 * chunked uploads. Base64 inflates the bytes by 4/3, so 1 MiB of media is
 * about 1.4 MB of JSON, well inside the sidecar body cap with room for the
 * name, folder and MIME type.
 */
export const MAX_INLINE_RECORDING_BYTES = 1024 * 1024;

/** Body of `POST /assets/import` for an inline recording. */
export interface RecordingImportBody {
	folder: string;
	name: string;
	source: { bytes: string; mimeType: string };
	[key: string]: unknown;
}

/** Captured media: base64 bytes (host microphone) or a Blob (browser capture). */
export type RecordedMedia =
	| { base64: string; mimeType: string; name: string }
	| { blob: Blob; mimeType: string; name: string };

export interface RecordingImportDependencies {
	/**
	 * Move an uploaded asset into `folder` (chunked uploads cannot name one);
	 * resolves with the updated asset.
	 */
	fileInFolder?: (asset: Asset, folder: string) => Promise<Asset>;
	/** POST to `/assets/import`; resolves with the created asset JSON. */
	importAsset: (body: RecordingImportBody) => Promise<unknown>;
	/** Chunked upload for recordings above the inline limit. */
	upload: (file: File) => Promise<Asset>;
}

const organizeResultSchema = z.object({ asset: assetSchema });

export const defaultRecordingImport: RecordingImportDependencies = {
	fileInFolder: async (asset, folder) =>
		(
			await request(
				organizeResultSchema,
				`/assets/${encodeURIComponent(asset.id)}/organize`,
				"POST",
				{ folder }
			)
		).asset,
	importAsset: (body) =>
		request(studioResponseSchema, "/assets/import", "POST", body),
	upload: (file) => uploadMedia(file, () => undefined),
};

const DATA_URL =
	/^data:([a-z]+\/[a-zA-Z0-9.+-]+)(?:;[^,;]+=[^,;]*)*;base64,(.*)$/s;

/** Split a base64 `data:` URL into its MIME type and payload. */
export function parseMediaDataUrl(
	url: string
): { base64: string; mimeType: string } | null {
	const match = DATA_URL.exec(url);
	if (!(match?.[1] && match[2] !== undefined)) {
		return null;
	}
	const base64 = match[2].replace(/\s/g, "");
	if (!(base64 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64))) {
		return null;
	}
	return { base64, mimeType: match[1] };
}

/** Decoded byte length of a base64 payload. */
export function base64ByteLength(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

const EXTENSIONS: Readonly<Record<string, string>> = {
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
	"audio/wave": "wav",
	"audio/webm": "webm",
	"audio/x-wav": "wav",
	"video/mp4": "mp4",
	"video/webm": "webm",
};

/** File extension for a recording MIME type (codec parameters ignored). */
export function recordingExtension(mimeType: string): string {
	const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		EXTENSIONS[base] ??
		(base.startsWith("audio/")
			? "wav"
			: base.startsWith("video/")
				? "webm"
				: "bin")
	);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Library name for a recording made at `date`, e.g. "Voiceover 2026-10-14 09.05". */
export function recordingName(label: string, date: Date): string {
	return `${label} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
		date.getDate()
	)} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/**
 * Import a recording into the library's Recordings folder: inline through
 * `/assets/import` when it fits the inline limit, otherwise through chunked
 * uploads followed by a move into the folder.
 */
export async function importRecording(
	media: RecordedMedia,
	dependencies: RecordingImportDependencies = defaultRecordingImport
): Promise<Asset> {
	const mimeType = media.mimeType.split(";")[0]?.trim() || media.mimeType;
	const size =
		"blob" in media ? media.blob.size : base64ByteLength(media.base64);
	if (size <= 0) {
		throw new Error("The recording is empty. Record again.");
	}
	if (size <= MAX_INLINE_RECORDING_BYTES) {
		const bytes =
			"blob" in media
				? bytesToBase64(new Uint8Array(await media.blob.arrayBuffer()))
				: media.base64;
		return assetSchema.parse(
			await dependencies.importAsset({
				folder: RECORDING_FOLDER,
				name: media.name,
				source: { bytes, mimeType },
			})
		);
	}
	const blob =
		"blob" in media
			? media.blob
			: new Blob([base64ToBytes(media.base64)], { type: mimeType });
	const file = new File(
		[blob],
		`${media.name}.${recordingExtension(mimeType)}`,
		{ type: mimeType }
	);
	const uploaded = assetSchema.parse(await dependencies.upload(file));
	if (!dependencies.fileInFolder) {
		return uploaded;
	}
	try {
		return assetSchema.parse(
			await dependencies.fileInFolder(uploaded, RECORDING_FOLDER)
		);
	} catch {
		// The recording is already safe in the library; filing it is cosmetic.
		return uploaded;
	}
}

export type RecordingRuntime = Pick<
	EditorRuntime,
	"assets" | "edit" | "project" | "setAssets" | "setSelected"
>;

export interface PlacedRecording {
	asset: Asset;
	/** Why the clip could not be placed; the asset stays in the library. */
	placementError?: string;
	/** The new clip, or null when placement failed. */
	segmentId: string | null;
	/** Set when the clip landed on a track that cannot be heard. */
	warning?: string;
}

/**
 * Import a recording and place it at `time` (audio on a free audio track,
 * video above the picture). An import failure throws; a placement failure
 * (every track busy) is reported in `placementError`, because the recording
 * is already safe in the library by then.
 */
export async function addRecordingToTimeline(
	runtime: RecordingRuntime,
	media: RecordedMedia,
	time: number,
	dependencies: RecordingImportDependencies = defaultRecordingImport
): Promise<PlacedRecording> {
	if (!runtime.project) {
		throw new Error("Create a project before recording.");
	}
	const asset = await importRecording(media, dependencies);
	runtime.setAssets((current) => [asset, ...current]);
	let segmentId: string | null = null;
	let warning: string | undefined;
	try {
		// A placement failure throws out of the updater before any history
		// step is recorded, so a full timeline leaves the project untouched.
		runtime.edit((current) => {
			const result = placeRecording(current, runtime.assets, asset, time);
			segmentId = result.segment.id;
			warning = result.warning;
			return result.project;
		}, `Add ${asset.name}`);
	} catch (error) {
		return {
			asset,
			placementError: `${error instanceof Error ? error.message : "The clip could not be placed."} ${asset.name} is in the library under ${RECORDING_FOLDER}.`,
			segmentId: null,
		};
	}
	if (segmentId) {
		runtime.setSelected(segmentId);
	}
	return warning ? { asset, segmentId, warning } : { asset, segmentId };
}
