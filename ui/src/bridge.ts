import type { HostServices } from "@ryu/app-host/rpc";
import { z } from "zod";
export interface StudioSpaces {
	createDoc: NonNullable<HostServices["spacesCreateDoc"]>;
	deleteDoc: NonNullable<HostServices["spacesDeleteDoc"]>;
	ensureSpace: NonNullable<HostServices["spacesEnsureSpace"]>;
	getDoc: NonNullable<HostServices["spacesGetDoc"]>;
	search: NonNullable<HostServices["spacesSearch"]>;
	updateDoc: NonNullable<HostServices["spacesUpdateDoc"]>;
}

import {
	type Asset,
	assetSchema,
	projectSchema,
} from "../../shared/project.ts";

type StudioImageInput = Parameters<
	NonNullable<HostServices["generateImage"]>
>[0] & { project_id?: string };
type StudioVideoInput = Parameters<
	NonNullable<HostServices["generateVideo"]>
>[0] & { project_id?: string };
/** `media.audio` input: music or a sound effect from a cloud model. */
export type StudioAudioInput = Parameters<
	NonNullable<HostServices["generateAudio"]>
>[0] & { project_id?: string };
/** Generation-bridge features the host reports through `host.capabilities`. */
export interface StudioBridgeFeatures {
	"media.audio": boolean;
	"media.video.inputs": boolean;
	"model.vision": boolean;
}
/** One `social.request` call onto Outpost's `/api/social` mount. */
export interface StudioSocialRequest {
	body?: StudioRequestBody;
	method?: "DELETE" | "GET" | "PATCH" | "POST";
	path: string;
}
/**
 * Transcription input plus the optional language hint. `auto` is sent as is:
 * it asks the engine to detect the language and overrides a language saved in
 * the engine's transcription settings. Hosts that predate the hint ignore the
 * extra field.
 */
export type StudioTranscribeInput = Parameters<
	NonNullable<HostServices["transcribeAudio"]>
>[0] & { language?: string };
type StudioRequestMethod = NonNullable<
	Parameters<NonNullable<HostServices["appRequest"]>>[0]["method"]
>;

declare global {
	interface Window {
		ryu?: {
			spaces?: StudioSpaces;
			app?: { request: NonNullable<HostServices["appRequest"]> };
			model?: {
				complete(input: {
					prompt: string;
					system?: string;
					/** At most 8 `data:image/{png,jpeg,webp}` URIs, 1.5 MiB in total. */
					images?: string[];
					provider?: string;
					model?: string;
				}): Promise<string>;
			};
			/** Host feature inventory; `bridge` flags generation inputs it forwards. */
			host?: {
				capabilities?: () => Promise<{
					bridge?: Partial<StudioBridgeFeatures>;
				}>;
			};
			/** Outpost (grant `social:crud`, optional). */
			social?: {
				request: (input: StudioSocialRequest) => Promise<unknown>;
				open: (input: { postId?: string; title?: string }) => Promise<unknown>;
			};
			/** The secret-free provider/model catalog (grant `core:list_agents`). */
			catalog?: {
				models(input: { providerId: string }): Promise<unknown>;
				snapshot(): Promise<unknown>;
			};
			media?: {
				transcribe?: (
					input: StudioTranscribeInput
				) => ReturnType<NonNullable<HostServices["transcribeAudio"]>>;
				tts?: NonNullable<HostServices["ttsSpeak"]>;
				/** Installed speech engines and their voices (grant `media:generate`). */
				ttsEngines?: () => Promise<unknown>;
				image?: (
					input: StudioImageInput
				) => ReturnType<NonNullable<HostServices["generateImage"]>>;
				video?: (
					input: StudioVideoInput
				) => ReturnType<NonNullable<HostServices["generateVideo"]>>;
				/** Music and sound effects (grant `media:generate`). */
				audio?: (
					input: StudioAudioInput
				) => ReturnType<NonNullable<HostServices["generateAudio"]>>;
			};
		};
	}
}

/** Transcription request for one audio window, with the language hint when set. */
export function transcribeInput(
	audio: string,
	language: string | undefined
): StudioTranscribeInput {
	const input: StudioTranscribeInput = {
		audio,
		detailed: true,
		filename: "source-window.wav",
	};
	if (language) {
		input.language = language;
	}
	return input;
}

export const studioResponseSchema = z.json().optional();
export type StudioResponse = z.infer<typeof studioResponseSchema>;
export type StudioRequestBody = Parameters<typeof JSON.stringify>[0];
const studioErrorSchema = z.object({
	code: z.json(),
	message: z.json(),
	messageCode: z.string().max(80).optional().catch(undefined),
	params: z
		.record(z.string(), z.union([z.string().max(2000), z.number()]))
		.optional()
		.catch(undefined),
});

/** A sidecar error response; `code` is `"CONFLICT"` for a stale project revision. */
export class StudioRequestError extends Error {
	readonly code: string;
	/**
	 * For errors that name a clip, track or scene: the message's catalog code
	 * and its values, so the editor can show it in the host language.
	 */
	readonly messageCode: string | undefined;
	readonly params: Readonly<Record<string, string | number>>;
	constructor(
		message: string,
		code: string,
		detail: {
			messageCode?: string | undefined;
			params?: Record<string, string | number> | undefined;
		} = {}
	) {
		super(message);
		this.name = "StudioRequestError";
		this.code = code;
		this.messageCode = detail.messageCode;
		this.params = detail.params ?? {};
	}
}

/** True when the sidecar refused an edit because the project revision changed. */
export function isRevisionConflict(error: unknown): boolean {
	return error instanceof StudioRequestError && error.code === "CONFLICT";
}

export async function request<T>(
	responseSchema: z.ZodType<T>,
	path: string,
	method: StudioRequestMethod = "GET",
	body?: StudioRequestBody
): Promise<T> {
	if (!window.ryu?.app?.request) {
		throw new Error(
			"Open Video Studio in Ryu to connect to your project library."
		);
	}
	const input: Parameters<NonNullable<HostServices["appRequest"]>>[0] = {
		path,
		method,
	};
	if (body !== undefined) {
		input.body = body;
	}
	const result = await window.ryu.app.request(input);
	const error = studioErrorSchema.safeParse(result);
	if (error.success) {
		throw new StudioRequestError(
			String(error.data.message),
			String(error.data.code),
			{ messageCode: error.data.messageCode, params: error.data.params }
		);
	}
	return responseSchema.parse(result);
}
export async function loadLibrary() {
	const [projects, assets] = await Promise.all([
		request(z.object({ projects: z.array(z.json()) }), "/projects"),
		request(z.object({ assets: z.array(z.json()) }), "/assets"),
	]);
	return {
		projects: projects.projects.map((p) => projectSchema.parse(p)),
		assets: assets.assets.map((a) => assetSchema.parse(a)),
	};
}
/** The media library; with `includeProxies`, preview proxies are listed too. */
export async function loadAssets(includeProxies = false): Promise<Asset[]> {
	const result = await request(
		z.object({ assets: z.array(z.json()) }),
		includeProxies ? "/assets?includeProxies=1" : "/assets"
	);
	return result.assets.map((asset) => assetSchema.parse(asset));
}
/**
 * Send `file` to a new upload session in 512 KiB chunks and return the
 * session id, ready to finish (as media) or to hand to a route that stores
 * the bytes itself (a font import).
 */
/**
 * Upload `file` through a chunked upload session; resolves its id. `font`
 * uploads are claimed by `POST /fonts` and do not count toward the media
 * asset limit.
 */
export async function uploadChunks(
	file: File,
	progress: (value: number) => void,
	purpose: "font" | "media" = "media"
): Promise<string> {
	const upload = await request(
		z.object({ id: z.string(), chunkSize: z.number() }),
		"/uploads",
		"POST",
		{ name: file.name, purpose, size: file.size }
	);
	try {
		for (let offset = 0; offset < file.size; offset += upload.chunkSize) {
			const bytes = new Uint8Array(
				await file.slice(offset, offset + upload.chunkSize).arrayBuffer()
			);
			let binary = "";
			for (const byte of bytes) {
				binary += String.fromCharCode(byte);
			}
			await request(studioResponseSchema, `/uploads/${upload.id}`, "PUT", {
				offset,
				data: btoa(binary),
			});
			progress(Math.min(1, (offset + bytes.length) / file.size));
		}
	} catch (error) {
		await cancelUpload(upload.id);
		throw error;
	}
	return upload.id;
}
/** Release an unfinished upload's server-side slot and quota now instead of after the idle sweep. */
export async function cancelUpload(id: string): Promise<void> {
	await request(studioResponseSchema, `/uploads/${id}/cancel`, "POST").catch(
		() => undefined
	);
}
export async function uploadMedia(
	file: File,
	progress: (value: number) => void
): Promise<Asset> {
	const id = await uploadChunks(file, progress);
	try {
		return assetSchema.parse(
			await request(studioResponseSchema, `/uploads/${id}/finish`, "POST")
		);
	} catch (error) {
		await cancelUpload(id);
		throw error;
	}
}
export async function mediaBlob(
	path: string,
	type: string,
	signal?: AbortSignal
): Promise<Blob> {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	let offset = 0;
	for (;;) {
		signal?.throwIfAborted();
		const chunk = await request(
			z.object({ data: z.string(), size: z.number(), done: z.boolean() }),
			`${path}${path.includes("?") ? "&" : "?"}offset=${offset}`
		);
		signal?.throwIfAborted();
		const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
		parts.push(bytes);
		offset += bytes.length;
		if (chunk.done) {
			break;
		}
		if (!bytes.length || offset > 2 * 1024 * 1024 * 1024) {
			throw new Error("Invalid media stream.");
		}
	}
	return new Blob(parts, { type });
}
export function download(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function mediaDataUrlBlob(url: string): Blob {
	const match = url.match(
		/^data:((?:audio|video|image)\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/
	);
	if (!match?.[1] || match[2] === undefined) {
		throw new Error("Invalid media data URL.");
	}
	const bytes = Uint8Array.from(atob(match[2]), (character) =>
		character.charCodeAt(0)
	);
	return new Blob([bytes], { type: match[1] });
}
