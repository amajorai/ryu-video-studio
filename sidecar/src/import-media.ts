import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { importMediaRequestSchema } from "../../shared/import-media.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { probe, thumbnail } from "./media.ts";
import type { StudioStore } from "./store.ts";

const maxUrlBytes = 1 * 1024 * 1024 * 1024;
const maxInlineBytes = 15 * 1024 * 1024;
const maxRedirects = 3;

const privateIpv4 = (host: string) => {
	const octets = host.split(".").map(Number);
	const [first, second] = octets;
	return (
		octets.length === 4 &&
		Number.isInteger(first) &&
		Number.isInteger(second) &&
		(first === 10 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			first === 127 ||
			first === 0 ||
			(first === 169 && second === 254))
	);
};

function safeUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "https:") {
		throw new Error("URL imports require HTTPS.");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		!host ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "metadata.google.internal" ||
		host === "host.docker.internal" ||
		(isIP(host) === 4 && privateIpv4(host)) ||
		(isIP(host) === 6 && (host === "::1" || host.startsWith("fe80:")))
	) {
		throw new Error("URL imports cannot target private or local hosts.");
	}
	return url;
}

async function downloadToFile(
	url: string,
	path: string
): Promise<string | undefined> {
	let current = safeUrl(url);
	for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
		const response = await fetch(current, {
			signal: AbortSignal.timeout(120_000),
			redirect: "manual",
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || redirect === maxRedirects) {
				throw new Error("The media URL redirected too many times.");
			}
			current = safeUrl(new URL(location, current).toString());
			continue;
		}
		if (!(response.ok && response.body)) {
			throw new Error(`Media URL returned HTTP ${response.status}.`);
		}
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (declared > maxUrlBytes) {
			throw new Error("URL media exceeds the one-gigabyte import limit.");
		}
		const file = await open(path, "w");
		let total = 0;
		try {
			for await (const chunk of response.body) {
				const bytes = Buffer.from(chunk as Uint8Array);
				total += bytes.length;
				if (total > maxUrlBytes) {
					throw new Error("URL media exceeds the one-gigabyte import limit.");
				}
				await file.write(bytes);
			}
		} finally {
			await file.close();
		}
		return basename(current.pathname) || undefined;
	}
	throw new Error("The media URL could not be downloaded.");
}

async function copyPathToFile(
	source: string,
	destination: string
): Promise<string> {
	if (!source.startsWith("/") || source.includes("\0")) {
		throw new Error("Path imports require an absolute local file path.");
	}
	const info = await stat(source);
	if (!info.isFile()) {
		throw new Error("Path imports accept one local media file at a time.");
	}
	if (info.size > 2 * 1024 * 1024 * 1024) {
		throw new Error("Local media exceeds the two-gigabyte import limit.");
	}
	await copyFile(source, destination);
	return basename(source);
}

async function writeInlineBytes(
	value: string,
	mimeType: string,
	destination: string
): Promise<string> {
	const bytes = Buffer.from(value, "base64");
	if (!bytes.length || bytes.length > maxInlineBytes) {
		throw new Error("Inline media exceeds the fifteen-megabyte import limit.");
	}
	await Bun.write(destination, bytes);
	const extension =
		mimeType === "video/quicktime"
			? "mov"
			: mimeType === "video/webm"
				? "webm"
				: mimeType.startsWith("audio/")
					? "wav"
					: mimeType === "image/jpeg"
						? "jpg"
						: "png";
	return `Imported asset.${extension}`;
}

export interface ImportMediaDependencies {
	probe?: typeof probe;
	thumbnail?: typeof thumbnail;
}

/** Import one local/HTTPS/inline media source into app-owned storage. */
export async function importMediaAsset(
	store: StudioStore,
	input: unknown,
	dependencies: ImportMediaDependencies = {}
): Promise<Asset> {
	const request = importMediaRequestSchema.parse(input);
	const id = crypto.randomUUID();
	const temporaryDirectory = join(store.directory, "media", `.import-${id}`);
	const temporaryPath = join(temporaryDirectory, "source");
	await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
	try {
		const sourceName =
			request.source.url === undefined
				? request.source.path === undefined
					? await writeInlineBytes(
							request.source.bytes ?? "",
							request.source.mimeType ?? "application/octet-stream",
							temporaryPath
						)
					: await copyPathToFile(request.source.path, temporaryPath)
				: await downloadToFile(request.source.url, temporaryPath);
		const inspect = dependencies.probe ?? probe;
		const info = await inspect(temporaryPath);
		const asset = assetSchema.parse({
			...info,
			...(request.folder === undefined ? {} : { folder: request.folder }),
			createdAt: new Date().toISOString(),
			id,
			name: request.name ?? sourceName ?? "Imported asset",
		});
		await rename(temporaryPath, store.mediaPath(asset.id));
		store.putAsset(asset);
		if (asset.kind !== "audio") {
			await (dependencies.thumbnail ?? thumbnail)(
				store.mediaPath(asset.id),
				join(store.directory, "media"),
				asset.id
			).catch(() => undefined);
		}
		return asset;
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}
