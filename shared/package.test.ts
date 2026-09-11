import { describe, expect, test } from "bun:test";
import { projectPackage } from "./package.ts";
import { type Asset, newProject, newSegment } from "./project.ts";

function sourceAsset(): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 4,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Wikimedia source",
		origin: {
			attribution: "Open source filmmaker",
			identifier: "commons:clip-1",
			licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
			pageUrl: "https://commons.wikimedia.org/wiki/File:clip-1",
			provider: "wikimedia.commons",
			rights: "CC BY 4.0",
		},
		width: 640,
	};
}

describe("editable production package", () => {
	test("includes only referenced assets and provenance credits", () => {
		const project = newProject("Package proof");
		const used = sourceAsset();
		const unused = { ...sourceAsset(), name: "Unused" };
		project.segments = [newSegment(used)];
		const bundle = projectPackage(project, [used, unused]);
		expect(bundle.format).toBe("ryu.video-studio.package.v1");
		expect(bundle.project.title).toBe("Package proof");
		expect(bundle.assets.map((asset) => asset.id)).toEqual([used.id]);
		expect(bundle.credits.entries[0]?.identifier).toBe("commons:clip-1");
	});
});
