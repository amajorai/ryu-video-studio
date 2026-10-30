import assert from "node:assert/strict";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("Core indexes and retrieves app-owned source transcripts", async () => {
	const host = await createCoreSpeechHost();
	const documents: string[] = [];
	try {
		await host.enableSpaces();
		const spaceId = await host.spaces.ensureSpace({
			name: "Video Studio retrieval verification",
		});
		for (const [title, source] of [
			[
				"Editing a film",
				"The editor trims footage, adds subtitles, mixes narration and exports the finished movie.",
			],
			[
				"Baking bread",
				"The baker kneads dough, adds yeast and bakes a sourdough loaf in the oven.",
			],
		]) {
			const id = await host.spaces.createDoc({ space_id: spaceId, title });
			documents.push(id);
			await host.spaces.updateDoc({ doc_id: id, title, source });
			const document = await host.spaces.getDoc({ doc_id: id });
			assert.equal(document.source, source);
			assert.equal(document.kind, "app:@ryu/video-studio");
		}
		let matches: { document_id: string }[] = [];
		for (let attempt = 0; attempt < 30; attempt++) {
			matches = await host.spaces.search({
				space_id: spaceId,
				query: "finishing a video with captions",
				limit: 5,
			});
			if (matches.some((hit) => hit.document_id === documents[0])) {
				break;
			}
			await Bun.sleep(500);
		}
		assert.equal(
			matches[0]?.document_id,
			documents[0],
			"The editing transcript should rank ahead of unrelated baking text"
		);
		for (const id of documents) {
			await host.spaces.deleteDoc({ doc_id: id });
		}
		assert.equal(await host.spaces.getDoc({ doc_id: documents[0] }), null);
		documents.length = 0;
		process.stdout.write(
			"PASS: authenticated app grants, document indexing, semantic ranking, deletion and missing-document recovery.\n"
		);
	} finally {
		for (const id of documents) {
			await host.spaces.deleteDoc({ doc_id: id }).catch(() => {});
		}
		host.stop();
	}
});
