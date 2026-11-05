/**
 * Entry point compiled by `verify-embedded-assets.ts`: reports where a
 * compiled sidecar finds its bundled fonts and RNNoise model, using the same
 * resolution code the sidecar runs (`fonts.ts`, `audio-environment.ts`).
 */
import { bundledFontsDirectory } from "./fonts.ts";
import { bundledVoiceModelPath } from "./render-stages/audio-environment.ts";

process.stdout.write(
	JSON.stringify({
		fonts: bundledFontsDirectory(),
		model: bundledVoiceModelPath(),
	})
);
