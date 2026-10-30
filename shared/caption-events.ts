import type { Caption } from "./project.ts";

/** One displayed word (or the whole text) of a caption event. */
export interface CaptionEventPart {
	active: boolean;
	end: number;
	/** Word position in the caption (0 when the caption has no words). */
	index: number;
	speakerId?: string;
	/** Seconds the word starts; the cue start when it has no word timing. */
	start: number;
	/** Display text, with a leading space after the first word. */
	text: string;
}

export interface CaptionEvent {
	end: number;
	parts: CaptionEventPart[];
	start: number;
}

/**
 * Split a caption at every word boundary so each event knows which word is
 * being spoken. Captions without word timing are one event.
 */
export function captionEvents(caption: Caption): CaptionEvent[] {
	if (!caption.words?.length) {
		return [
			{
				start: caption.start,
				end: caption.end,
				parts: [
					{
						active: false,
						end: caption.end,
						index: 0,
						speakerId: caption.speakerId,
						start: caption.start,
						text: caption.text,
					},
				],
			},
		];
	}
	const words = caption.words;
	const boundaries = [
		...new Set([
			caption.start,
			caption.end,
			...words.flatMap((word) => [word.start, word.end]),
		]),
	].sort((a, b) => a - b);
	return boundaries.slice(0, -1).map((start, index) => {
		const end = boundaries[index + 1] ?? caption.end;
		const middle = (start + end) / 2;
		return {
			start,
			end,
			parts: words.map((word, position) => ({
				active: middle >= word.start && middle < word.end,
				end: word.end,
				index: position,
				speakerId: word.speakerId ?? caption.speakerId,
				start: word.start,
				text: `${position ? " " : ""}${word.text}`,
			})),
		};
	});
}
