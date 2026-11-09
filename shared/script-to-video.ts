/**
 * Script to video (W4-G4): split a script into narrated scenes, then
 * assemble generated narration and per-scene visuals into a timed edit with
 * captions aligned to the narration.
 *
 * Everything here is pure and deterministic (ids come from an injectable
 * factory). The UI pipeline asks `model.complete` for scenes
 * (`scriptSplitRequest` / `parseScriptPlan`, or `heuristicScriptScenes`
 * offline), produces narration and visuals through the existing generation
 * and stock gates, and posts `scriptAssembleRequestSchema` to
 * `POST /projects/:id/script-assemble`, which runs `assembleScriptVideo`.
 */

import {
	MAX_SCRIPT_CHARS,
	MAX_SCRIPT_SCENES,
	scriptTextSchema,
} from "./script-to-video-schema.ts";

export {
	alignNarrationWords,
	type NarrationWord,
	similarTokens,
} from "./script-to-video-align.ts";
export {
	assembleScriptVideo,
	kenBurnsKeyframes,
	narrationTimingFromTranscript,
	scriptSceneTimes,
} from "./script-to-video-assemble.ts";
export {
	heuristicScriptScenes,
	parseScriptPlan,
	sceneKeywords,
} from "./script-to-video-scenes.ts";
export {
	type AssembledScriptScene,
	DEFAULT_SCRIPT_CHUNKING,
	KEN_BURNS_DRIFT,
	KEN_BURNS_MIN_SCALE,
	KEN_BURNS_ZOOM,
	MAX_SCENE_NARRATION_CHARS,
	MAX_SCRIPT_CHARS,
	MAX_SCRIPT_SCENES,
	MIN_SCENE_SECONDS,
	MIN_STRETCH_SPEED,
	type NarrationTiming,
	type ScriptAssembleInput,
	type ScriptAssembleOptions,
	type ScriptAssembleRequest,
	type ScriptAssembly,
	type ScriptPlan,
	type ScriptScene,
	scriptAssembleRequestSchema,
	scriptAssembleSceneSchema,
	scriptPlanSchema,
	scriptSceneSchema,
	scriptTextSchema,
} from "./script-to-video-schema.ts";

/** The `model.complete` input that splits `script` into scenes. */
export function scriptSplitRequest(
	script: string,
	options: { maxScenes?: number } = {}
): { prompt: string; system: string } {
	const text = scriptTextSchema.parse(script);
	const maxScenes = Math.min(
		MAX_SCRIPT_SCENES,
		Math.max(1, Math.round(options.maxScenes ?? 12))
	);
	return {
		system: [
			"You split a narration script into scenes for a short video.",
			'Return only JSON shaped {"scenes":[{"narration":string,"visualQuery":string,"imagePrompt":string}]}. No markdown.',
			`Produce 1 to ${maxScenes} scenes in script order.`,
			"narration is the exact script wording for that scene, without speaker labels or stage directions; together the scenes cover the whole script once.",
			"visualQuery is 2 to 6 plain keywords for searching stock footage (no quotes or operators).",
			"imagePrompt is one sentence describing an original still image for the scene, with no text, logos, or real people's names.",
		].join(" "),
		prompt: text,
	};
}

/** Longest topic or brief the script writer accepts. */
export const MAX_SCRIPT_TOPIC_CHARS = 2000;
/** Spoken words per second the writer aims for (about 150 words a minute). */
const WORDS_PER_SECOND = 2.5;

/**
 * The `model.complete` request that writes a narration script about `topic`.
 * The result is plain spoken text for `Script`, about `seconds` long.
 */
export function scriptWriterRequest(
	topic: string,
	options: { brief?: string; seconds?: number; title?: string } = {}
): { prompt: string; system: string } {
	const subject = topic.trim().slice(0, MAX_SCRIPT_TOPIC_CHARS);
	if (!subject) {
		throw new Error("Describe what the video is about first.");
	}
	const seconds = Math.min(
		600,
		Math.max(10, Math.round(options.seconds ?? 60))
	);
	const words = Math.round(seconds * WORDS_PER_SECOND);
	return {
		system: [
			"You write narration scripts for short videos.",
			`Write about ${words} words (roughly ${seconds} seconds spoken) in short paragraphs, one idea per paragraph.`,
			"Return only the words the narrator says: no title, headings, scene numbers, speaker labels, stage directions, bullet points, or markdown.",
			"Do not invent statistics, quotes, or facts you are not sure of.",
		].join(" "),
		prompt: JSON.stringify({
			topic: subject,
			...(options.title?.trim() ? { projectTitle: options.title.trim() } : {}),
			...(options.brief?.trim()
				? { brief: options.brief.trim().slice(0, MAX_SCRIPT_TOPIC_CHARS) }
				: {}),
		}),
	};
}

/**
 * Clean a written script: code fences, markdown headings, list markers,
 * speaker labels and bracketed stage directions are removed, paragraphs are
 * kept, and the text is capped at `MAX_SCRIPT_CHARS`.
 */
export function parseWrittenScript(text: string): string {
	const cleaned = text
		.replace(/\r/g, "")
		.replace(/```[a-z]*\n?/gi, "")
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s*#{1,6}\s+.*$/, "")
				.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
				.replace(/^\s*(?:narrator|voice ?over|vo|host)\s*:\s*/i, "")
				.replace(
					/\[[^\]\n]*\]|\([^)\n]*(?:music|sfx|pause|cut to)[^)\n]*\)/gi,
					""
				)
				.replace(/\*\*|__/g, "")
				.trim()
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!cleaned) {
		throw new Error("Ryu did not write a script. Try a more specific topic.");
	}
	return cleaned.slice(0, MAX_SCRIPT_CHARS).trim();
}

/** The storyboard's per-scene scripts, in scene order, as one script. */
export function storyboardScript(
	scenes: readonly { script: string }[]
): string {
	return scenes
		.map((scene) => scene.script.trim())
		.filter(Boolean)
		.join("\n\n")
		.slice(0, MAX_SCRIPT_CHARS)
		.trim();
}
