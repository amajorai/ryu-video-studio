import { describe, expect, test } from "bun:test";
import { type Asset, newProject, newSegment, type Project } from "./project.ts";
import {
	isProxyDerivative,
	matchRelinkBatch,
	offlineRenderMessage,
	projectAssetIds,
	projectRenderAssetIds,
	relinkBatchRequestSchema,
	relinkedAsset,
	relinkNameKey,
	relinkRequestSchema,
	renderedAssetIds,
	requiredSourceDuration,
	validateReplacement,
} from "./relink.ts";

function asset(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: 1080,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Interview.mp4",
		width: 1920,
		...overrides,
	};
}

describe("validateReplacement", () => {
	test("accepts the same kind within half a second", () => {
		const target = asset();
		expect(validateReplacement(target, asset({ duration: 10.5 }))).toEqual({
			ok: true,
			warnings: [],
		});
		expect(validateReplacement(target, asset({ duration: 9.5 })).ok).toBe(true);
	});

	test("refuses a duration outside the tolerance", () => {
		const result = validateReplacement(asset(), asset({ duration: 10.51 }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("10 s");
			expect(result.reason).toContain("10.51 s");
		}
	});

	test("refuses a different kind", () => {
		const result = validateReplacement(
			asset(),
			asset({ kind: "audio", name: "Interview.wav" })
		);
		expect(result).toMatchObject({ ok: false });
	});

	test("ignores duration for images", () => {
		const target = asset({ duration: 5, kind: "image", name: "Logo.png" });
		expect(validateReplacement(target, { ...target, duration: 0.04 }).ok).toBe(
			true
		);
	});

	test("refuses nested sequences", () => {
		const target = asset({ sequenceProjectId: crypto.randomUUID() });
		expect(validateReplacement(target, asset()).ok).toBe(false);
	});

	test("warns about lost audio and a new frame size", () => {
		const result = validateReplacement(
			asset(),
			asset({ hasAudio: false, height: 720, width: 1280 })
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(2);
			expect(result.warnings[1]).toContain("1920x1080 to 1280x720");
		}
	});
});

describe("relinkNameKey", () => {
	test("compares stems without extension, case or copy markers", () => {
		expect(relinkNameKey("Interview.MP4")).toBe("interview");
		expect(relinkNameKey("interview (2).mov")).toBe("interview");
		expect(relinkNameKey("Interview copy.mp4")).toBe("interview");
		expect(relinkNameKey("folder/B_roll-01.mp4")).toBe("b roll 01");
		expect(relinkNameKey(".hidden")).toBe("hidden");
	});
});

describe("matchRelinkBatch", () => {
	test("matches by name, then the closest duration, one source each", () => {
		const a = asset({ duration: 10, name: "Take.mp4" });
		const b = asset({ duration: 12, name: "Take.mp4" });
		const c = asset({ duration: 3, kind: "audio", name: "VO.wav" });
		const near = asset({ duration: 11.9, name: "take.mov" });
		const far = asset({ duration: 10.3, name: "Take (1).mp4" });
		const vo = asset({ duration: 3.2, kind: "audio", name: "vo.wav" });
		const stray = asset({ name: "Other.mp4" });
		const plan = matchRelinkBatch([a, b, c], [far, near, vo, stray]);
		expect(plan.matches).toEqual([
			{
				assetId: a.id,
				durationDelta: expect.closeTo(0.3),
				sourceAssetId: far.id,
			},
			{
				assetId: b.id,
				durationDelta: expect.closeTo(0.1),
				sourceAssetId: near.id,
			},
			{
				assetId: c.id,
				durationDelta: expect.closeTo(0.2),
				sourceAssetId: vo.id,
			},
		]);
		expect(plan.unmatched).toEqual([]);
		expect(plan.unusedSourceAssetIds).toEqual([stray.id]);
	});

	test("explains why an offline asset is left unmatched", () => {
		const missing = asset({ name: "Missing.mp4" });
		const tooLong = asset({ name: "Long.mp4" });
		const plan = matchRelinkBatch(
			[missing, tooLong],
			[asset({ duration: 20, name: "Long.mp4" })]
		);
		expect(plan.matches).toEqual([]);
		expect(plan.unmatched.map((entry) => entry.assetId)).toEqual([
			missing.id,
			tooLong.id,
		]);
		expect(plan.unmatched[0]?.reason).toContain("No replacement");
		expect(plan.unmatched[1]?.reason).toContain("lasts");
	});

	test("does not reuse a replacement for two offline assets", () => {
		const first = asset({ name: "Clip.mp4" });
		const second = asset({ name: "Clip.mp4" });
		const only = asset({ name: "Clip.mp4" });
		const plan = matchRelinkBatch([first, second], [only]);
		expect(plan.matches).toHaveLength(1);
		expect(plan.matches[0]?.assetId).toBe(first.id);
		expect(plan.unmatched[0]?.reason).toContain("used by another");
	});

	test("is independent of offline order for the chosen pairs", () => {
		const a = asset({ duration: 10, name: "X.mp4" });
		const b = asset({ duration: 10.4, name: "X.mp4" });
		const source = asset({ duration: 10.35, name: "X.mp4" });
		expect(matchRelinkBatch([a, b], [source]).matches[0]?.assetId).toBe(b.id);
		expect(matchRelinkBatch([b, a], [source]).matches[0]?.assetId).toBe(b.id);
	});
});

describe("relinked asset record", () => {
	test("keeps identity and takes the replacement's media properties", () => {
		const target = asset({
			folder: "Shoot",
			frameRate: 25,
			colorTransfer: "pq",
			name: "A.mp4",
		});
		const source = asset({
			duration: 9.8,
			frameRate: 30,
			hasAudio: false,
			height: 720,
			name: "A copy.mp4",
			width: 1280,
		});
		const next = relinkedAsset(target, source, 9.8);
		expect(next).toMatchObject({
			duration: 9.8,
			folder: "Shoot",
			frameRate: 30,
			hasAudio: false,
			height: 720,
			id: target.id,
			name: "A.mp4",
			width: 1280,
		});
		expect("colorTransfer" in next).toBe(false);
	});

	test("keeps the original duration when a clip reads past the replacement", () => {
		const target = asset({ duration: 10 });
		expect(relinkedAsset(target, asset({ duration: 9.6 }), 10).duration).toBe(
			10
		);
		expect(relinkedAsset(target, asset({ duration: 9.6 }), 9.62).duration).toBe(
			9.6
		);
	});

	test("finds the latest source time clips read", () => {
		const media = asset();
		const project = newProject("Edit");
		project.segments = [
			{ ...newSegment(media, 0), sourceIn: 1, sourceOut: 4 },
			{ ...newSegment(media, 5), sourceIn: 2, sourceOut: 7.5 },
		];
		expect(requiredSourceDuration(media.id, [project])).toBe(7.5);
		expect(requiredSourceDuration(crypto.randomUUID(), [project])).toBe(0);
	});
});

describe("renderedAssetIds", () => {
	test("follows nested sequences and survives cycles", () => {
		const inner = newProject("Inner");
		const outer = newProject("Outer");
		const leaf = asset({ name: "Leaf.mp4" });
		const top = asset({ name: "Top.mp4" });
		const innerSequence = asset({
			name: "Inner",
			sequenceProjectId: inner.id,
		});
		const outerSequence = asset({
			name: "Outer",
			sequenceProjectId: outer.id,
		});
		inner.segments = [newSegment(leaf, 0), newSegment(outerSequence, 10)];
		outer.segments = [newSegment(top, 0), newSegment(innerSequence, 10)];
		const assets = [leaf, top, innerSequence, outerSequence];
		expect(renderedAssetIds(outer.id, [inner, outer], assets).sort()).toEqual(
			[leaf.id, top.id].sort()
		);
		expect(renderedAssetIds(crypto.randomUUID(), [outer], assets)).toEqual([]);
	});

	test("includes backgrounds and lip-sync audio of nested projects", () => {
		const inner = newProject("Inner");
		const outer = newProject("Outer");
		const backdrop = asset({ kind: "image", name: "Backdrop.png" });
		const voice = asset({ kind: "audio", name: "Voice.wav" });
		const sequence = asset({ name: "Inner", sequenceProjectId: inner.id });
		inner.background = { assetId: backdrop.id, type: "image" };
		inner.avatars = [
			{ lipSync: { assetId: voice.id } } as Project["avatars"][number],
		];
		outer.segments = [newSegment(sequence, 0)];
		expect(
			renderedAssetIds(outer.id, [inner, outer], [backdrop, voice, sequence])
				.slice()
				.sort()
		).toEqual([backdrop.id, voice.id].sort());
	});
});

describe("project asset references", () => {
	function fullProject() {
		const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
		const [
			clip,
			bg,
			clipBg,
			voice,
			master,
			angle,
			scene,
			reference,
			cue,
			trackCue,
		] = ids as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const project = newProject("References");
		const segment = newSegment(asset({ id: clip }), 0);
		project.segments = [
			{ ...segment, background: { assetId: clipBg, type: "image" } },
		];
		project.background = { assetId: bg, type: "image" };
		project.avatars = [
			{ lipSync: { assetId: voice } } as Project["avatars"][number],
		];
		project.multicamGroups = [
			{
				masterAssetId: master,
				members: [{ assetId: angle }],
			} as Project["multicamGroups"][number],
		];
		project.scenes = [{ assetIds: [scene] } as Project["scenes"][number]];
		project.referenceProfile = {
			assetId: reference,
		} as Project["referenceProfile"];
		project.captions = [
			{
				end: 1,
				id: crypto.randomUUID(),
				sourceAssetId: cue,
				start: 0,
				text: "a",
			},
		];
		project.captionTracks = [
			{
				captions: [
					{
						end: 1,
						id: crypto.randomUUID(),
						sourceAssetId: trackCue,
						start: 0,
						text: "b",
					},
				],
				id: crypto.randomUUID(),
				label: "Second",
				language: "en",
			},
		];
		return { ids, project, render: [clip, bg, clipBg, voice] };
	}

	test("the render set is what the encode reads", () => {
		const { project, render } = fullProject();
		expect(projectRenderAssetIds(project).sort()).toEqual(render.sort());
	});

	test("every asset-bearing field is a reference", () => {
		const { ids, project } = fullProject();
		expect(projectAssetIds(project).sort()).toEqual(ids.sort());
		expect(projectAssetIds(newProject("Empty"))).toEqual([]);
	});

	test("proxies are recognised by derivation", () => {
		expect(isProxyDerivative(asset({ derivation: "proxy" }))).toBe(true);
		expect(isProxyDerivative(asset())).toBe(false);
	});
});

describe("contracts", () => {
	test("request schemas are strict and bounded", () => {
		const id = crypto.randomUUID();
		expect(relinkRequestSchema.parse({ sourceAssetId: id })).toEqual({
			sourceAssetId: id,
		});
		expect(() =>
			relinkRequestSchema.parse({ extra: true, sourceAssetId: id })
		).toThrow();
		expect(() =>
			relinkBatchRequestSchema.parse({ sourceAssetIds: [] })
		).toThrow();
		expect(() =>
			relinkBatchRequestSchema.parse({
				sourceAssetIds: Array.from({ length: 201 }, () => id),
			})
		).toThrow();
		expect(
			relinkBatchRequestSchema.parse({
				sourceAssetIds: [id],
				targetAssetIds: [id],
			})
		).toEqual({ sourceAssetIds: [id], targetAssetIds: [id] });
		expect(() =>
			relinkBatchRequestSchema.parse({
				sourceAssetIds: [id],
				targetAssetIds: [],
			})
		).toThrow();
	});

	test("render refusal message lists names and truncates", () => {
		expect(offlineRenderMessage(["a.mp4"])).toBe(
			'Relink offline media before exporting: "a.mp4".'
		);
		expect(offlineRenderMessage(["1", "2", "3", "4", "5", "6", "7"])).toContain(
			"and 2 more"
		);
	});
});
