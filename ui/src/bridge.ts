import type { HostServices } from "@ryu/app-host/rpc";
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

declare global {
	interface Window {
		ryu?: {
			spaces?: StudioSpaces;
			app?: {
				request(input: {
					method?: string;
					path: string;
					body?: unknown;
				}): Promise<unknown>;
			};
			model?: {
				complete(input: { prompt: string; system?: string }): Promise<string>;
			};
			media?: {
				transcribe?: (input: {
					audio: string;
					filename: string;
					detailed?: boolean;
				}) => Promise<unknown>;
				tts?: (input: {
					text: string;
					request_id?: string;
					project_id?: string;
					voice?: string;
					language?: string;
					speed?: number;
				}) => Promise<unknown>;
				image?: (input: {
					prompt: string;
					count: number;
					request_id?: string;
					project_id?: string;
					provider?: string;
					model?: string;
				}) => Promise<unknown>;
				video?: (input: {
					prompt: string;
					request_id?: string;
					project_id?: string;
					provider?: string;
					model?: string;
				}) => Promise<unknown>;
			};
		};
	}
}

export async function request<T>(
	path: string,
	method = "GET",
	body?: unknown
): Promise<T> {
	if (!window.ryu?.app?.request) {
		throw new Error(
			"Open Video Studio in Ryu to connect to your project library."
		);
	}
	const result = await window.ryu.app.request({
		path,
		method,
		...(body === undefined ? {} : { body }),
	});
	if (
		result &&
		typeof result === "object" &&
		"code" in result &&
		"message" in result
	) {
		throw new Error(String(result.message));
	}
	return result as T;
}
export async function loadLibrary() {
	const [projects, assets] = await Promise.all([
		request<{ projects: unknown[] }>("/projects"),
		request<{ assets: unknown[] }>("/assets"),
	]);
	return {
		projects: projects.projects.map((p) => projectSchema.parse(p)),
		assets: assets.assets.map((a) => assetSchema.parse(a)),
	};
}
export async function uploadMedia(
	file: File,
	progress: (value: number) => void
): Promise<Asset> {
	const upload = await request<{ id: string; chunkSize: number }>(
		"/uploads",
		"POST",
		{ name: file.name, size: file.size }
	);
	for (let offset = 0; offset < file.size; offset += upload.chunkSize) {
		const bytes = new Uint8Array(
			await file.slice(offset, offset + upload.chunkSize).arrayBuffer()
		);
		let binary = "";
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		await request(`/uploads/${upload.id}`, "PUT", {
			offset,
			data: btoa(binary),
		});
		progress(Math.min(1, (offset + bytes.length) / file.size));
	}
	return assetSchema.parse(
		await request(`/uploads/${upload.id}/finish`, "POST")
	);
}
export async function mediaBlob(path: string, type: string): Promise<Blob> {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	let offset = 0;
	for (;;) {
		const chunk = await request<{ data: string; size: number; done: boolean }>(
			`${path}?offset=${offset}`
		);
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
