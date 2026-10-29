/**
 * dotLottie (`.lottie`) unpacking: a ZIP holding `manifest.json`, the
 * animations (`animations/<id>.json` in v1, `a/<id>.json` in v2) and their
 * images (`images/` or `i/`). The first animation in the manifest (or the
 * first animation file) is returned as plain Lottie JSON with its images
 * inlined as data URIs, ready for the JSON importer.
 */
import { readZip } from "./zip-read.ts";

/** Largest `.lottie` file accepted. */
export const DOTLOTTIE_MAX_BYTES = 20_000_000;
/** Most files one `.lottie` archive may hold. */
const MAX_DOTLOTTIE_ENTRIES = 512;
/** Largest unpacked size of one `.lottie` archive. */
const MAX_DOTLOTTIE_UNPACKED = 60_000_000;

const IMAGE_TYPES: Record<string, string> = {
	gif: "image/gif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	webp: "image/webp",
};

/** Whether a file name looks like a dotLottie archive. */
export const isDotLottieName = (name: string) => /\.lottie$/i.test(name);

/** Whether a file name looks like Lottie JSON (`.json`, `.lottie.json`). */
export const isLottieJsonName = (name: string) => /\.json$/i.test(name);

function base64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x80_00;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

function manifestAnimationIds(files: Map<string, Uint8Array>): string[] {
	const raw = files.get("manifest.json");
	if (!raw) {
		return [];
	}
	try {
		const manifest = JSON.parse(new TextDecoder().decode(raw)) as {
			animations?: unknown;
		};
		return Array.isArray(manifest.animations)
			? manifest.animations.flatMap((entry) =>
					entry &&
					typeof entry === "object" &&
					typeof (entry as { id?: unknown }).id === "string"
						? [(entry as { id: string }).id]
						: []
				)
			: [];
	} catch {
		return [];
	}
}

const animationPaths = (id: string) => [
	`animations/${id}.json`,
	`a/${id}.json`,
];

function firstAnimationPath(files: Map<string, Uint8Array>): string {
	for (const id of manifestAnimationIds(files)) {
		const found = animationPaths(id).find((path) => files.has(path));
		if (found) {
			return found;
		}
	}
	const fallback = [...files.keys()]
		.filter((name) => /^(?:animations|a)\/[^/]+\.json$/.test(name))
		.sort()[0];
	if (!fallback) {
		throw new Error("This .lottie file holds no animation.");
	}
	return fallback;
}

/** The archive file an image asset (`u` folder + `p` file) refers to. */
function imageBytes(
	files: Map<string, Uint8Array>,
	asset: { p?: unknown; u?: unknown }
): { bytes: Uint8Array; name: string } | undefined {
	if (typeof asset.p !== "string" || asset.p.startsWith("data:")) {
		return;
	}
	const folder = typeof asset.u === "string" ? asset.u : "";
	const file = asset.p.split("/").at(-1) ?? asset.p;
	const candidates = [
		`${folder}${asset.p}`.replace(/^\/+/, ""),
		`images/${file}`,
		`i/${file}`,
	];
	for (const name of candidates) {
		const bytes = files.get(name);
		if (bytes) {
			return { bytes, name };
		}
	}
	return;
}

/**
 * Unpack a `.lottie` archive into Lottie JSON text. Image assets stored in
 * the archive become embedded data URIs (`e: 1`); an image the archive lacks
 * is left as is, and the JSON importer reports it.
 */
export async function dotLottieJson(bytes: Uint8Array): Promise<string> {
	if (bytes.byteLength > DOTLOTTIE_MAX_BYTES) {
		throw new Error(".lottie files must be 20 MB or smaller.");
	}
	const files = await readZip(bytes, {
		maxEntries: MAX_DOTLOTTIE_ENTRIES,
		maxTotalBytes: MAX_DOTLOTTIE_UNPACKED,
	});
	const path = firstAnimationPath(files);
	let animation: { assets?: unknown };
	try {
		animation = JSON.parse(new TextDecoder().decode(files.get(path)));
	} catch {
		throw new Error("The animation inside this .lottie file is not JSON.");
	}
	if (Array.isArray(animation.assets)) {
		animation.assets = animation.assets.map((asset: unknown) => {
			if (!asset || typeof asset !== "object") {
				return asset;
			}
			const image = imageBytes(files, asset as { p?: unknown; u?: unknown });
			if (!image) {
				return asset;
			}
			const extension = image.name.split(".").at(-1)?.toLowerCase() ?? "";
			const type = IMAGE_TYPES[extension] ?? "application/octet-stream";
			return {
				...asset,
				e: 1,
				p: `data:${type};base64,${base64(image.bytes)}`,
				u: "",
			};
		});
	}
	return JSON.stringify(animation);
}
