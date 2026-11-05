import type { Asset } from "./project.ts";

export interface TakeQuality {
	detail: string;
	label: string;
	score: number;
	status: "ready" | "review";
}

export function takeQuality(
	asset: Asset | undefined,
	project: { width: number; height: number }
): TakeQuality {
	if (!asset || asset.kind === "audio") {
		return {
			detail: "Choose a visual take before reviewing technical quality.",
			label: "No visual take",
			score: 0,
			status: "review",
		};
	}
	const widthRatio = asset.width / project.width;
	const heightRatio = asset.height / project.height;
	const resolutionScore =
		widthRatio >= 1 && heightRatio >= 1
			? 50
			: widthRatio >= 0.5 && heightRatio >= 0.5
				? 35
				: 15;
	const durationScore = asset.duration > 0 ? 30 : 0;
	const audioScore = asset.kind === "video" && asset.hasAudio ? 20 : 15;
	const score = resolutionScore + durationScore + audioScore;
	const passed = score >= 70 && asset.duration > 0;
	const resolution = `${asset.width}×${asset.height}`;
	const detail = `${resolution} · ${asset.duration.toFixed(1)}s${
		asset.kind === "video" ? (asset.hasAudio ? " · audio" : " · silent") : ""
	}`;
	return {
		detail,
		label: passed ? "Technical checks passed" : "Review technical quality",
		score,
		status: passed ? "ready" : "review",
	};
}
