import { expect, test } from "bun:test";
import { searchMedia } from "./media-search.ts";

test("searchMedia returns current transcript ranges by spoken terms", () => {
	const assetId = crypto.randomUUID();
	const asset = {
		createdAt: new Date().toISOString(),
		duration: 12,
		hasAudio: true,
		height: 180,
		id: assetId,
		kind: "video" as const,
		name: "Harbor take",
		width: 320,
	};
	const source = JSON.stringify({
		assetId,
		end: 6,
		format: "ryu.video-studio.transcript.v1",
		start: 2,
		text: "A wide harbor shot at sunset",
		transcriptRevision: 1,
	});
	const result = searchMedia(
		[
			{
				assetId,
				current: true,
				entries: [
					{
						docId: "doc-1",
						key: "1:0",
						ready: true,
						source,
						title: "Harbor take · 2.0–6.0s",
					},
				],
				obsolete: [],
				revision: 1,
				spaceId: "space-1",
				spaceName: "Video Studio",
				transcriptRevision: 1,
				updatedAt: new Date().toISOString(),
			},
		],
		[asset],
		{ q: "harbor sunset", limit: 10 }
	);
	expect(result).toMatchObject({
		query: "harbor sunset",
		results: [
			{
				assetId,
				assetName: "Harbor take",
				docId: "doc-1",
				end: 6,
				start: 2,
			},
		],
	});
});
