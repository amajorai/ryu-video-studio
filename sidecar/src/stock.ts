import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Asset, assetSchema } from "../../shared/project.ts";
import {
	type StockSearchResult,
	stockSearchResultSchema,
} from "../../shared/stock.ts";
import { importMediaAsset } from "./import-media.ts";
import { probe, thumbnail } from "./media.ts";
import type { StudioStore } from "./store.ts";

const archiveHost = "archive.org";
const coverrApiHost = "api.coverr.co";
const coverrVideoHost = "storage.coverr.co";
const openverseApiHost = "api.openverse.org";
const unsplashApiHost = "api.unsplash.com";
const unsplashImageHosts = new Set(["images.unsplash.com"]);
const commonsApiHost = "commons.wikimedia.org";
const commonsDownloadHost = "upload.wikimedia.org";
const nasaApiHost = "images-api.nasa.gov";
const nasaAssetsHost = "images-assets.nasa.gov";
const pexelsApiHost = "api.pexels.com";
const pixabayApiHost = "pixabay.com";
const pixabayVideoHosts = new Set(["cdn.pixabay.com"]);
const pexelsVideoHosts = new Set([
	"player.vimeo.com",
	"videos.pexels.com",
	"vod-adaptive.akamaized.net",
	"vod-progressive.akamaized.net",
]);
const maxStockBytes = 512 * 1024 * 1024;
const archiveSearchUrl = "https://archive.org/advancedsearch.php";
const commonsApiUrl = "https://commons.wikimedia.org/w/api.php";
const nasaSearchUrl = "https://images-api.nasa.gov/search";
const pexelsSearchUrl = "https://api.pexels.com/v1/videos/search";
const pixabaySearchUrl = "https://pixabay.com/api/videos/";
const coverrSearchUrl = "https://api.coverr.co/videos";
const openverseAudioSearchUrl = "https://api.openverse.org/v1/audio/";
const openverseImageSearchUrl = "https://api.openverse.org/v1/images/";
const unsplashImageSearchUrl = "https://api.unsplash.com/search/photos";
const openverseAudioCache = new Map<string, OpenverseAudio>();
const openverseImageCache = new Map<string, OpenverseImage>();
const unsplashImageCache = new Map<string, UnsplashImage>();
const archiveMetadataUrl = (identifier: string) =>
	`https://archive.org/metadata/${encodeURIComponent(identifier)}`;
const archivePageUrl = (identifier: string) =>
	`https://archive.org/details/${encodeURIComponent(identifier)}`;

interface ArchiveFile {
	format?: string;
	length?: string;
	name?: string;
	size?: string;
}

interface ArchiveMetadata {
	files?: ArchiveFile[];
	metadata?: {
		identifier?: string;
		title?: string;
		description?: string;
		rights?: string;
		licenseurl?: string;
		creator?: string;
		contributor?: string;
	};
}

interface CommonsMetadataValue {
	value?: string;
}

interface CommonsImageInfo {
	descriptionurl?: string;
	duration?: number;
	extmetadata?: Record<string, CommonsMetadataValue>;
	mediatype?: string;
	mime?: string;
	size?: number;
	url?: string;
}

interface CommonsPage {
	imageinfo?: CommonsImageInfo[];
	index?: number;
	title?: string;
}

interface NasaSearchItem {
	data?: Array<{
		center?: string;
		description?: string;
		media_type?: string;
		nasa_id?: string;
		title?: string;
	}>;
	href?: string;
}

interface NasaMetadata {
	"AVAIL:Center"?: string;
	"AVAIL:Creator"?: string | null;
	"AVAIL:DateCreated"?: string;
	"AVAIL:Description"?: string;
	"AVAIL:NASAID"?: string;
	"AVAIL:Title"?: string;
	"QuickTime:Duration"?: string;
}

interface PexelsVideoFile {
	file_type?: string;
	height?: number | null;
	link?: string;
	quality?: string;
	width?: number | null;
}

interface PexelsVideo {
	duration?: number;
	id?: number;
	url?: string;
	user?: { name?: string; url?: string };
	video_files?: PexelsVideoFile[];
}

interface CoverrVideo {
	description?: string;
	duration?: number;
	id?: string;
	max_height?: number;
	max_width?: number;
	title?: string;
	urls?: { mp4?: string; mp4_download?: string };
}

interface OpenverseAudio {
	creator?: string | null;
	creator_url?: string | null;
	duration?: number | null;
	filesize?: number | null;
	filetype?: string | null;
	foreign_landing_url?: string | null;
	id?: string;
	license?: string | null;
	license_url?: string | null;
	license_version?: string | null;
	provider?: string | null;
	title?: string | null;
	url?: string | null;
}

interface OpenverseImage {
	attribution?: string | null;
	creator?: string | null;
	creator_url?: string | null;
	filesize?: number | string | null;
	filetype?: string | null;
	foreign_landing_url?: string | null;
	height?: number | null;
	id?: string;
	license?: string | null;
	license_url?: string | null;
	license_version?: string | null;
	provider?: string | null;
	title?: string | null;
	url?: string | null;
	width?: number | null;
}

interface UnsplashImage {
	alt_description?: string | null;
	description?: string | null;
	height?: number;
	id?: string;
	links?: { html?: string };
	urls?: { regular?: string; small?: string };
	user?: { name?: string; links?: { html?: string } };
	width?: number;
}

interface PixabayVideoFile {
	height?: number;
	size?: number;
	url?: string;
	width?: number;
}

interface PixabayVideo {
	duration?: number;
	id?: number;
	pageURL?: string;
	user?: string;
	videos?: Record<string, PixabayVideoFile>;
}

function cleanText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanCommonsText(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const cleaned = value
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || fallback;
}

function rightsText(metadata: ArchiveMetadata["metadata"]): string {
	return cleanText(
		metadata?.rights,
		metadata?.licenseurl
			? `License information is published at ${metadata.licenseurl}. Review it before publication.`
			: "Rights information was not provided by the source. Review it before publication."
	);
}

function attributionText(metadata: ArchiveMetadata["metadata"]): string {
	const creator = cleanText(metadata?.creator, "");
	const contributor = cleanText(metadata?.contributor, "");
	return [creator, contributor, "Internet Archive"]
		.filter((value, index, values) => value && values.indexOf(value) === index)
		.join(" · ");
}

function fileScore(file: ArchiveFile): number {
	const name = file.name?.toLowerCase() ?? "";
	const format = file.format?.toLowerCase() ?? "";
	const extension = name.split(".").at(-1) ?? "";
	if (!["mp4", "webm", "ogv", "mov"].includes(extension)) {
		return -1;
	}
	const size = Number(file.size ?? 0);
	if (Number.isFinite(size) && size > maxStockBytes) {
		return -1;
	}
	return (
		(extension === "mp4" ? 50 : extension === "webm" ? 40 : 20) +
		(format.includes("h.264") || format.includes("mpeg4") ? 10 : 0) -
		(size > 0 ? Math.min(10, size / maxStockBytes) : 0)
	);
}

export function selectArchiveVideoFile(
	files: ArchiveFile[]
): ArchiveFile | null {
	return (
		files
			.map((file) => ({ file, score: fileScore(file) }))
			.filter(({ score }) => score >= 0)
			.sort((a, b) => b.score - a.score)[0]?.file ?? null
	);
}

function archiveSearchQuery(query: string): string {
	const terms = query
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}_-]+/gu)
		?.slice(0, 8);
	if (!terms?.length) {
		throw new Error("Describe the footage you want to find.");
	}
	return ["mediatype:movies", ...terms].join(" AND ");
}

async function archiveJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`Archive.org returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

async function metadataFor(identifier: string): Promise<ArchiveMetadata> {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(identifier)) {
		throw new Error("Invalid Archive.org identifier.");
	}
	return archiveJson<ArchiveMetadata>(archiveMetadataUrl(identifier));
}

function resultFor(
	metadata: ArchiveMetadata,
	file: ArchiveFile
): StockSearchResult {
	const identifier = cleanText(metadata.metadata?.identifier, "");
	const name = cleanText(file.name, "video");
	if (!identifier) {
		throw new Error("Archive.org item has no stable identifier.");
	}
	return stockSearchResultSchema.parse({
		attribution: attributionText(metadata.metadata),
		duration: Number.isFinite(Number(file.length)) ? Number(file.length) : null,
		format: cleanText(file.format, name.split(".").at(-1) ?? "video"),
		identifier,
		provider: "archive.org",
		rights: rightsText(metadata.metadata),
		sizeBytes: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
		sourceUrl: archivePageUrl(identifier),
		title: cleanText(metadata.metadata?.title, identifier),
	});
}

export async function searchArchive(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const boundedLimit = Math.max(1, Math.min(12, Math.trunc(limit)));
	const url = new URL(archiveSearchUrl);
	url.searchParams.set("q", archiveSearchQuery(query));
	url.searchParams.set("fl[]", "identifier,title,description");
	url.searchParams.append("fl[]", "creator,contributor,rights,licenseurl");
	url.searchParams.set("rows", String(boundedLimit));
	url.searchParams.set("output", "json");
	const response = (
		await archiveJson<{
			response?: { docs?: Array<{ identifier?: string }> };
		}>(url.toString())
	).response;
	const results = await Promise.all(
		(response?.docs ?? []).map(async (row) => {
			if (!row.identifier) {
				return null;
			}
			try {
				const metadata = await metadataFor(row.identifier);
				const file = selectArchiveVideoFile(metadata.files ?? []);
				return file ? resultFor(metadata, file) : null;
			} catch {
				// One unavailable Archive.org item must not hide other search results.
				return null;
			}
		})
	);
	return results.filter(
		(result): result is StockSearchResult => result !== null
	);
}

function commonsTitle(identifier: string): string {
	return identifier.replace(/^File:/i, "").trim();
}

function commonsPageUrl(identifier: string): string {
	return `https://${commonsApiHost}/wiki/${encodeURIComponent(identifier).replace(/%2F/gi, "/")}`;
}

function commonsText(
	info: CommonsImageInfo,
	key: string,
	fallback: string
): string {
	return cleanCommonsText(info.extmetadata?.[key]?.value, fallback);
}

function commonsRights(info: CommonsImageInfo): string {
	const license = commonsText(
		info,
		"LicenseShortName",
		commonsText(info, "UsageTerms", "License information was not provided.")
	);
	const licenseUrl = cleanText(info.extmetadata?.LicenseUrl?.value, "");
	return licenseUrl
		? `${license}. Review ${licenseUrl} before publication.`
		: license;
}

function commonsAttribution(info: CommonsImageInfo): string {
	const attribution = commonsText(
		info,
		"Attribution",
		commonsText(info, "Artist", commonsText(info, "Credit", ""))
	);
	return [attribution, "Wikimedia Commons"]
		.filter((value, index, values) => value && values.indexOf(value) === index)
		.join(" · ");
}

function commonsVideoScore(info: CommonsImageInfo, title: string): number {
	const mime = info.mime?.toLowerCase() ?? "";
	const extension = title.toLowerCase().split(".").at(-1) ?? "";
	if (
		info.mediatype !== "VIDEO" &&
		!mime.startsWith("video/") &&
		!["webm", "ogv", "mp4", "mov"].includes(extension)
	) {
		return -1;
	}
	if (info.size !== undefined && info.size > maxStockBytes) {
		return -1;
	}
	return (
		(extension === "mp4"
			? 50
			: extension === "webm"
				? 45
				: extension === "ogv"
					? 40
					: 25) +
		(mime.includes("webm") || mime.includes("mp4") ? 10 : 0) -
		(info.size ? Math.min(10, info.size / maxStockBytes) : 0)
	);
}

export function selectWikimediaVideoInfo(
	page: CommonsPage
): CommonsImageInfo | null {
	const title = page.title ?? "";
	return (
		page.imageinfo
			?.map((info) => ({ info, score: commonsVideoScore(info, title) }))
			.filter(({ score }) => score >= 0)
			.sort((a, b) => b.score - a.score)[0]?.info ?? null
	);
}

function resultForCommons(
	page: CommonsPage,
	info: CommonsImageInfo
): StockSearchResult {
	const identifier = cleanText(page.title, "");
	if (!(identifier && info.url)) {
		throw new Error("Wikimedia Commons item has no stable video identifier.");
	}
	const title = commonsText(info, "ObjectName", commonsTitle(identifier));
	const extension = commonsTitle(identifier).split(".").at(-1) ?? "video";
	return stockSearchResultSchema.parse({
		attribution: commonsAttribution(info) || "Wikimedia Commons",
		duration: Number.isFinite(info.duration) ? info.duration : null,
		format: cleanText(info.mime, extension),
		identifier,
		provider: "wikimedia.commons",
		rights: commonsRights(info),
		sizeBytes: Number.isFinite(info.size) ? info.size : null,
		sourceUrl: cleanText(info.descriptionurl, commonsPageUrl(identifier)),
		title,
	});
}

async function commonsJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			"user-agent": "RyuVideoStudio/0.1 (https://github.com/amajorai/ryu)",
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`Wikimedia Commons returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

function commonsSearchQuery(query: string): string {
	const terms = query
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}_-]+/gu)
		?.slice(0, 8);
	if (!terms?.length) {
		throw new Error("Describe the footage you want to find.");
	}
	return `${terms.join(" ")} filetype:video`;
}

export async function searchWikimedia(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const boundedLimit = Math.max(1, Math.min(12, Math.trunc(limit)));
	const url = new URL(commonsApiUrl);
	url.searchParams.set("action", "query");
	url.searchParams.set("format", "json");
	url.searchParams.set("generator", "search");
	url.searchParams.set("gsrnamespace", "6");
	url.searchParams.set("gsrsearch", commonsSearchQuery(query));
	url.searchParams.set("gsrlimit", String(boundedLimit));
	url.searchParams.set("prop", "imageinfo");
	url.searchParams.set("iilimit", "1");
	url.searchParams.set("iiprop", "url|size|mime|extmetadata|mediatype");
	const payload = await commonsJson<{
		query?: { pages?: Record<string, CommonsPage> };
	}>(url.toString());
	const pages = Object.values(payload.query?.pages ?? {}).sort(
		(a, b) => (a.index ?? 0) - (b.index ?? 0)
	);
	return pages.flatMap((page) => {
		const info = selectWikimediaVideoInfo(page);
		if (!info) {
			return [];
		}
		try {
			return [resultForCommons(page, info)];
		} catch {
			return [];
		}
	});
}

async function nasaJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`NASA Images returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

function validNasaIdentifier(identifier: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9 ._():,'-]{0,199}$/.test(identifier) &&
		!identifier.includes("..")
	);
}

function nasaPageUrl(identifier: string): string {
	return `https://images.nasa.gov/details/${encodeURIComponent(identifier)}`;
}

function trustedNasaAssetUrl(value: string): string | null {
	try {
		const url = new URL(value.replace(/^http:/u, "https:"));
		return url.protocol === "https:" && url.hostname === nasaAssetsHost
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function nasaVideoScore(url: string): number {
	const name = decodeURIComponent(url).toLowerCase();
	const extension = name.split("?")[0]?.split(".").at(-1) ?? "";
	if (!["mp4", "webm", "ogv", "mov"].includes(extension)) {
		return -1;
	}
	return (
		(extension === "mp4" ? 50 : extension === "webm" ? 40 : 20) +
		(name.includes("~small.") ? 30 : 0) +
		(name.includes("~medium.") ? 20 : 0) +
		(name.includes("~preview.") ? 10 : 0) -
		(name.includes("~orig.") ? 5 : 0)
	);
}

export function selectNasaVideoFile(files: string[]): string | null {
	return (
		files
			.map((file) => {
				const url = trustedNasaAssetUrl(file);
				return { file: url, score: url ? nasaVideoScore(url) : -1 };
			})
			.filter(
				(item): item is { file: string; score: number } =>
					item.file !== null && item.score >= 0
			)
			.sort((a, b) => b.score - a.score)[0]?.file ?? null
	);
}

function nasaRights(): string {
	return "NASA media is generally public domain in the United States. Check the item metadata for credited third-party material and publication restrictions before release.";
}

function nasaAttribution(metadata: NasaMetadata): string {
	return [metadata["AVAIL:Center"], metadata["AVAIL:Creator"], "NASA"]
		.filter((value, index, values) => value && values.indexOf(value) === index)
		.join(" · ");
}

function pexelsApiKey(): string {
	const key = Bun.env.RYU_VIDEO_STUDIO_PEXELS_API_KEY?.trim();
	if (!key) {
		throw new Error("Pexels is not configured on this Ryu node.");
	}
	return key;
}

function coverrApiKey(): string {
	const key = Bun.env.RYU_VIDEO_STUDIO_COVERR_API_KEY?.trim();
	if (!key) {
		throw new Error("Coverr is not configured on this Ryu node.");
	}
	return key;
}

export function trustedCoverrVideoUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			url.hostname.toLowerCase() === coverrVideoHost
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

async function coverrJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			Authorization: `Bearer ${coverrApiKey()}`,
		},
		signal: AbortSignal.timeout(15_000),
	});
	const finalHost = new URL(response.url || url).hostname.toLowerCase();
	if (finalHost !== coverrApiHost) {
		throw new Error("Coverr redirected the API request to an untrusted host.");
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error("Coverr authorization failed on this Ryu node.");
		}
		throw new Error(`Coverr returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

function resultForCoverr(video: CoverrVideo): StockSearchResult {
	const identifier = video.id?.trim();
	const download =
		trustedCoverrVideoUrl(video.urls?.mp4_download ?? "") ??
		trustedCoverrVideoUrl(video.urls?.mp4 ?? "");
	if (!(identifier && download)) {
		throw new Error("Coverr item has no trusted supported video file.");
	}
	return stockSearchResultSchema.parse({
		attribution: "Coverr",
		duration:
			typeof video.duration === "number" && Number.isFinite(video.duration)
				? video.duration
				: null,
		format: "video/mp4",
		identifier,
		provider: "coverr",
		rights:
			"Coverr API content requires Coverr attribution. Review the current Coverr license and commercial-use terms before publication.",
		sizeBytes: null,
		sourceUrl: "https://coverr.co/",
		title: cleanText(video.title, `Coverr video ${identifier}`),
	});
}

export async function searchCoverr(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const url = new URL(coverrSearchUrl);
	url.searchParams.set("query", query.trim().slice(0, 120));
	url.searchParams.set(
		"page_size",
		String(Math.max(1, Math.min(12, Math.trunc(limit))))
	);
	url.searchParams.set("urls", "true");
	const payload = await coverrJson<{ hits?: CoverrVideo[] }>(url.toString());
	return (payload.hits ?? []).flatMap((video) => {
		try {
			return [resultForCoverr(video)];
		} catch {
			return [];
		}
	});
}

async function openverseJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const finalHost = new URL(response.url || url).hostname.toLowerCase();
	if (finalHost !== openverseApiHost) {
		throw new Error(
			"Openverse redirected the API request to an untrusted host."
		);
	}
	if (!response.ok) {
		throw new Error(`Openverse returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

export function resultForOpenverseAudio(
	audio: OpenverseAudio
): StockSearchResult {
	const identifier = audio.id?.trim();
	if (!(identifier && audio.url?.startsWith("https://"))) {
		throw new Error("Openverse audio item has no trusted media URL.");
	}
	const license = [audio.license, audio.license_version]
		.filter(Boolean)
		.join(" ");
	return stockSearchResultSchema.parse({
		attribution: [audio.creator, audio.provider ?? "Openverse"]
			.filter(Boolean)
			.join(" · "),
		duration:
			typeof audio.duration === "number" && Number.isFinite(audio.duration)
				? audio.duration / 1000
				: null,
		format: audio.filetype ?? "audio",
		identifier,
		provider: "openverse.audio",
		rights: license
			? `${license}. Review the linked license before publication.`
			: "Openverse license metadata was not provided. Review the source before publication.",
		sizeBytes:
			typeof audio.filesize === "number" && Number.isFinite(audio.filesize)
				? audio.filesize
				: null,
		sourceUrl: audio.foreign_landing_url?.startsWith("https://")
			? audio.foreign_landing_url
			: "https://openverse.org/",
		title: cleanText(audio.title, `Openverse audio ${identifier}`),
	});
}

export async function searchOpenverseAudio(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const url = new URL(openverseAudioSearchUrl);
	url.searchParams.set("q", query.trim().slice(0, 120));
	const requestedLimit = Number.isFinite(limit)
		? Math.max(1, Math.min(12, Math.trunc(limit)))
		: 8;
	url.searchParams.set("page_size", String(requestedLimit));
	let payload: { results?: OpenverseAudio[] };
	try {
		payload = await openverseJson<{ results?: OpenverseAudio[] }>(
			url.toString(),
			5000
		);
	} catch (error) {
		if (requestedLimit <= 1) {
			throw error;
		}
		// Openverse's anonymous audio endpoint intermittently returns a gateway
		// error for larger page sizes. Retry with one result so a transient
		// catalog failure does not block soundtrack discovery entirely.
		url.searchParams.set("page_size", "1");
		payload = await openverseJson<{ results?: OpenverseAudio[] }>(
			url.toString()
		);
	}
	return (payload.results ?? []).flatMap((audio) => {
		try {
			const result = resultForOpenverseAudio(audio);
			openverseAudioCache.set(result.identifier, audio);
			while (openverseAudioCache.size > 64) {
				const oldest = openverseAudioCache.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				openverseAudioCache.delete(oldest);
			}
			return [result];
		} catch {
			return [];
		}
	});
}

export async function importOpenverseAudio(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	if (!/^[a-zA-Z0-9-]{8,80}$/u.test(identifier)) {
		throw new Error("Invalid Openverse audio identifier.");
	}
	let audio: OpenverseAudio;
	try {
		audio = await openverseJson<OpenverseAudio>(
			`https://${openverseApiHost}/v1/audio/${encodeURIComponent(identifier)}/`
		);
	} catch (error) {
		const cached = openverseAudioCache.get(identifier);
		if (!cached) {
			throw error;
		}
		// The search response already contains the trusted media URL. Reuse it
		// when the provider's detail endpoint is temporarily unavailable.
		audio = cached;
	}
	const result = resultForOpenverseAudio(audio);
	const asset = await importMediaAsset(store, {
		name: result.title,
		source: { url: audio.url },
	});
	const withOrigin = assetSchema.parse({
		...asset,
		origin: {
			attribution: result.attribution,
			identifier,
			licenseUrl: audio.license_url ?? undefined,
			pageUrl: result.sourceUrl,
			provider: "openverse.audio" as const,
			rights: result.rights,
		},
	});
	store.upsertAsset(withOrigin);
	return withOrigin;
}

function openverseImageUrl(image: OpenverseImage): string | null {
	try {
		const url = new URL(image.url ?? "");
		if (url.protocol !== "https:") {
			return null;
		}
		const extension = url.pathname.toLowerCase().split(".").at(-1) ?? "";
		const type = image.filetype?.toLowerCase() ?? "";
		return ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension) ||
			[
				"jpg",
				"jpeg",
				"png",
				"webp",
				"gif",
				"avif",
				"image/jpeg",
				"image/png",
				"image/webp",
			].includes(type)
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

export function resultForOpenverseImage(
	image: OpenverseImage
): StockSearchResult {
	const identifier = image.id?.trim();
	const url = openverseImageUrl(image);
	if (!(identifier && url)) {
		throw new Error("Openverse image item has no trusted image URL.");
	}
	const license = [image.license, image.license_version]
		.filter(Boolean)
		.join(" ");
	const size =
		typeof image.filesize === "number"
			? image.filesize
			: typeof image.filesize === "string"
				? Number(image.filesize)
				: Number.NaN;
	return stockSearchResultSchema.parse({
		attribution:
			image.attribution?.trim() ||
			[image.creator, image.provider ?? "Openverse"]
				.filter(Boolean)
				.join(" · ") ||
			"Openverse",
		duration: null,
		format: image.filetype ?? "image",
		identifier,
		provider: "openverse.image",
		rights: license
			? `${license}. Review the linked license before publication.`
			: "Openverse license metadata was not provided. Review the source before publication.",
		sizeBytes: Number.isSafeInteger(size) && size > 0 ? size : null,
		sourceUrl: image.foreign_landing_url?.startsWith("https:")
			? image.foreign_landing_url
			: "https://openverse.org/",
		title: cleanText(image.title, `Openverse image ${identifier}`),
	});
}

export async function searchOpenverseImages(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const url = new URL(openverseImageSearchUrl);
	url.searchParams.set("q", query.trim().slice(0, 120));
	const requestedLimit = Number.isFinite(limit)
		? Math.max(1, Math.min(12, Math.trunc(limit)))
		: 8;
	url.searchParams.set("page_size", String(requestedLimit));
	let payload: { results?: OpenverseImage[] };
	try {
		payload = await openverseJson<{ results?: OpenverseImage[] }>(
			url.toString(),
			5000
		);
	} catch (error) {
		if (requestedLimit <= 1) {
			throw error;
		}
		url.searchParams.set("page_size", "1");
		payload = await openverseJson<{ results?: OpenverseImage[] }>(
			url.toString()
		);
	}
	return (payload.results ?? []).flatMap((image) => {
		try {
			const result = resultForOpenverseImage(image);
			openverseImageCache.set(result.identifier, image);
			while (openverseImageCache.size > 64) {
				const oldest = openverseImageCache.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				openverseImageCache.delete(oldest);
			}
			return [result];
		} catch {
			return [];
		}
	});
}

export async function importOpenverseImage(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	if (!/^[a-zA-Z0-9-]{8,80}$/u.test(identifier)) {
		throw new Error("Invalid Openverse image identifier.");
	}
	let image: OpenverseImage;
	try {
		image = await openverseJson<OpenverseImage>(
			`https://${openverseApiHost}/v1/images/${encodeURIComponent(identifier)}/`
		);
	} catch (error) {
		const cached = openverseImageCache.get(identifier);
		if (!cached) {
			throw error;
		}
		image = cached;
	}
	const result = resultForOpenverseImage(image);
	const url = openverseImageUrl(image);
	if (!url) {
		throw new Error("Openverse image item has no trusted image URL.");
	}
	const asset = await importMediaAsset(store, {
		name: result.title,
		source: { url },
	});
	const withOrigin = assetSchema.parse({
		...asset,
		origin: {
			attribution: result.attribution,
			identifier,
			licenseUrl: image.license_url ?? undefined,
			pageUrl: result.sourceUrl,
			provider: "openverse.image" as const,
			rights: result.rights,
		},
	});
	store.upsertAsset(withOrigin);
	return withOrigin;
}

function unsplashAccessKey(): string {
	const key = Bun.env.RYU_VIDEO_STUDIO_UNSPLASH_ACCESS_KEY?.trim();
	if (!key) {
		throw new Error(
			"Unsplash is not configured. Set RYU_VIDEO_STUDIO_UNSPLASH_ACCESS_KEY on the video-studio node."
		);
	}
	return key;
}

export function trustedUnsplashImageUrl(
	value: string | undefined
): string | null {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" && unsplashImageHosts.has(url.hostname)
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

export function resultForUnsplashImage(
	image: UnsplashImage
): StockSearchResult {
	const identifier = image.id?.trim();
	const imageUrl = trustedUnsplashImageUrl(
		image.urls?.regular ?? image.urls?.small
	);
	if (!(identifier && imageUrl)) {
		throw new Error("Unsplash image item has no trusted image URL.");
	}
	const creator = cleanText(image.user?.name, "Unsplash photographer");
	const sourceUrl = image.links?.html?.startsWith("https:")
		? image.links.html
		: `https://${unsplashApiHost}/photos/${identifier}`;
	return stockSearchResultSchema.parse({
		attribution: `${creator} · Unsplash`,
		duration: null,
		format: "image",
		identifier,
		provider: "unsplash.image",
		rights: "Unsplash License. Review the source before publication.",
		sizeBytes: null,
		sourceUrl,
		title: cleanText(
			image.alt_description ?? image.description,
			`Unsplash photo ${identifier}`
		),
	});
}

async function unsplashJson<T>(url: string, key: string): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json", authorization: `Client-ID ${key}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`Unsplash returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

export async function searchUnsplashImages(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const key = unsplashAccessKey();
	const boundedLimit = Math.max(1, Math.min(12, Math.trunc(limit)));
	const url = new URL(unsplashImageSearchUrl);
	url.searchParams.set("query", query.trim().slice(0, 120));
	url.searchParams.set("per_page", String(boundedLimit));
	const payload = await unsplashJson<{ results?: UnsplashImage[] }>(
		url.toString(),
		key
	);
	return (payload.results ?? []).flatMap((image) => {
		try {
			const result = resultForUnsplashImage(image);
			unsplashImageCache.set(result.identifier, image);
			while (unsplashImageCache.size > 64) {
				const oldest = unsplashImageCache.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				unsplashImageCache.delete(oldest);
			}
			return [result];
		} catch {
			return [];
		}
	});
}

export async function importUnsplashImage(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	if (!/^[A-Za-z0-9_-]{3,80}$/u.test(identifier)) {
		throw new Error("Invalid Unsplash image identifier.");
	}
	const key = unsplashAccessKey();
	let image: UnsplashImage;
	try {
		image = await unsplashJson<UnsplashImage>(
			`https://${unsplashApiHost}/photos/${encodeURIComponent(identifier)}`,
			key
		);
	} catch (error) {
		const cached = unsplashImageCache.get(identifier);
		if (!cached) {
			throw error;
		}
		image = cached;
	}
	const result = resultForUnsplashImage(image);
	const url = trustedUnsplashImageUrl(image.urls?.regular ?? image.urls?.small);
	if (!url) {
		throw new Error("Unsplash image item has no trusted image URL.");
	}
	const asset = await importMediaAsset(store, {
		name: result.title,
		source: { url },
	});
	const withOrigin = assetSchema.parse({
		...asset,
		origin: {
			attribution: result.attribution,
			identifier,
			licenseUrl: "https://unsplash.com/license",
			pageUrl: result.sourceUrl,
			provider: "unsplash.image" as const,
			rights: result.rights,
		},
	});
	store.upsertAsset(withOrigin);
	return withOrigin;
}

function pexelsSearchQuery(query: string): string {
	const terms = query
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}_-]+/gu)
		?.slice(0, 8);
	if (!terms?.length) {
		throw new Error("Describe the footage you want to find.");
	}
	return terms.join(" ");
}

function trustedPexelsHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return pexelsVideoHosts.has(host);
}

export function trustedPexelsVideoUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && trustedPexelsHost(url.hostname)
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function pexelsFileScore(file: PexelsVideoFile): number {
	const url = trustedPexelsVideoUrl(file.link ?? "");
	const type = file.file_type?.toLowerCase() ?? "";
	const hls =
		file.quality?.toLowerCase() === "hls" ||
		/\.m3u8(?:$|[?#])/iu.test(url ?? "");
	if (
		!(url && !hls && (type === "video/mp4" || /\.mp4(?:$|[?#])/iu.test(url)))
	) {
		return -1;
	}
	const width = file.width ?? 0;
	const height = file.height ?? 0;
	return (
		(file.quality?.toLowerCase() === "hd" ? 40 : 20) +
		(width >= 1920 ? 30 : width >= 1280 ? 20 : width >= 640 ? 10 : 0) +
		(height >= 1080 ? 10 : height >= 720 ? 5 : 0)
	);
}

export function selectPexelsVideoFile(
	files: PexelsVideoFile[]
): PexelsVideoFile | null {
	return (
		files
			.map((file) => ({ file, score: pexelsFileScore(file) }))
			.filter(({ score }) => score >= 0)
			.sort((a, b) => b.score - a.score)[0]?.file ?? null
	);
}

async function pexelsJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			Authorization: pexelsApiKey(),
		},
		signal: AbortSignal.timeout(15_000),
	});
	const finalHost = new URL(response.url || url).hostname.toLowerCase();
	if (finalHost !== pexelsApiHost) {
		throw new Error("Pexels redirected the API request to an untrusted host.");
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error("Pexels authorization failed on this Ryu node.");
		}
		throw new Error(`Pexels returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

function pexelsPageUrl(id: number): string {
	return `https://www.pexels.com/video/${id}/`;
}

function pexelsRights(): string {
	return "Pexels content is available under the Pexels license. Review the current license and creator credit guidance before publication.";
}

function resultForPexels(video: PexelsVideo): StockSearchResult {
	const id = video.id;
	const file = selectPexelsVideoFile(video.video_files ?? []);
	if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0 && file)) {
		throw new Error("Pexels item has no stable supported video file.");
	}
	const title = cleanText(video.url, `Pexels video ${id}`)
		.split("/")
		.filter(Boolean)
		.at(-1)
		?.replace(/-/gu, " ");
	return stockSearchResultSchema.parse({
		attribution: `${cleanText(video.user?.name, "Pexels creator")} · Pexels`,
		duration:
			typeof video.duration === "number" && Number.isFinite(video.duration)
				? video.duration
				: null,
		format: cleanText(file.file_type, "video/mp4"),
		identifier: String(id),
		provider: "pexels",
		rights: pexelsRights(),
		sizeBytes: null,
		sourceUrl: pexelsPageUrl(id),
		title: title?.trim() || `Pexels video ${id}`,
	});
}

export async function searchPexels(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const boundedLimit = Math.max(1, Math.min(12, Math.trunc(limit)));
	const url = new URL(pexelsSearchUrl);
	url.searchParams.set("query", pexelsSearchQuery(query));
	url.searchParams.set("per_page", String(boundedLimit));
	const payload = await pexelsJson<{ videos?: PexelsVideo[] }>(url.toString());
	return (payload.videos ?? []).flatMap((video) => {
		try {
			return [resultForPexels(video)];
		} catch {
			return [];
		}
	});
}

function pixabayApiKey(): string {
	const key = Bun.env.RYU_VIDEO_STUDIO_PIXABAY_API_KEY?.trim();
	if (!key) {
		throw new Error("Pixabay is not configured on this Ryu node.");
	}
	return key;
}

function pixabaySearchQuery(query: string): string {
	const terms = query
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}_-]+/gu)
		?.slice(0, 8);
	if (!terms?.length) {
		throw new Error("Describe the footage you want to find.");
	}
	return terms.join(" ").slice(0, 100);
}

export function trustedPixabayVideoUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			pixabayVideoHosts.has(url.hostname.toLowerCase())
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function pixabayFileScore(
	entry: [name: string, file: PixabayVideoFile]
): number {
	const [name, file] = entry;
	const url = trustedPixabayVideoUrl(file.url ?? "");
	if (!(url && /\.mp4(?:$|[?#])/iu.test(url))) {
		return -1;
	}
	if (file.size !== undefined && file.size > maxStockBytes) {
		return -1;
	}
	const rank = { large: 40, medium: 30, small: 20, tiny: 10 }[name] ?? 0;
	return (
		rank +
		(file.width && file.width >= 1920
			? 30
			: file.width && file.width >= 1280
				? 20
				: file.width && file.width >= 640
					? 10
					: 0)
	);
}

export function selectPixabayVideoFile(
	files: Record<string, PixabayVideoFile>
): PixabayVideoFile | null {
	return (
		Object.entries(files)
			.map((entry) => ({ file: entry[1], score: pixabayFileScore(entry) }))
			.filter(({ score }) => score >= 0)
			.sort((a, b) => b.score - a.score)[0]?.file ?? null
	);
}

async function pixabayJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	const finalHost = new URL(response.url || url).hostname.toLowerCase();
	if (finalHost !== pixabayApiHost) {
		throw new Error("Pixabay redirected the API request to an untrusted host.");
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error("Pixabay authorization failed on this Ryu node.");
		}
		throw new Error(`Pixabay returned HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

function pixabayPageUrl(id: number): string {
	return `https://pixabay.com/videos/id-${id}/`;
}

function pixabayRights(): string {
	return "Pixabay content is available under the Pixabay Content License. Review the current license and creator credit guidance before publication.";
}

function resultForPixabay(video: PixabayVideo): StockSearchResult {
	const id = video.id;
	const file = selectPixabayVideoFile(video.videos ?? {});
	if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0 && file)) {
		throw new Error("Pixabay item has no stable supported video file.");
	}
	const pageUrl = video.pageURL?.startsWith("https://pixabay.com/")
		? video.pageURL
		: pixabayPageUrl(id);
	return stockSearchResultSchema.parse({
		attribution: `${cleanText(video.user, "Pixabay creator")} · Pixabay`,
		duration:
			typeof video.duration === "number" && Number.isFinite(video.duration)
				? video.duration
				: null,
		format: "video/mp4",
		identifier: String(id),
		provider: "pixabay",
		rights: pixabayRights(),
		sizeBytes: Number.isFinite(file.size) ? file.size! : null,
		sourceUrl: pageUrl,
		title: `Pixabay video ${id}`,
	});
}

export async function searchPixabay(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const boundedLimit = Math.max(3, Math.min(12, Math.trunc(limit)));
	const url = new URL(pixabaySearchUrl);
	url.searchParams.set("key", pixabayApiKey());
	url.searchParams.set("q", pixabaySearchQuery(query));
	url.searchParams.set("per_page", String(boundedLimit));
	url.searchParams.set("safesearch", "true");
	const payload = await pixabayJson<{ hits?: PixabayVideo[] }>(url.toString());
	return (payload.hits ?? []).flatMap((video) => {
		try {
			return [resultForPixabay(video)];
		} catch {
			return [];
		}
	});
}

async function nasaMetadata(identifier: string): Promise<{
	files: string[];
	metadata: NasaMetadata;
}> {
	if (!validNasaIdentifier(identifier)) {
		throw new Error("Invalid NASA media identifier.");
	}
	const collectionUrl = `https://${nasaAssetsHost}/video/${encodeURIComponent(identifier)}/collection.json`;
	const files = await nasaJson<unknown>(collectionUrl);
	if (!Array.isArray(files)) {
		throw new Error("NASA media collection returned an invalid file list.");
	}
	const safeFiles = files.filter(
		(file): file is string => typeof file === "string"
	);
	const metadataUrl = safeFiles.find((file) => file.endsWith("/metadata.json"));
	const metadata = metadataUrl
		? await nasaJson<NasaMetadata>(
				trustedNasaAssetUrl(metadataUrl) ?? metadataUrl
			)
		: {};
	return { files: safeFiles, metadata };
}

export async function searchNasa(
	query: string,
	limit = 8
): Promise<StockSearchResult[]> {
	const terms = query
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}_-]+/gu)
		?.slice(0, 8);
	if (!terms?.length) {
		throw new Error("Describe the footage you want to find.");
	}
	const boundedLimit = Math.max(1, Math.min(12, Math.trunc(limit)));
	const url = new URL(nasaSearchUrl);
	url.searchParams.set("q", terms.join(" "));
	url.searchParams.set("media_type", "video");
	url.searchParams.set("page_size", String(boundedLimit));
	const payload = await nasaJson<{
		collection?: { items?: NasaSearchItem[] };
	}>(url.toString());
	return (payload.collection?.items ?? []).flatMap((item) => {
		const data = item.data?.[0];
		const identifier = cleanText(data?.nasa_id, "");
		if (!identifier || data?.media_type !== "video") {
			return [];
		}
		return [
			stockSearchResultSchema.parse({
				attribution: [data.center, "NASA"].filter(Boolean).join(" · "),
				duration: null,
				format: "video",
				identifier,
				provider: "nasa",
				rights: nasaRights(),
				sizeBytes: null,
				sourceUrl: nasaPageUrl(identifier),
				title: cleanText(data.title, identifier),
			}),
		];
	});
}

async function commonsMetadata(identifier: string): Promise<CommonsPage> {
	if (!/^File:.{1,190}$/i.test(identifier)) {
		throw new Error("Invalid Wikimedia Commons file identifier.");
	}
	const url = new URL(commonsApiUrl);
	url.searchParams.set("action", "query");
	url.searchParams.set("format", "json");
	url.searchParams.set("titles", identifier);
	url.searchParams.set("prop", "imageinfo");
	url.searchParams.set("iilimit", "1");
	url.searchParams.set("iiprop", "url|size|mime|extmetadata|mediatype");
	const payload = await commonsJson<{
		query?: { pages?: Record<string, CommonsPage> };
	}>(url.toString());
	const page = Object.values(payload.query?.pages ?? {})[0];
	if (!page) {
		throw new Error("Wikimedia Commons file was not found.");
	}
	return page;
}

function trustedCommonsDownload(url: string): boolean {
	try {
		return new URL(url).hostname.toLowerCase() === commonsDownloadHost;
	} catch {
		return false;
	}
}

export async function importWikimediaVideo(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	const page = await commonsMetadata(identifier);
	const info = selectWikimediaVideoInfo(page);
	if (!(info?.url && trustedCommonsDownload(info.url))) {
		throw new Error(
			"Wikimedia Commons item has no trusted supported video file."
		);
	}
	if (info.size !== undefined && info.size > maxStockBytes) {
		throw new Error(
			"The selected Wikimedia Commons video exceeds the 512 MB import limit."
		);
	}
	const response = await fetch(info.url, {
		headers: { accept: "video/*,application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!(response.ok && response.body)) {
		throw new Error(
			`Wikimedia Commons video download failed with HTTP ${response.status}.`
		);
	}
	const finalHost = new URL(response.url || info.url).hostname.toLowerCase();
	if (finalHost !== commonsDownloadHost) {
		throw new Error(
			"Wikimedia Commons redirected the download to an untrusted host."
		);
	}
	const temporary = join(
		store.directory,
		"media",
		`${crypto.randomUUID()}.stock`
	);
	let bytes = 0;
	try {
		const handle = await open(temporary, "w", 0o600);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxStockBytes) {
					throw new Error(
						"The Wikimedia Commons video exceeds the 512 MB import limit."
					);
				}
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		const media = await probe(temporary);
		if (media.kind !== "video") {
			throw new Error("The Wikimedia Commons result is not a video file.");
		}
		const pageIdentifier = cleanText(page.title, identifier);
		const asset = {
			...media,
			id: crypto.randomUUID(),
			name: commonsText(info, "ObjectName", commonsTitle(pageIdentifier)).slice(
				0,
				190
			),
			createdAt: new Date().toISOString(),
			origin: {
				attribution: commonsAttribution(info) || "Wikimedia Commons",
				identifier: pageIdentifier,
				...(info.extmetadata?.LicenseUrl?.value
					? { licenseUrl: info.extmetadata.LicenseUrl.value }
					: {}),
				pageUrl: cleanText(info.descriptionurl, commonsPageUrl(pageIdentifier)),
				provider: "wikimedia.commons" as const,
				rights: commonsRights(info),
			},
		};
		await rename(temporary, store.mediaPath(asset.id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id
		);
		return asset;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function importNasaVideo(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	const { files, metadata } = await nasaMetadata(identifier);
	const url = selectNasaVideoFile(files);
	if (!url) {
		throw new Error("NASA item has no trusted supported video file.");
	}
	const response = await fetch(url, {
		headers: { accept: "video/*,application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!(response.ok && response.body)) {
		throw new Error(`NASA video download failed with HTTP ${response.status}.`);
	}
	const finalHost = new URL(response.url || url).hostname.toLowerCase();
	if (finalHost !== nasaAssetsHost) {
		throw new Error("NASA redirected the download to an untrusted host.");
	}
	const expected = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(expected) && expected > maxStockBytes) {
		throw new Error("The selected NASA video exceeds the 512 MB import limit.");
	}
	const temporary = join(
		store.directory,
		"media",
		`${crypto.randomUUID()}.stock`
	);
	let bytes = 0;
	try {
		const handle = await open(temporary, "w", 0o600);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxStockBytes) {
					throw new Error("The NASA video exceeds the 512 MB import limit.");
				}
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		const media = await probe(temporary);
		if (media.kind !== "video") {
			throw new Error("The NASA result is not a video file.");
		}
		const asset = {
			...media,
			id: crypto.randomUUID(),
			name: cleanText(metadata["AVAIL:Title"], identifier).slice(0, 190),
			createdAt: new Date().toISOString(),
			origin: {
				attribution: nasaAttribution(metadata),
				identifier,
				pageUrl: nasaPageUrl(identifier),
				provider: "nasa" as const,
				rights: nasaRights(),
			},
		};
		await rename(temporary, store.mediaPath(asset.id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id
		);
		return asset;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function archiveDownloadUrl(identifier: string, fileName: string): string {
	return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`;
}

export async function importArchiveVideo(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	const metadata = await metadataFor(identifier);
	const file = selectArchiveVideoFile(metadata.files ?? []);
	if (!file?.name) {
		throw new Error(
			"Archive.org item has no supported video file under 512 MB."
		);
	}
	const url = archiveDownloadUrl(identifier, file.name);
	const response = await fetch(url, {
		headers: { accept: "video/*,application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!(response.ok && response.body)) {
		throw new Error(
			`Archive.org video download failed with HTTP ${response.status}.`
		);
	}
	const finalHost = new URL(response.url || url).hostname.toLowerCase();
	if (finalHost !== archiveHost && !finalHost.endsWith(`.${archiveHost}`)) {
		throw new Error(
			"Archive.org redirected the download to an untrusted host."
		);
	}
	const expected = Number(file.size ?? 0);
	if (expected > maxStockBytes) {
		throw new Error(
			"The selected Archive.org video exceeds the 512 MB import limit."
		);
	}
	const temporary = join(
		store.directory,
		"media",
		`${crypto.randomUUID()}.stock`
	);
	let bytes = 0;
	try {
		const handle = await open(temporary, "w", 0o600);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxStockBytes) {
					throw new Error(
						"The Archive.org video exceeds the 512 MB import limit."
					);
				}
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		const media = await probe(temporary);
		if (media.kind !== "video") {
			throw new Error("The Archive.org result is not a video file.");
		}
		const asset = {
			...media,
			id: crypto.randomUUID(),
			name: cleanText(metadata.metadata?.title, identifier).slice(0, 190),
			createdAt: new Date().toISOString(),
			origin: {
				attribution: attributionText(metadata.metadata),
				identifier,
				...(metadata.metadata?.licenseurl
					? { licenseUrl: metadata.metadata.licenseurl }
					: {}),
				pageUrl: archivePageUrl(identifier),
				provider: "archive.org" as const,
				rights: rightsText(metadata.metadata),
			},
		};
		await rename(temporary, store.mediaPath(asset.id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id
		);
		return asset;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function downloadCoverrVideo(
	store: StudioStore,
	identifier: string,
	result: StockSearchResult,
	url: string
): Promise<Asset> {
	const trusted = trustedCoverrVideoUrl(url);
	if (!trusted) {
		throw new Error("Coverr item has no trusted supported video file.");
	}
	const response = await fetch(trusted, {
		headers: { accept: "video/mp4,application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!(response.ok && response.body)) {
		throw new Error(
			`Coverr video download failed with HTTP ${response.status}.`
		);
	}
	const finalUrl = trustedCoverrVideoUrl(response.url || trusted);
	if (!finalUrl) {
		throw new Error("Coverr redirected the download to an untrusted host.");
	}
	const expected = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(expected) && expected > maxStockBytes) {
		throw new Error("The selected Coverr video exceeds the 512 MB limit.");
	}
	const temporary = join(
		store.directory,
		"media",
		`${crypto.randomUUID()}.stock`
	);
	let bytes = 0;
	try {
		const handle = await open(temporary, "w", 0o600);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxStockBytes) {
					throw new Error("The Coverr video exceeds the 512 MB limit.");
				}
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		const media = await probe(temporary);
		if (media.kind !== "video") {
			throw new Error("The Coverr result is not a video file.");
		}
		const asset = {
			...media,
			id: crypto.randomUUID(),
			name: result.title.slice(0, 190),
			createdAt: new Date().toISOString(),
			origin: {
				attribution: result.attribution,
				identifier,
				pageUrl: result.sourceUrl,
				provider: "coverr" as const,
				rights: result.rights,
			},
		};
		await rename(temporary, store.mediaPath(asset.id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id
		);
		return asset;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function importCoverrVideo(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	if (!/^[A-Za-z0-9_-]{1,80}$/u.test(identifier)) {
		throw new Error("Invalid Coverr video identifier.");
	}
	const video = await coverrJson<CoverrVideo>(
		`https://${coverrApiHost}/videos/${encodeURIComponent(identifier)}?urls=true`
	);
	const result = resultForCoverr(video);
	const url = video.urls?.mp4_download ?? video.urls?.mp4;
	if (!url) {
		throw new Error("Coverr item has no downloadable video URL.");
	}
	return downloadCoverrVideo(store, identifier, result, url);
}

export async function importPexelsVideo(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	if (!/^\d{1,12}$/u.test(identifier)) {
		throw new Error("Invalid Pexels video identifier.");
	}
	const video = await pexelsJson<PexelsVideo>(
		`https://${pexelsApiHost}/v1/videos/videos/${identifier}`
	);
	const result = resultForPexels(video);
	const file = selectPexelsVideoFile(video.video_files ?? []);
	const url = trustedPexelsVideoUrl(file?.link ?? "");
	if (!url) {
		throw new Error("Pexels item has no trusted supported video file.");
	}
	const response = await fetch(url, {
		headers: { accept: "video/mp4,application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!(response.ok && response.body)) {
		throw new Error(
			`Pexels video download failed with HTTP ${response.status}.`
		);
	}
	const finalUrl = trustedPexelsVideoUrl(response.url || url);
	if (!finalUrl) {
		throw new Error("Pexels redirected the download to an untrusted host.");
	}
	const expected = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(expected) && expected > maxStockBytes) {
		throw new Error(
			"The selected Pexels video exceeds the 512 MB import limit."
		);
	}
	const temporary = join(
		store.directory,
		"media",
		`${crypto.randomUUID()}.stock`
	);
	let bytes = 0;
	try {
		const handle = await open(temporary, "w", 0o600);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxStockBytes) {
					throw new Error("The Pexels video exceeds the 512 MB import limit.");
				}
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		const media = await probe(temporary);
		if (media.kind !== "video") {
			throw new Error("The Pexels result is not a video file.");
		}
		const asset = {
			...media,
			id: crypto.randomUUID(),
			name: result.title.slice(0, 190),
			createdAt: new Date().toISOString(),
			origin: {
				attribution: result.attribution,
				identifier,
				pageUrl: result.sourceUrl,
				provider: "pexels" as const,
				rights: result.rights,
			},
		};
		await rename(temporary, store.mediaPath(asset.id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id
		);
		return asset;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function importPixabayVideo(
	store: StudioStore,
	identifier: string
): Promise<Asset> {
	if (!/^\d{1,12}$/u.test(identifier)) {
		throw new Error("Invalid Pixabay video identifier.");
	}
	const url = new URL(pixabaySearchUrl);
	url.searchParams.set("id", identifier);
	url.searchParams.set("key", pixabayApiKey());
	const payload = await pixabayJson<{ hits?: PixabayVideo[] }>(url.toString());
	const video = payload.hits?.find((item) => String(item.id) === identifier);
	if (!video) {
		throw new Error("Pixabay video was not found.");
	}
	const result = resultForPixabay(video);
	const file = selectPixabayVideoFile(video.videos ?? {});
	const downloadUrl = trustedPixabayVideoUrl(file?.url ?? "");
	if (!downloadUrl) {
		throw new Error("Pixabay item has no trusted supported video file.");
	}
	const response = await fetch(downloadUrl, {
		headers: { accept: "video/mp4,application/octet-stream" },
		signal: AbortSignal.timeout(120_000),
	});
	if (!(response.ok && response.body)) {
		throw new Error(
			`Pixabay video download failed with HTTP ${response.status}.`
		);
	}
	const finalUrl = trustedPixabayVideoUrl(response.url || downloadUrl);
	if (!finalUrl) {
		throw new Error("Pixabay redirected the download to an untrusted host.");
	}
	const expected = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(expected) && expected > maxStockBytes) {
		throw new Error(
			"The selected Pixabay video exceeds the 512 MB import limit."
		);
	}
	const temporary = join(
		store.directory,
		"media",
		`${crypto.randomUUID()}.stock`
	);
	let bytes = 0;
	try {
		const handle = await open(temporary, "w", 0o600);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				bytes += chunk.value.byteLength;
				if (bytes > maxStockBytes) {
					throw new Error("The Pixabay video exceeds the 512 MB import limit.");
				}
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		const media = await probe(temporary);
		if (media.kind !== "video") {
			throw new Error("The Pixabay result is not a video file.");
		}
		const asset = {
			...media,
			id: crypto.randomUUID(),
			name: result.title.slice(0, 190),
			createdAt: new Date().toISOString(),
			origin: {
				attribution: result.attribution,
				identifier,
				pageUrl: result.sourceUrl,
				provider: "pixabay" as const,
				rights: result.rights,
			},
		};
		await rename(temporary, store.mediaPath(asset.id));
		store.putAsset(asset);
		await thumbnail(
			store.mediaPath(asset.id),
			join(store.directory, "media"),
			asset.id
		);
		return asset;
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
