/**
 * CSS keyframes for the gallery's animated thumbnails (W2-V10). Each demo
 * plays the real preview stage (`entryTransitionState` + `revealStyle`) on a
 * synthetic cut, sampled into keyframes, so a thumbnail shows exactly what the
 * preview will.
 */
import {
	type Asset,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import {
	newRevealTransition,
	pushExitOf,
	type RevealTransition,
} from "../../../shared/reveal-transitions.ts";
import {
	entryTransitionState,
	revealStyle,
} from "../preview/stages/transitions.ts";

const DEMO_ASSET: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-0000000000d1",
	kind: "image",
	name: "Demo",
	width: 1920,
};

/** Thumbnail height in CSS pixels, for scaling 1080-line blur radii. */
export const DEMO_TILE_HEIGHT = 54;
/** Share of the loop the transition plays; the rest holds the incoming clip. */
const PLAY_SHARE = 0.7;
const SAMPLES = 12;
const DURATION = 1;

const kebab = (name: string) =>
	name
		.replace(/^Webkit/, "-webkit-")
		.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const round = (value: number) => Math.round(value * 1e4) / 1e4;

export const demoAnimationName = (type: RevealTransition, layer: "a" | "b") =>
	`studio-transition-demo-${type}-${layer}`;

function layerDeclarations(segment: Segment, elapsed: number): string {
	const entry = entryTransitionState(segment, elapsed);
	const reveal = revealStyle(segment, elapsed);
	const filters = [
		entry.blur
			? `blur(${round((entry.blur * DEMO_TILE_HEIGHT) / 1080)}px)`
			: "",
		typeof reveal.filter === "string" ? reveal.filter : "",
	].filter(Boolean);
	const declarations: Record<string, string> = {
		"clip-path": "none",
		filter: filters.length > 0 ? filters.join(" ") : "none",
		opacity: `${round(Math.max(0, entry.opacity))}`,
		transform: `translate(${round(entry.shiftX * 100)}%, ${round(entry.shiftY * 100)}%) scale(${round(entry.scale)}) rotate(${round(entry.rotation ?? 0)}deg)`,
	};
	for (const [key, value] of Object.entries(reveal)) {
		if (key !== "filter" && typeof value === "string") {
			declarations[kebab(key)] = value;
		}
	}
	return Object.entries(declarations)
		.map(([key, value]) => `${key}: ${value};`)
		.join(" ");
}

/** Synthetic outgoing (A) and incoming (B) clips for one transition. */
export function demoCut(type: RevealTransition): { a: Segment; b: Segment } {
	const push = pushExitOf(type);
	const a: Segment = {
		...newSegment(DEMO_ASSET, 0),
		id: "00000000-0000-4000-8000-0000000000a1",
		sourceOut: 2,
		...(push ? { exitDuration: DURATION, exitTransition: push } : {}),
	};
	const b: Segment = {
		...newSegment(DEMO_ASSET, 1),
		id: "00000000-0000-4000-8000-0000000000b1",
		sourceOut: 2,
		transitionIn: newRevealTransition(type, DURATION),
	};
	return { a, b };
}

/** `@keyframes` for both layers of one demo tile. */
export function transitionDemoKeyframes(type: RevealTransition): string {
	const { a, b } = demoCut(type);
	const frames = (segment: Segment, offset: number) => {
		const steps: string[] = [];
		for (let step = 0; step <= SAMPLES; step++) {
			const progress = step / SAMPLES;
			const at = round(progress * PLAY_SHARE * 100);
			steps.push(
				`${at}% { ${layerDeclarations(segment, offset + progress * DURATION)} }`
			);
		}
		steps.push(`100% { ${layerDeclarations(segment, offset + DURATION)} }`);
		return steps.join(" ");
	};
	return [
		`@keyframes ${demoAnimationName(type, "a")} { ${frames(a, 1)} }`,
		`@keyframes ${demoAnimationName(type, "b")} { ${frames(b, 0)} }`,
	].join("\n");
}
