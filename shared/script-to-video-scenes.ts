/**
 * Script to video scene planning: parse the planner's reply, or split a
 * script locally into narrated scenes with derived search keywords.
 */
import { z } from "zod";
import {
	MAX_SCENE_NARRATION_CHARS,
	MAX_SCRIPT_SCENES,
	type ScriptScene,
	scriptPlanSchema,
	scriptTextSchema,
} from "./script-to-video-schema.ts";

const lenientSceneSchema = z.object({
	narration: z.string(),
	visualQuery: z.string().optional(),
	imagePrompt: z.string().optional(),
});

function jsonCandidate(text: string): unknown {
	const unfenced = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(unfenced);
	} catch {
		const open = unfenced.search(/[[{]/);
		const close = Math.max(
			unfenced.lastIndexOf("}"),
			unfenced.lastIndexOf("]")
		);
		if (open < 0 || close <= open) {
			throw new Error("The scene planner did not return JSON.");
		}
		try {
			return JSON.parse(unfenced.slice(open, close + 1));
		} catch {
			throw new Error("The scene planner returned malformed JSON.");
		}
	}
}

/**
 * Validate the planner's reply: JSON (optionally fenced or wrapped in prose)
 * holding `scenes` or a bare scene array. Missing search keywords or image
 * prompts are derived from the narration; empty narrations are dropped.
 */
export function parseScriptPlan(text: string): ScriptScene[] {
	const value = jsonCandidate(text);
	const list = Array.isArray(value)
		? value
		: z.object({ scenes: z.array(z.unknown()) }).parse(value).scenes;
	const scenes: ScriptScene[] = [];
	for (const item of list) {
		const parsed = lenientSceneSchema.safeParse(item);
		if (!parsed.success) {
			throw new Error("A planned scene is missing its narration.");
		}
		const narration = parsed.data.narration.replaceAll("\0", "").trim();
		if (!narration) {
			continue;
		}
		scenes.push(
			sceneFromNarration(
				narration,
				parsed.data.visualQuery,
				parsed.data.imagePrompt
			)
		);
	}
	return scriptPlanSchema.parse({ scenes }).scenes;
}

const STOP_WORDS = new Set(
	"a about after again also an and any are as at be because been before between both but by can could did do does down during each few for from had has have he her here his how i if in into is it its just let me more most my no not of off on once only or our out over own same she so some than that the their them then there these they this those through to too under until up us very was we were what when where which while who why will with would you your".split(
		" "
	)
);

/** Up to `limit` distinctive keywords of `text`, by frequency then first use. */
export function sceneKeywords(text: string, limit = 4): string[] {
	const counts = new Map<string, { count: number; first: number }>();
	const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
	for (const [index, word] of words.entries()) {
		const clean = word.replace(/'s$/, "").replace(/['-]+$/, "");
		if (clean.length < 3 || STOP_WORDS.has(clean) || /^\d+$/.test(clean)) {
			continue;
		}
		const entry = counts.get(clean);
		if (entry) {
			entry.count += 1;
		} else {
			counts.set(clean, { count: 1, first: index });
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
		.slice(0, limit)
		.map(([word]) => word);
}

const truncate = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function sceneFromNarration(
	narration: string,
	visualQuery?: string,
	imagePrompt?: string
): ScriptScene {
	const clipped = truncate(narration, MAX_SCENE_NARRATION_CHARS);
	const keywords = sceneKeywords(clipped).join(" ");
	return {
		imagePrompt: truncate(
			imagePrompt?.trim() ||
				`An original cinematic still illustrating: ${truncate(clipped, 300)}`,
			2000
		),
		narration: clipped,
		visualQuery: truncate(
			visualQuery?.trim() || keywords || truncate(clipped, 60),
			200
		),
	};
}

/** Sentences of `text`, keeping their closing punctuation. */
function sentences(text: string): string[] {
	return (text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [])
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Split a script locally (no model): paragraphs first, then sentences
 * grouped to about `targetWords` words, merged down to `maxScenes`.
 */
export function heuristicScriptScenes(
	script: string,
	options: { maxScenes?: number; targetWords?: number } = {}
): ScriptScene[] {
	const text = scriptTextSchema.parse(script);
	const maxScenes = Math.min(
		MAX_SCRIPT_SCENES,
		Math.max(1, Math.round(options.maxScenes ?? 12))
	);
	const target = Math.max(5, options.targetWords ?? 35);
	const chunks: string[] = [];
	for (const paragraph of text.split(/\n\s*\n/)) {
		let current = "";
		for (const sentence of sentences(paragraph.replace(/\s+/g, " "))) {
			const next = current ? `${current} ${sentence}` : sentence;
			if (
				current &&
				(wordCount(next) > target || next.length > MAX_SCENE_NARRATION_CHARS)
			) {
				chunks.push(current);
				current = sentence;
			} else {
				current = next;
			}
		}
		if (current) {
			chunks.push(current);
		}
	}
	while (chunks.length > maxScenes) {
		// Merge the shortest adjacent pair that still fits one narration.
		let best = -1;
		let bestLength = Number.POSITIVE_INFINITY;
		for (let index = 0; index + 1 < chunks.length; index += 1) {
			const length =
				(chunks[index]?.length ?? 0) + (chunks[index + 1]?.length ?? 0) + 1;
			if (length <= MAX_SCENE_NARRATION_CHARS && length < bestLength) {
				best = index;
				bestLength = length;
			}
		}
		if (best < 0) {
			break;
		}
		chunks.splice(best, 2, `${chunks[best]} ${chunks[best + 1]}`);
	}
	return chunks
		.slice(0, maxScenes)
		.flatMap((chunk) =>
			chunk.length > MAX_SCENE_NARRATION_CHARS
				? [chunk.slice(0, MAX_SCENE_NARRATION_CHARS)]
				: [chunk]
		)
		.map((chunk) => sceneFromNarration(chunk));
}
