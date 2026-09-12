import { z } from "zod";
import { type Caption, captionSchema, type Project } from "./project.ts";
export const TRANSCRIPT_WINDOW_SECONDS = 20;
export const transcriptSchema = z
	.object({
		assetId: z.uuid(),
		origin: z
			.enum(["imported", "ryu-transcription"])
			.default("ryu-transcription"),
		timing: z.enum(["windows", "segments", "imported"]).default("windows"),
		revision: z.number().int().nonnegative(),
		status: z.enum(["running", "completed", "failed", "canceled"]),
		nextOffset: z.number().min(0).max(7200),
		duration: z.number().min(0).max(7200),
		cues: z.array(captionSchema).max(5000),
		words: z.array(captionSchema).max(50_000).default([]),
		error: z.string().max(1000).optional(),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export type Transcript = z.infer<typeof transcriptSchema>;
export function transcriptWindowCues(
	value: unknown,
	start: number,
	duration: number
): Caption[] {
	const text =
		typeof value === "string"
			? value
			: typeof value === "object" &&
					value !== null &&
					"text" in value &&
					typeof value.text === "string"
				? value.text
				: null;
	if (text === null) {
		throw new Error("The transcription service returned an invalid result.");
	}
	if (!text.trim()) {
		return [];
	}
	if (text.length > 2000 || text.includes("\0")) {
		throw new Error("The transcript window is too long.");
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"segments" in value &&
		Array.isArray(value.segments) &&
		value.segments.length
	) {
		const segments = z
			.array(
				z.object({
					startMs: z.number().int().nonnegative(),
					endMs: z.number().int().nonnegative(),
					text: z.string().max(2000),
				})
			)
			.max(1000)
			.parse(value.segments);
		return segments.flatMap((segment) => {
			if (segment.endMs < segment.startMs || segment.text.includes("\0")) {
				throw new Error("Invalid engine segment timing.");
			}
			const end = start + Math.min(duration, segment.endMs / 1000);
			const begin = start + segment.startMs / 1000;
			return end > begin && segment.text.trim()
				? [
						{
							id: crypto.randomUUID(),
							start: begin,
							end,
							text: segment.text.trim(),
						},
					]
				: [];
		});
	}
	// Plain-text engines retain source-window timing; word alignment is never invented.

	return [
		{
			id: crypto.randomUUID(),
			start,
			end: start + duration,
			text: text.trim(),
		},
	];
}
export function transcriptWindowWords(
	value: unknown,
	start: number,
	duration: number
): Caption[] {
	if (
		!value ||
		typeof value !== "object" ||
		!("words" in value) ||
		!Array.isArray(value.words) ||
		!value.words.length
	) {
		return [];
	}
	// The segment normalizer already checks measured millisecond ranges and bounds.
	const words = transcriptWindowCues(
		{ text: "Measured words", segments: value.words },
		start,
		duration
	);
	const captions: Caption[] = [];
	for (const word of words) {
		const previous = captions.at(-1);
		if (
			previous &&
			/^[.,!?;:…。，！？、；：]+$/u.test(word.text) &&
			word.start >= previous.start
		) {
			previous.text += word.text;
			previous.end = Math.max(previous.end, word.end);
		} else {
			captions.push({ ...word });
		}
	}
	return captions;
}
export function captionsForSource(
	project: Project,
	transcript: Transcript
): Caption[] {
	const cues: Caption[] = [];
	for (const segment of project.segments.filter(
		(s) => s.assetId === transcript.assetId
	)) {
		for (const cue of transcript.cues) {
			const start = Math.max(cue.start, segment.sourceIn);
			const end = Math.min(cue.end, segment.sourceOut);
			if (end <= start) {
				continue;
			}
			cues.push({
				id: crypto.randomUUID(),
				sourceAssetId: transcript.assetId,
				start: segment.start + (start - segment.sourceIn) / segment.speed,
				end: segment.start + (end - segment.sourceIn) / segment.speed,
				text: cue.text,
			});
		}
	}
	return cues;
}
export function highlightedCaptionsForSource(
	project: Project,
	transcript: Transcript
): Caption[] {
	const captions: Caption[] = [];
	for (const segment of project.segments.filter(
		(segment) => segment.assetId === transcript.assetId
	)) {
		const words = captionsForSource(
			{ ...project, segments: [segment] },
			{ ...transcript, cues: transcript.words }
		).sort((a, b) => a.start - b.start);
		let group: Caption | undefined;
		for (const word of words) {
			if (
				!group?.words ||
				group.words.length >= 6 ||
				group.text.length + word.text.length + 1 > 2000 ||
				word.end - group.start > 3 ||
				word.start - group.end > 0.6
			) {
				group = {
					id: crypto.randomUUID(),
					sourceAssetId: transcript.assetId,
					start: word.start,
					end: word.end,
					text: word.text,
					words: [],
					highlightColor: "#ffd43b",
				};
				captions.push(group);
			}
			group.words!.push({
				id: word.id,
				start: word.start,
				end: word.end,
				text: word.text,
			});
			group.end = Math.max(group.end, word.end);
			group.text = group.words!.map((item) => item.text).join(" ");
		}
	}
	return captions;
}
export const translatedCaptionsSchema = z
	.object({
		translations: z
			.array(
				z.object({ id: z.uuid(), text: z.string().min(1).max(2000) }).strict()
			)
			.max(50),
	})
	.strict();
export function applyTranslations(
	captions: Caption[],
	value: unknown
): Caption[] {
	const { translations } = translatedCaptionsSchema.parse(value);
	if (
		translations.length !== captions.length ||
		new Set(translations.map((t) => t.id)).size !== captions.length ||
		translations.some((t) => !captions.some((c) => c.id === t.id))
	) {
		throw new Error("Translation did not preserve every caption ID.");
	}
	return captions.map((caption) => ({
		...caption,
		text: translations.find((t) => t.id === caption.id)?.text ?? caption.text,
		words: undefined,
	}));
}
