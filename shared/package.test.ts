import { describe, expect, test } from "bun:test";
import { projectArchivePackage, projectPackage } from "./package.ts";
import { type Asset, newProject, newSegment } from "./project.ts";
import type { ImportedFont } from "./schema/font.ts";

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

	test("credits the online fonts it uses like the credits route and the archive", () => {
		const font: ImportedFont = {
			createdAt: "2026-10-18T10:00:00.000Z",
			family: "Noto Sans JP",
			format: "truetype",
			id: crypto.randomUUID(),
			name: "Noto Sans JP",
			origin: {
				attribution: "Google",
				identifier: "noto-sans-jp:japanese-400-normal",
				license: "OFL-1.1",
				licenseUrl: "https://openfontlicense.org",
				pageUrl: "https://fontsource.org/fonts/noto-sans-jp",
				provider: "fontsource",
			},
			size: 1000,
		};
		const unused: ImportedFont = {
			...font,
			family: "Unused",
			id: crypto.randomUUID(),
		};
		const project = newProject("Font credits");
		project.titles = [
			{
				animation: "fade",
				color: "#ffffff",
				customFont: { family: font.family, id: font.id },
				end: 2,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.1,
				fontWeight: 400,
				id: crypto.randomUUID(),
				start: 0,
				text: "こんにちは",
				x: 0.5,
				y: 0.5,
			},
		];
		const bundle = projectPackage(project, [], [font, unused]);
		expect(bundle.credits.fonts?.map((entry) => entry.family)).toEqual([
			"Noto Sans JP",
		]);
		expect(bundle.credits.fonts?.[0]?.origin.license).toBe("OFL-1.1");
		expect(bundle.fonts).toBeUndefined();
		expect(bundle.credits).toEqual(
			projectArchivePackage(project, [], { fonts: [font], luts: [] }).credits
		);
	});
});
