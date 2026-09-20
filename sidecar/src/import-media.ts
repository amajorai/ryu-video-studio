import { lookup } from "node:dns/promises";
import {
	copyFile,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type ImportMediaRequest,
	importMediaRequestSchema,
} from "../../shared/import-media.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { probe, thumbnail } from "./media.ts";
import type { StudioStore } from "./store.ts";

const maxUrlBytes = 1 * 1024 * 1024 * 1024;
const maxLocalBytes = 2 * 1024 * 1024 * 1024;
const maxInlineBytes = 15 * 1024 * 1024;
const maxRedirects = 3;
const maxThumbnailReservationBytes = 16 * 1024 * 1024;
const requestTimeoutMs = 120_000;

const blockedHostnames = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"host.docker.internal",
]);

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

const privateIpv6 = (host: string) => {
	const normalized = host.toLowerCase();
	if (normalized === "::" || normalized === "::1") {
		return true;
	}
	const mapped = normalized.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
	const mappedHex = normalized.match(
		/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
	);
	const mappedHexIpv4 = mappedHex
		? `${Number.parseInt(mappedHex[1] ?? "0", 16) >> 8}.${Number.parseInt(mappedHex[1] ?? "0", 16) & 255}.${Number.parseInt(mappedHex[2] ?? "0", 16) >> 8}.${Number.parseInt(mappedHex[2] ?? "0", 16) & 255}`
		: null;
	if (mapped?.[1]) {
		return privateIpv4(mapped[1]);
	}
	if (mappedHexIpv4) {
		return privateIpv4(mappedHexIpv4);
	}
	if (/^(?:fc|fd)/.test(normalized)) {
		return true;
	}
	if (/^fe[89ab]/.test(normalized) || /^(?:fec|fed|fee|fef)/.test(normalized)) {
		return true;
	}
	return (
		normalized.startsWith("64:ff9b::") || normalized.startsWith("2001:db8:")
	);
};

export function blockedAddress(address: string): boolean {
	const family = isIP(address);
	return family === 4
		? privateIpv4(address)
		: family === 6
			? privateIpv6(address)
			: true;
}

function normalizedHostname(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function safeUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "https:") {
		throw new Error("URL imports require HTTPS.");
	}
	const host = normalizedHostname(url);
	if (
		!host ||
		blockedHostnames.has(host) ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		(isIP(host) !== 0 && blockedAddress(host))
	) {
		throw new Error("URL imports cannot target private or local hosts.");
	}
	return url;
}

async function resolvePublicAddress(url: URL): Promise<string> {
	const host = normalizedHostname(url);
	if (
		blockedHostnames.has(host) ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		throw new Error("URL imports cannot target private or local hosts.");
	}
	if (isIP(host)) {
		if (blockedAddress(host)) {
			throw new Error("URL imports cannot target private or local hosts.");
		}
		return host;
	}
	const addresses = await lookup(host, { all: true, verbatim: true });
	if (
		!addresses.length ||
		addresses.some(({ address }) => blockedAddress(address))
	) {
		throw new Error("URL imports cannot target private or local hosts.");
	}
	return addresses[0]?.address ?? "";
}

function requestPinned(url: URL, address: string): Promise<IncomingMessage> {
	return new Promise((resolveResponse, reject) => {
		const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = transport(
			{
				hostname: address,
				method: "GET",
				path: `${url.pathname}${url.search}`,
				port: url.port ? Number(url.port) : 443,
				protocol: url.protocol,
				rejectUnauthorized: true,
				servername: normalizedHostname(url),
				headers: {
					Accept: "*/*",
					Host: url.host,
					"User-Agent": "RyuVideoStudio/1.0",
				},
			},
			(response) => resolveResponse(response)
		);
		request.setTimeout(requestTimeoutMs, () =>
			request.destroy(new Error("Media URL request timed out."))
		);
		request.once("error", reject);
		request.end();
	});
}

async function downloadToFile(
	url: string,
	path: string
): Promise<string | undefined> {
	let current = safeUrl(url);
	for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
		const address = await resolvePublicAddress(current);
		const response = await requestPinned(current, address);
		const status = response.statusCode ?? 0;
		if (status >= 300 && status < 400) {
			const location = response.headers.location;
			response.resume();
			if (!location || redirect === maxRedirects) {
				throw new Error("The media URL redirected too many times.");
			}
			current = safeUrl(new URL(String(location), current).toString());
			continue;
		}
		if (status < 200 || status >= 300) {
			response.resume();
			throw new Error(`Media URL returned HTTP ${status}.`);
		}
		const declared = Number(response.headers["content-length"] ?? 0);
		if (declared > maxUrlBytes) {
			response.resume();
			throw new Error("URL media exceeds the one-gigabyte import limit.");
		}
		const file = await open(path, "w");
		let total = 0;
		try {
			for await (const chunk of response) {
				const bytes = Buffer.from(chunk);
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
	destination: string,
	allowedRoot: string
): Promise<string> {
	if (!isAbsolute(source) || source.includes("\0")) {
		throw new Error("Path imports require an absolute local file path.");
	}
	const root = await realpath(resolve(allowedRoot)).catch(() => {
		throw new Error(
			"Local media imports require an existing configured import root."
		);
	});
	const sourceLink = await lstat(source);
	if (sourceLink.isSymbolicLink()) {
		throw new Error("Path imports do not accept symbolic links.");
	}
	const canonicalSource = await realpath(source).catch(() => {
		throw new Error("The local media file could not be resolved.");
	});
	const relativeSource = relative(root, canonicalSource);
	if (
		relativeSource === "" ||
		relativeSource === ".." ||
		relativeSource.startsWith(`..${sep}`) ||
		isAbsolute(relativeSource)
	) {
		throw new Error("Local media must be beneath the configured import root.");
	}
	const info = await stat(canonicalSource);
	if (!info.isFile()) {
		throw new Error("Path imports accept one local media file at a time.");
	}
	if (info.size > maxLocalBytes) {
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
	localImportRoot?: string;
	probe?: typeof probe;
	thumbnail?: typeof thumbnail;
}

function estimatedImportBytes(request: ImportMediaRequest): number {
	if (request.source.url !== undefined) {
		return maxUrlBytes;
	}
	if (request.source.path !== undefined) {
		return maxLocalBytes;
	}
	return Buffer.from(request.source.bytes ?? "", "base64").length;
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
	const reservation = store.reserveMediaStorage(
		estimatedImportBytes(request) + maxThumbnailReservationBytes
	);
	let committed = false;
	try {
		await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
		const sourceName =
			request.source.url === undefined
				? request.source.path === undefined
					? await writeInlineBytes(
							request.source.bytes ?? "",
							request.source.mimeType ?? "application/octet-stream",
							temporaryPath
						)
					: await copyPathToFile(
							request.source.path,
							temporaryPath,
							dependencies.localImportRoot ?? join(store.directory, "imports")
						)
				: await downloadToFile(request.source.url, temporaryPath);
		const sourceBytes = (await stat(temporaryPath)).size;
		reservation.resize(sourceBytes + maxThumbnailReservationBytes);
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
		reservation.commit();
		committed = true;
		return asset;
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
		if (!committed) {
			reservation.release();
		}
	}
}
