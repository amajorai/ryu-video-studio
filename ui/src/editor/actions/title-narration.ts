import { z } from "zod";
import type { GenerationRequestInput } from "../../../../shared/generation.ts";
import { titleNarrationText } from "../../../../shared/title-narration.ts";
import {
	EMPTY_VOICE_CHOICE,
	type TtsVoiceChoice,
	ttsVoiceChoiceSchema,
} from "../../../../shared/tts-voices.ts";
import {
	type GenerationServices,
	hostGenerationServices,
	runGeneration,
} from "../../ai/media-bridge.ts";
import { clock, message } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import { readViewerValue, writeViewerValue } from "../viewer-storage.ts";

/** Per-viewer narration voice, shared by the Titles panel and the title menu. */
export const TITLE_NARRATION_VOICE_KEY = "titles.narration.voice";

const storedVoiceSchema = ttsVoiceChoiceSchema.extend({
	speed: z.number().finite().min(0.5).max(2).default(1),
});
export type TitleNarrationVoice = TtsVoiceChoice & { speed: number };

/** The viewer's last narration voice for titles (engine default when none). */
export function readTitleNarrationVoice(): TitleNarrationVoice {
	return readViewerValue(TITLE_NARRATION_VOICE_KEY, storedVoiceSchema, {
		...EMPTY_VOICE_CHOICE,
		speed: 1,
	});
}

export function writeTitleNarrationVoice(voice: TitleNarrationVoice): void {
	writeViewerValue(TITLE_NARRATION_VOICE_KEY, voice);
}

/** The narration request for one title's text. */
export function titleNarrationRequest(
	projectId: string,
	text: string,
	voice: TitleNarrationVoice
): GenerationRequestInput {
	const input: GenerationRequestInput = {
		id: crypto.randomUUID(),
		projectId,
		kind: "audio",
		prompt: text,
		voice: voice.voice.trim(),
		language: voice.language.trim(),
		speed: voice.speed,
		route: "node-default",
		rationale: "Text to speech from a title layer.",
	};
	if (voice.engine.trim() && voice.voice.trim()) {
		input.engine = voice.engine.trim();
	}
	return input;
}

export interface TitleNarrationDeps {
	/** Runs the request (tests stub it); defaults to `runGeneration`. */
	run?: typeof runGeneration;
	/** Generation services; defaults to the host bridge. */
	services?: GenerationServices;
}

/**
 * Speak a title's text with Ryu's text to speech and place the audio as a
 * clip that starts with the title. The audio is saved to the library first,
 * so a refused placement still keeps the narration.
 */
export async function narrateTitle(
	runtime: EditorRuntime,
	titleId: string,
	voice: TitleNarrationVoice = readTitleNarrationVoice(),
	deps: TitleNarrationDeps = {}
): Promise<boolean> {
	const project = runtime.latestProject.current ?? runtime.project;
	const title = project?.titles.find((item) => item.id === titleId);
	if (!(project && title)) {
		runtime.setStatus("That title is no longer in the project.");
		return false;
	}
	const text = titleNarrationText(title.text);
	if (!text) {
		runtime.setStatus("Add text to this title before speaking it.");
		return false;
	}
	const services =
		deps.services ??
		hostGenerationServices((progress) =>
			runtime.setStatus(
				`Saving title narration · ${Math.round(progress * 100)}%`
			)
		);
	const run = deps.run ?? runGeneration;
	runtime.setStatus("Speaking the title through Ryu's text to speech…");
	let assetId: string;
	let assetName: string;
	try {
		const saved = await run(
			services,
			titleNarrationRequest(project.id, text, voice)
		);
		assetId = saved.asset.id;
		assetName = saved.asset.name;
		runtime.setAssets((current) => [
			saved.asset,
			...current.filter((asset) => asset.id !== saved.asset.id),
		]);
	} catch (error) {
		runtime.setStatus(message(error));
		return false;
	}
	const outcome = await runtime.routeEdit(
		"title-narration",
		{ assetId, titleId },
		() =>
			`Title narration placed at ${clock(title.start)}. Review pronunciation and timing.`
	);
	if (outcome.status !== "ok") {
		runtime.setStatus(
			`${assetName} was saved to the library, but it could not be placed at the title. Add it from the library.`
		);
		return false;
	}
	runtime.setTime(title.start);
	return true;
}
