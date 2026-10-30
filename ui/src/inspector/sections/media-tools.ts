/**
 * Actions behind the inspector's media tools: render a derivative of the
 * clip's media (stabilize, frame rate, enhanced upscale, smooth slow motion)
 * and move the clip onto it. Derivatives keep the source untouched.
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import type {
	InterpolateMode,
	StabilizeLevel,
} from "../../../../shared/derivatives.ts";
import {
	type Asset,
	assetSchema,
	type Segment,
} from "../../../../shared/project.ts";
import { request } from "../../bridge.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";

const supportSchema = z.object({
	filters: z.object({
		minterpolate: z.boolean().optional(),
		vidstabdetect: z.boolean().optional(),
		vidstabtransform: z.boolean().optional(),
	}),
});

export interface MediaToolSupport {
	/** Optical-flow interpolation (`minterpolate`); undefined while unknown. */
	opticalFlow: boolean | undefined;
	/** libvidstab; without it stabilize uses the built-in tracker. */
	vidstab: boolean | undefined;
}

const unknownSupport: MediaToolSupport = {
	opticalFlow: undefined,
	vidstab: undefined,
};

let pending: Promise<MediaToolSupport> | undefined;

export function loadMediaToolSupport(
	fetchCapabilities: () => Promise<z.infer<typeof supportSchema>> = () =>
		request(supportSchema, "/capabilities")
): Promise<MediaToolSupport> {
	pending ??= fetchCapabilities()
		.then(({ filters }) => ({
			opticalFlow: filters.minterpolate,
			vidstab:
				filters.vidstabdetect === undefined ||
				filters.vidstabtransform === undefined
					? undefined
					: filters.vidstabdetect && filters.vidstabtransform,
		}))
		.catch(() => {
			pending = undefined;
			return unknownSupport;
		});
	return pending;
}

/** Forget the cached probe (tests). */
export function resetMediaToolSupport() {
	pending = undefined;
}

export function useMediaToolSupport(): MediaToolSupport {
	const [support, setSupport] = useState(unknownSupport);
	useEffect(() => {
		let active = true;
		loadMediaToolSupport().then((value) => {
			if (active) {
				setSupport(value);
			}
		});
		return () => {
			active = false;
		};
	}, []);
	return support;
}

export const STABILIZE_LEVEL_LABELS: Record<StabilizeLevel, string> = {
	high: "High (strong smoothing, 8% zoom)",
	low: "Low (light smoothing, 4% zoom)",
	medium: "Medium (6% zoom)",
};

/** Target rates offered for frame-rate conversion. */
export const INTERPOLATE_RATES = [24, 25, 30, 48, 50, 60, 120] as const;

const derivativeResultSchema = z.object({
	asset: assetSchema,
	created: z.boolean(),
	method: z.string(),
	mode: z.string().optional(),
});

/**
 * The asset a new derivative should be made from: stabilized, interpolated
 * and enhanced media point back at their original, so re-running a tool
 * never stacks derivatives of derivatives.
 */
export function derivativeSource(
	asset: Asset,
	assets: readonly Asset[]
): Asset {
	if (
		asset.derivedFromAssetId &&
		(asset.derivation === "stabilize" ||
			asset.derivation === "interpolate" ||
			asset.derivation === "enhance")
	) {
		return (
			assets.find((candidate) => candidate.id === asset.derivedFromAssetId) ??
			asset
		);
	}
	return asset;
}

/** Whether "Render smooth slow motion" applies to the clip. */
export function smoothSlowMotionReady(
	segment: Pick<Segment, "frameInterpolation" | "speed">
): boolean {
	return (
		segment.speed < 1 &&
		segment.frameInterpolation !== undefined &&
		segment.frameInterpolation !== "none"
	);
}

/** Add `asset` to the library list unless it is already there. */
export function withAsset(assets: readonly Asset[], asset: Asset): Asset[] {
	return assets.some((item) => item.id === asset.id)
		? [...assets]
		: [asset, ...assets];
}

export type MediaToolRequest =
	| { kind: "stabilize"; level: StabilizeLevel }
	| { fps: number; kind: "interpolate"; mode: InterpolateMode }
	| { factor: 2 | 4; kind: "enhance" };

/** Sidecar path and body for a derivative request. */
export function mediaToolCall(
	source: Pick<Asset, "id">,
	tool: MediaToolRequest
): { body: Record<string, unknown>; path: string } {
	const base = `/assets/${encodeURIComponent(source.id)}`;
	if (tool.kind === "stabilize") {
		return { body: { level: tool.level }, path: `${base}/stabilize` };
	}
	if (tool.kind === "interpolate") {
		return {
			body: { fps: tool.fps, mode: tool.mode },
			path: `${base}/interpolate`,
		};
	}
	return {
		body: { enhance: true, factor: tool.factor },
		path: `${base}/upscale`,
	};
}

function parseDerivative(tool: MediaToolRequest, payload: unknown): Asset {
	return tool.kind === "enhance"
		? assetSchema.parse(payload)
		: derivativeResultSchema.parse(payload).asset;
}

/**
 * Render a derivative of the clip's media and swap the clip onto it. The
 * swap is a revision-checked route edit, so it is undoable like any edit.
 */
export async function applyMediaTool(
	runtime: EditorRuntime,
	segment: Segment,
	tool: MediaToolRequest
): Promise<void> {
	const current = runtime.assets.find((asset) => asset.id === segment.assetId);
	if (!current) {
		runtime.setStatus("This clip's media is unavailable.");
		return;
	}
	const source = derivativeSource(current, runtime.assets);
	const call = mediaToolCall(source, tool);
	let derivative: Asset | undefined;
	await runtime.act(async () => {
		runtime.setStatus(`Rendering ${source.name}…`);
		derivative = parseDerivative(tool, await runtime.api(call.path, call.body));
	});
	if (!derivative) {
		return;
	}
	const next = derivative;
	runtime.setAssets((assets) => withAsset(assets, next));
	await runtime.routeEdit(
		"swap-clip-media",
		{ assetId: next.id, clipId: segment.id },
		() => `Clip now uses ${next.name}.`,
		{ refreshAssets: true }
	);
}

/** Interpolate the clip's original media to project fps / speed and swap. */
export async function renderSmoothSlowMotion(
	runtime: EditorRuntime,
	segment: Segment
): Promise<void> {
	await runtime.routeEdit(
		"smooth-slow-motion",
		{ clipId: segment.id },
		() => "Smooth slow motion rendered; the clip keeps its speed and range.",
		{ refreshAssets: true }
	);
}
