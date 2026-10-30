/**
 * Sidecar LUT routes (W2-V5) for the inspector and the looks panel:
 * `GET/POST/DELETE /luts`, plus the preview LUT cache and the `lut3d`
 * capability check.
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import {
	type CubeLut,
	CubeLutError,
	MAX_LUT_REQUEST_BYTES,
	parseCubeLut,
} from "../../../shared/cube-lut.ts";
import {
	type LutRecord,
	lutRecordSchema,
} from "../../../shared/schema/color.ts";
import { request } from "../bridge.ts";
import { hasPreviewLut, setPreviewLut } from "../preview/gl/passes/grade.ts";

const listSchema = z.object({ luts: z.array(lutRecordSchema) });
const readSchema = z.object({ cube: z.string(), lut: lutRecordSchema });
const deletedSchema = z.object({ deleted: z.string() });
const capabilitiesSchema = z.object({
	filters: z.record(z.string(), z.boolean()),
});

export function listLuts(): Promise<LutRecord[]> {
	return request(listSchema, "/luts").then((result) => result.luts);
}

export async function readLut(id: string): Promise<CubeLut> {
	const result = await request(
		readSchema,
		`/luts?id=${encodeURIComponent(id)}`
	);
	return parseCubeLut(result.cube);
}

/**
 * The JSON body of a LUT import, or a clear error when it exceeds the
 * sidecar's request limit (most 65-point LUTs do; 33-point LUTs fit).
 */
export function lutImportBody(
	name: string,
	cube: string
): { cube: string; name: string } {
	const body = { cube, name };
	const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
	if (bytes > MAX_LUT_REQUEST_BYTES) {
		const size = /^LUT_3D_SIZE\s+(\d+)/m.exec(cube)?.[1];
		const megabytes = (value: number) => (value / 1024 / 1024).toFixed(1);
		throw new CubeLutError(
			`This LUT${size ? ` (${size}-point)` : ""} is ${megabytes(bytes)} MB once validated; imports are limited to ${megabytes(MAX_LUT_REQUEST_BYTES)} MB. Export it at 33 points (or smaller) and import it again.`
		);
	}
	return body;
}

/** Import `.cube` text; the sidecar validates it again before storing. */
export function importLut(name: string, cube: string): Promise<LutRecord> {
	return request(lutRecordSchema, "/luts", "POST", lutImportBody(name, cube));
}

export async function deleteLut(id: string): Promise<void> {
	await request(deletedSchema, `/luts?id=${encodeURIComponent(id)}`, "DELETE");
}

/**
 * Load a LUT into the preview cache once. Resolves true when it was newly
 * loaded (the caller should trigger a preview redraw).
 */
const loading = new Map<string, Promise<boolean>>();

export function ensurePreviewLut(
	id: string,
	read: (lutId: string) => Promise<CubeLut> = readLut
): Promise<boolean> {
	if (hasPreviewLut(id)) {
		return Promise.resolve(false);
	}
	// Many layers can reference one LUT: share a single request.
	let pending = loading.get(id);
	if (!pending) {
		pending = read(id)
			.then((lut) => {
				const fresh = !hasPreviewLut(id);
				setPreviewLut(id, lut);
				return fresh;
			})
			.finally(() => loading.delete(id));
		loading.set(id, pending);
	}
	return pending;
}

/**
 * Load a clip's LUT into the preview whenever the clip references one (after
 * a reload, an agent edit or a paste, not only when the inspector shows it).
 * Returns how many LUTs this layer has loaded, so the caller re-renders and
 * redraws its grade pass once the table arrives.
 */
export function usePreviewLut(
	lutId: string | undefined,
	read: (lutId: string) => Promise<CubeLut> = readLut
): number {
	const [loaded, setLoaded] = useState(0);
	const [reader] = useState(() => read);
	useEffect(() => {
		if (!lutId || hasPreviewLut(lutId)) {
			return;
		}
		let mounted = true;
		ensurePreviewLut(lutId, reader)
			.then(() => {
				if (mounted) {
					setLoaded((count) => count + 1);
				}
			})
			.catch(() => undefined);
		return () => {
			mounted = false;
		};
	}, [lutId, reader]);
	return loaded;
}

/**
 * Why LUTs cannot render on this node, or null when they can (or while the
 * capabilities are unknown).
 */
export function lutUnavailableReason(capabilities: unknown): string | null {
	const parsed = capabilitiesSchema.safeParse(capabilities);
	if (parsed.success && parsed.data.filters.lut3d === false) {
		return "This FFmpeg build has no lut3d filter, so LUTs cannot render.";
	}
	return null;
}

/** `lutUnavailableReason` for `GET /capabilities`, read once on mount. */
export function useLutUnavailableReason(
	api: ((path: string) => Promise<unknown>) | undefined
): string | null {
	const [reason, setReason] = useState<string | null>(null);
	const [read] = useState(() => api);
	useEffect(() => {
		if (typeof read !== "function") {
			// No sidecar bridge (detached previews and tests): nothing to check.
			return;
		}
		let mounted = true;
		read("/capabilities")
			.then((value) => {
				if (mounted) {
					setReason(lutUnavailableReason(value));
				}
			})
			.catch(() => undefined);
		return () => {
			mounted = false;
		};
	}, [read]);
	return reason;
}
