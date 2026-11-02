import assert from "node:assert/strict";
import {
	sceneDraftRequest,
	scenePlanSchema,
	translationRequest,
} from "../../shared/production-prompts.ts";
import { applyTranslations } from "../../shared/transcript.ts";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("translation and scene drafting use real governed local inference", async () => {
	const host = await createCoreSpeechHost({ mediaOnly: true, model: true });
	try {
		await host.enableModel();
		const captions = [
			{
				id: crypto.randomUUID(),
				start: 0,
				end: 2,
				text: "Hello, welcome to our studio.",
			},
			{
				id: crypto.randomUUID(),
				start: 2,
				end: 4,
				text: "We edit the film and add subtitles.",
			},
		];
		const translated = applyTranslations(
			captions,
			JSON.parse(await host.model(translationRequest("French", captions)))
		);
		assert.match(translated[0]!.text, /bonjour|bienvenue/i);
		assert.match(translated[1]!.text, /sous[- ]titr/i);
		assert.doesNotMatch(
			translated[1]!.text,
			/nous (éditez|éditions)/i,
			"Reject the observed verb-agreement regression"
		);
		assert.deepEqual(
			translated.map((caption) => [caption.id, caption.start, caption.end]),
			captions.map((caption) => [caption.id, caption.start, caption.end])
		);
		const plan = scenePlanSchema.parse(
			JSON.parse(
				await host.model(
					sceneDraftRequest(
						"Plan a short three-scene film about restoring an old bicycle for a weekend ride. Use practical footage and an encouraging narrator."
					)
				)
			)
		);
		assert.ok(plan.scenes.length >= 3 && plan.scenes.length <= 8);
		assert.match(JSON.stringify(plan), /bicycle|bike/i);
		assert.ok(
			plan.scenes.every(
				(scene) => !/^the narrator|^narrator:/i.test(scene.script)
			),
			"Scripts must contain spoken text, not narrator instructions"
		);
		assert.ok(
			plan.scenes.every((scene) => scene.script.trim() && scene.prompt.trim())
		);
		process.stdout.write(
			`PASS: French captions ${JSON.stringify(translated.map((caption) => caption.text))}; ${plan.scenes.length} original scene drafts through Core/Gateway: ${JSON.stringify(plan.scenes)}.\n`
		);
	} finally {
		host.stop();
	}
});
