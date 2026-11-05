// The scene-readiness error keys as a named template ("Scene {sceneNumber}
// still needs …"), so the host's DOM localizer translates the rendered
// error text around the scene number.
import { afterEach, describe, expect, test } from "bun:test";
import { I18nRuntime, registerLiteralCatalogLoader } from "@ryu/i18n/core";
import type { ScriptScene } from "../../../shared/script-to-video.ts";
import { assembleBody, type SceneDraft } from "./script-to-video-pipeline.ts";

const GERMAN = {
	"Scene {sceneNumber} still needs narration and a visual.":
		"Szene {sceneNumber} braucht noch Sprechtext und ein Bild.",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
});

function thrownMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected a thrown error");
}

describe("assembly errors", () => {
	test("a scene missing media renders in German", () => {
		const scene: ScriptScene = {
			imagePrompt: "Berge im Nebel.",
			narration: "Hallo",
			visualQuery: "Berge",
		};
		const drafts: SceneDraft[] = [
			{
				id: "a",
				narrationAssetId: "n1",
				scene,
				status: "ready",
				visualAssetId: "v1",
			},
			{ id: "b", scene, status: "pending" },
		];
		const message = thrownMessage(() =>
			assembleBody(drafts, { captions: "words", gap: 0 })
		);
		expect(message).toBe("Scene 2 still needs narration and a visual.");
		registerLiteralCatalogLoader((locale) =>
			locale.startsWith("de") ? GERMAN : null
		);
		const runtime = new I18nRuntime([], {
			initialLocale: "de",
			initialPackId: null,
		});
		expect(runtime.templateMessage(message)).toBe(
			"Szene 2 braucht noch Sprechtext und ein Bild."
		);
	});
});
