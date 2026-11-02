import { describe, expect, test } from "bun:test";
import { detachAudioState } from "../../../shared/detach-audio.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import {
	createTestRuntime,
	testProject,
	testVideo,
} from "../editor/test-runtime.ts";
import {
	CLIP_MENU_ACTIONS,
	type ClipMenuContext,
	type ClipMenuItem,
	clipMenuModel,
	flattenClipMenu,
	MAX_SWAP_CHOICES,
	NOT_AVAILABLE,
} from "./clip-menu.ts";
import {
	menuActionAvailable,
	recolorClip,
	renameClip,
	runClipMenuItem,
	runMenuAction,
} from "./clip-menu-commands.ts";

const audioAsset = (name = "music.wav"): Asset => ({
	...testVideo(name, 30),
	kind: "audio",
});

function context(overrides: Partial<ClipMenuContext> = {}): ClipMenuContext {
	const asset = overrides.asset ?? testVideo("camera.mp4", 20);
	const segment = overrides.segment ?? {
		...newSegment(asset, 2, 0),
		sourceOut: 4,
	};
	return {
		asset,
		assets: [asset],
		clipboardReady: false,
		hasHandler: () => true,
		locked: false,
		project: { ...newProject("Menu test"), segments: [segment] },
		segment,
		settingsReady: false,
		time: 0,
		...overrides,
	};
}

function item(sections: ReturnType<typeof clipMenuModel>, id: string) {
	const found = flattenClipMenu(sections).find(
		(candidate) => candidate.id === id
	);
	if (!found) {
		throw new Error(`No menu item ${id}.`);
	}
	return found;
}

const enabled = (entry: ClipMenuItem) => entry.disabledReason === undefined;

describe("clip menu model", () => {
	test("lists every planned group in order", () => {
		const sections = clipMenuModel(context());
		expect(sections.map((section) => section.id)).toEqual([
			"edit",
			"label",
			"audio",
			"media",
			"placement",
		]);
		expect(sections[0]?.items.map((entry) => entry.id)).toEqual([
			"split",
			"cut",
			"copy",
			"paste",
			"paste-settings",
			"duplicate",
			"select-track",
			"delete",
			"ripple-delete",
		]);
		expect(sections[4]?.items.map((entry) => entry.id)).toEqual([
			"reveal",
			"replace",
			"move-new-track",
			"duplicate-new-track",
			"nest",
			"ask-agent",
			"edit-with-ai",
		]);
	});

	test("actions without a handler are disabled as Not available", () => {
		const registered = new Set<string>([
			CLIP_MENU_ACTIONS.copy,
			CLIP_MENU_ACTIONS.split,
		]);
		const sections = clipMenuModel(
			context({ hasHandler: (action) => registered.has(action), time: 3 })
		);
		expect(enabled(item(sections, "copy"))).toBe(true);
		expect(enabled(item(sections, "split"))).toBe(true);
		for (const id of ["cut", "nest", "ask-agent", "edit-with-ai", "mute"]) {
			expect(item(sections, id).disabledReason).toBe(NOT_AVAILABLE);
		}
		// Menu commands do not depend on the action registry.
		expect(enabled(item(sections, "rename"))).toBe(true);
	});

	test("split uses the playhead inside the clip, else the pointer", () => {
		const atPlayhead = clipMenuModel(context({ time: 3 }));
		expect(item(atPlayhead, "split")).toMatchObject({
			label: "Split at playhead",
			run: { action: "split.selected", type: "action" },
		});
		const atPointer = clipMenuModel(context({ pointerTime: 4.5, time: 0 }));
		expect(item(atPointer, "split")).toMatchObject({
			label: "Split here",
			run: { command: "splitAtPointer", type: "command" },
		});
		expect(enabled(item(atPointer, "split"))).toBe(true);
		const nowhere = clipMenuModel(context({ time: 0 }));
		expect(item(nowhere, "split").disabledReason).toContain("playhead");
	});

	test("paste items need something copied", () => {
		const empty = clipMenuModel(context());
		expect(item(empty, "paste").disabledReason).toBe(
			"Copy or cut clips first."
		);
		expect(item(empty, "paste-settings").disabledReason).toBe(
			"Copy a clip or its settings first."
		);
		const settings = clipMenuModel(context({ settingsReady: true }));
		expect(enabled(item(settings, "paste-settings"))).toBe(true);
		expect(enabled(item(settings, "paste"))).toBe(false);
		const clips = clipMenuModel(context({ clipboardReady: true }));
		expect(enabled(item(clips, "paste"))).toBe(true);
		expect(enabled(item(clips, "paste-settings"))).toBe(true);
	});

	test("a locked track leaves only non-editing items enabled", () => {
		const other = testVideo("other.mp4", 8);
		const base = context();
		const sections = clipMenuModel({
			...base,
			assets: [...base.assets, other],
			clipboardReady: true,
			locked: true,
			time: 3,
		});
		const enabledIds = flattenClipMenu(sections)
			.filter(enabled)
			.map((entry) => entry.id);
		expect(enabledIds).toEqual([
			"copy",
			"paste",
			"duplicate",
			"select-track",
			"speed",
			"reveal",
			`swap-${other.id}`,
			"duplicate-new-track",
			"ask-agent",
		]);
	});

	test("audio and media items follow the clip's media", () => {
		const music = audioAsset();
		const audio = clipMenuModel(
			context({ asset: music, assets: [music], segment: newSegment(music) })
		);
		expect(enabled(item(audio, "mute"))).toBe(true);
		expect(item(audio, "hide").disabledReason).toContain("no picture");
		expect(item(audio, "detach-audio").disabledReason).toContain("video");
		expect(item(audio, "freeze-frame").disabledReason).toContain("video");
		expect(enabled(item(audio, "reverse"))).toBe(true);

		const camera = testVideo("camera.mp4", 20);
		const video = clipMenuModel(
			context({
				asset: camera,
				assets: [camera],
				segment: newSegment(camera),
				time: 1,
			})
		);
		expect(enabled(item(video, "detach-audio"))).toBe(true);
		expect(item(video, "freeze-frame").label).toBe("Freeze frame at playhead");

		const multicam = clipMenuModel(
			context({
				segment: {
					...newSegment(camera),
					multicamGroupId: crypto.randomUUID(),
				},
			})
		);
		expect(item(multicam, "reverse").disabledReason).toContain("Multicam");
		expect(item(multicam, "replace").disabledReason).toContain("multicam");
	});

	test("audio item follows the shared detach/recover state", () => {
		const camera = testVideo("camera.mp4", 20);
		const extracted: Asset = {
			...audioAsset("camera audio.wav"),
			derivation: "audio",
			derivedFromAssetId: camera.id,
		};
		const groupId = crypto.randomUUID();
		const videoClip: Segment = { ...newSegment(camera), linkGroupId: groupId };
		const audioClip: Segment = {
			...newSegment(extracted, 0, 1),
			linkGroupId: groupId,
		};
		const assets = [camera, extracted];
		const project: Project = {
			...newProject("Detached"),
			segments: [videoClip, audioClip],
		};
		for (const [segment, asset] of [
			[videoClip, camera],
			[audioClip, extracted],
		] as const) {
			expect(detachAudioState(project, assets, segment.id)).toBe("recover");
			const sections = clipMenuModel(
				context({ asset, assets, project, segment })
			);
			expect(item(sections, "recover-audio").run).toEqual({
				action: CLIP_MENU_ACTIONS.recoverAudio,
				type: "action",
			});
			expect(enabled(item(sections, "recover-audio"))).toBe(true);
			expect(
				flattenClipMenu(sections).some((entry) => entry.id === "detach-audio")
			).toBe(false);
		}

		// Videos linked for another reason were never detached: Detach stays.
		const other = testVideo("b-roll.mp4", 20);
		const linkGroupId = crypto.randomUUID();
		const s1: Segment = { ...newSegment(camera), linkGroupId };
		const s2: Segment = { ...newSegment(other, 0, 1), linkGroupId };
		const linkedProject: Project = {
			...newProject("Linked"),
			segments: [s1, s2],
		};
		expect(detachAudioState(linkedProject, [camera, other], s1.id)).toBe(
			"detach"
		);
		const linked = clipMenuModel(
			context({
				asset: camera,
				assets: [camera, other],
				project: linkedProject,
				segment: s1,
			})
		);
		expect(enabled(item(linked, "detach-audio"))).toBe(true);
		expect(
			flattenClipMenu(linked).some((entry) => entry.id === "recover-audio")
		).toBe(false);

		// Unavailable clips keep Detach with the shared refusal.
		const silent: Asset = { ...testVideo("silent.mp4", 20), hasAudio: false };
		const silentMenu = clipMenuModel(
			context({ asset: silent, assets: [silent], segment: newSegment(silent) })
		);
		expect(item(silentMenu, "detach-audio").disabledReason).toBe(
			"This video has no audio stream to extract."
		);
		const lockedMenu = clipMenuModel(context({ locked: true }));
		expect(item(lockedMenu, "detach-audio").disabledReason).toContain("Unlock");
	});

	test("toggles and colors report their current state", () => {
		const camera = testVideo("camera.mp4", 20);
		const segment: Segment = {
			...newSegment(camera),
			color: "teal",
			hidden: true,
		};
		const sections = clipMenuModel(
			context({ asset: camera, assets: [camera], segment })
		);
		expect(item(sections, "mute").checked).toBe(false);
		expect(item(sections, "hide").checked).toBe(true);
		const colors = item(sections, "color").children ?? [];
		expect(colors).toHaveLength(9);
		expect(
			colors.filter((entry) => entry.checked).map((entry) => entry.id)
		).toEqual(["color-teal"]);
		expect(colors[1]?.swatch).toMatch(/^#/);
		const fast = (patch: Partial<Segment>) =>
			item(
				clipMenuModel(
					context({
						asset: camera,
						assets: [camera],
						segment: { ...newSegment(camera), speed: 20, ...patch },
					})
				),
				"mute"
			).checked;
		// Above the high-speed threshold a clip is muted unless it opts in.
		expect(fast({})).toBe(true);
		expect(fast({ muted: false })).toBe(false);
	});

	test("replace media lists same-kind library media, capped", () => {
		const camera = testVideo("camera.mp4", 20);
		const others = Array.from({ length: MAX_SWAP_CHOICES + 3 }, (_, index) =>
			testVideo(`take-${index}.mp4`, 10)
		);
		const sections = clipMenuModel(
			context({
				asset: camera,
				assets: [camera, audioAsset(), ...others],
				segment: newSegment(camera),
			})
		);
		const choices = item(sections, "replace").children ?? [];
		expect(choices).toHaveLength(MAX_SWAP_CHOICES);
		expect(choices[0]).toMatchObject({
			label: "take-0.mp4",
			run: { assetId: others[0]?.id, type: "swap" },
		});
		const alone = clipMenuModel(context());
		expect(item(alone, "replace").disabledReason).toContain("Import");
		const missing = clipMenuModel(context({ asset: undefined }));
		expect(item(missing, "reveal").disabledReason).toContain("missing");
	});
});

function runtimeWith(project: Project, assets: Asset[], selected: string) {
	const runtime = createTestRuntime(project, assets);
	runtime.setSelected(selected);
	return runtime;
}

describe("clip menu commands", () => {
	test("registered actions run by id; unknown ids are unavailable", () => {
		const { asset, first, project } = testProject();
		const runtime = runtimeWith(project, [asset], first.id);
		expect(menuActionAvailable("clip.delete")).toBe(true);
		expect(menuActionAvailable("ai.notARealAction")).toBe(false);
		expect(menuActionAvailable("toString")).toBe(false);
		expect(runMenuAction("ai.notARealAction", runtime)).toBe(false);
		expect(runMenuAction("clip.delete", runtime)).toBe(true);
		expect(
			runtime.project?.segments.map((segment) => segment.id)
		).not.toContain(first.id);
	});

	test("Recover audio is registered and dispatches reattach-audio", async () => {
		expect(menuActionAvailable(CLIP_MENU_ACTIONS.recoverAudio)).toBe(true);
		expect(menuActionAvailable(CLIP_MENU_ACTIONS.detachAudio)).toBe(true);
		const camera = testVideo("camera.mp4", 20);
		const extracted: Asset = {
			...audioAsset("camera audio.wav"),
			derivation: "audio",
			derivedFromAssetId: camera.id,
		};
		const groupId = crypto.randomUUID();
		const videoClip: Segment = { ...newSegment(camera), linkGroupId: groupId };
		const audioClip: Segment = {
			...newSegment(extracted, 0, 1),
			linkGroupId: groupId,
		};
		const project: Project = {
			...newProject("Detached"),
			segments: [videoClip, audioClip],
		};
		const runtime = runtimeWith(project, [camera, extracted], audioClip.id);
		const bodies: [string, Record<string, unknown>][] = [];
		runtime.routeEdit = (action, body) => {
			bodies.push([action, body]);
			return Promise.resolve({ status: "error" });
		};
		runClipMenuItem(
			{ action: CLIP_MENU_ACTIONS.recoverAudio, type: "action" },
			{ onRename: () => undefined, runtime, segment: audioClip }
		);
		await Promise.resolve();
		expect(bodies).toEqual([["reattach-audio", { clipIds: [audioClip.id] }]]);
	});

	test("rename and color record one undo step each and skip no-ops", () => {
		const { asset, first, project } = testProject();
		const runtime = runtimeWith(project, [asset], first.id);
		expect(renameClip(runtime, first, "  Opening   shot ")).toBe(true);
		const renamed = runtime.project?.segments[0];
		expect(renamed?.label).toBe("Opening shot");
		expect(renameClip(runtime, renamed ?? first, "Opening shot")).toBe(false);
		expect(recolorClip(runtime, renamed ?? first, "blue")).toBe(true);
		const colored = runtime.project?.segments[0];
		expect(colored?.color).toBe("blue");
		expect(recolorClip(runtime, colored ?? first, undefined)).toBe(true);
		const cleared = runtime.project?.segments[0];
		expect(cleared && "color" in cleared).toBe(false);
		expect(renameClip(runtime, cleared ?? first, "   ")).toBe(true);
		const unlabeled = runtime.project?.segments[0];
		expect(unlabeled && "label" in unlabeled).toBe(false);
		expect(
			runtime.calls
				.filter(([name]) => name === "edit")
				.map(([, label]) => label)
		).toEqual(["Rename clip", "Color clip", "Clear clip color", "Rename clip"]);
	});

	test("route commands call the existing sidecar routes", async () => {
		const { asset, first, project } = testProject();
		const other = testVideo("other.mp4", 30);
		const runtime = runtimeWith(project, [asset, other], first.id);
		const bodies: [string, Record<string, unknown>][] = [];
		runtime.routeEdit = (action, body) => {
			bodies.push([action, body]);
			return Promise.resolve({ status: "error" });
		};
		const dispatch = { onRename: () => undefined, runtime, segment: first };
		runtime.time = 4;
		runClipMenuItem({ command: "freezeFrame", type: "command" }, dispatch);
		runtime.time = 0;
		runClipMenuItem({ command: "freezeFrame", type: "command" }, dispatch);
		runClipMenuItem({ command: "reverse", type: "command" }, dispatch);
		runClipMenuItem({ assetId: other.id, type: "swap" }, dispatch);
		await Promise.resolve();
		expect(bodies).toEqual([
			[
				"freeze-frame",
				{ at: 4, clipId: first.id, duration: 2, mode: "insert" },
			],
			[
				"freeze-frame",
				{ at: 0, clipId: first.id, duration: 2, mode: "hold-end" },
			],
			["reverse", { clipIds: [first.id] }],
			["swap-clip-media", { assetId: other.id, clipId: first.id }],
		]);
	});

	test("split here cuts the clip at the pointer; speed opens the tempo tools", () => {
		const { asset, first, project } = testProject();
		const runtime = runtimeWith(project, [asset], first.id);
		runtime.store.setState({ snapEnabled: false });
		let renamed = false;
		const dispatch = {
			onRename: () => {
				renamed = true;
			},
			pointerTime: 2.5,
			runtime,
			segment: first,
		};
		runClipMenuItem({ command: "splitAtPointer", type: "command" }, dispatch);
		expect(
			runtime.project?.segments
				.filter((segment) => segment.track === 0)
				.map((segment) => segment.start)
				.sort((left, right) => left - right)
		).toEqual([0, 2.5, 10]);
		runClipMenuItem({ command: "speed", type: "command" }, dispatch);
		expect(runtime.panel).toBe("tempo");
		runClipMenuItem({ command: "rename", type: "command" }, dispatch);
		expect(renamed).toBe(true);
	});

	test("move to new track moves the selection up as one step", () => {
		const { asset, first, project } = testProject();
		const runtime = runtimeWith(project, [asset], first.id);
		runClipMenuItem(
			{ command: "moveToNewTrack", type: "command" },
			{ onRename: () => undefined, runtime, segment: first }
		);
		expect(
			runtime.project?.segments.find((segment) => segment.id === first.id)
				?.track
		).toBe(1);
		expect(runtime.calls).toContainEqual(["edit", "Move to new track"]);
	});
});
