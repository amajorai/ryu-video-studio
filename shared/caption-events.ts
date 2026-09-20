import type { Caption } from "./project.ts";
export function captionEvents(caption: Caption) {
	if (!caption.words?.length) {
		return [
			{
				start: caption.start,
				end: caption.end,
				parts: [{ text: caption.text, active: false }],
			},
		];
	}
	const boundaries = [
		...new Set([
			caption.start,
			caption.end,
			...caption.words.flatMap((word) => [word.start, word.end]),
		]),
	].sort((a, b) => a - b);
	return boundaries.slice(0, -1).map((start, index) => {
		const end = boundaries[index + 1]!;
		const middle = (start + end) / 2;
		return {
			start,
			end,
			parts: caption.words!.map((word, position) => ({
				text: `${position ? " " : ""}${word.text}`,
				active: middle >= word.start && middle < word.end,
			})),
		};
	});
}
