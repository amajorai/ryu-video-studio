import type { Caption } from "./project.ts";

const maxDubbingCharacters = 8000;

export function dubbingScript(captions: Caption[]): string {
	const script = captions
		.map((caption) => caption.text.trim())
		.filter(Boolean)
		.join(" ");
	if (!script) {
		throw new Error("Add captions before creating a dubbed track.");
	}
	if (script.length > maxDubbingCharacters) {
		throw new Error(
			"This caption track is longer than one narration request. Split it into shorter tracks before dubbing."
		);
	}
	return script;
}

export function dubbingFilename(language: string): string {
	const suffix = language.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "default";
	return `Dubbed captions ${suffix}.wav`;
}
