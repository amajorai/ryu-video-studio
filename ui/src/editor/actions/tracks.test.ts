import { describe, expect, test } from "bun:test";
import {
	newSegment,
	type Project,
	trackSettingFor,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import { trackOrderFor } from "../../../../shared/track-edits.ts";
import { runAction } from "../../shortcuts/registry.ts";
import { createTestRuntime, testProject, testVideo } from "../test-runtime.ts";
import {
	addTrackAt,
	removeTrackAt,
	setTrackHeight,
	toggleClipFlag,
	toggleTrackHidden,
	toggleTrackSyncLock,
} from "./tracks.ts";

function select(runtime: ReturnType<typeof createTestRuntime>, ids: string[]) {
	runtime.store.setState({
		selection: { overlayIds: [], primaryId: ids[0] ?? null, segmentIds: ids },
	});
	runtime.refresh();
}

const segmentById = (project: Project | null, id: string) =>
	project?.segments.find((segment) => segment.id === id);

describe("clip mute and hide actions", () => {
	test("Shift+M toggles mute on the selection in one undo step", () => {
		const { asset, first, project, second } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		select(runtime, [first.id, second.id]);
		expect(runAction("tracks.toggleClipMute", runtime)).toBe(true);
		expect(segmentById(runtime.project, first.id)?.muted).toBe(true);
		expect(segmentById(runtime.project, second.id)?.muted).toBe(true);
		runtime.undo();
		expect(segmentById(runtime.project, first.id)).toEqual(first);
	});

	test("clearing a flag removes the key so the clip is byte-identical", () => {
		const { asset, first, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		select(runtime, [first.id]);
		runAction("tracks.toggleClipHidden", runtime);
		expect(segmentById(runtime.project, first.id)?.hidden).toBe(true);
		runAction("tracks.toggleClipHidden", runtime);
		expect(segmentById(runtime.project, first.id)).toEqual(first);
		expect(
			Object.hasOwn(segmentById(runtime.project, first.id) ?? {}, "hidden")
		).toBe(false);
	});

	test("a mixed selection turns the flag on for every clip", () => {
		const { first, project, second } = testProject();
		const mixed = {
			...project,
			segments: [{ ...first, muted: true }, second],
		};
		const next = toggleClipFlag(mixed, [first.id, second.id], "muted");
		expect(next?.segments.every((segment) => segment.muted)).toBe(true);
	});

	test("toggling mute on a high-speed clip keeps its keep-audio opt-in", () => {
		const { first, project } = testProject();
		const fast = { ...first, muted: false, speed: 20 };
		const kept = { ...project, segments: [fast] };
		const muted = toggleClipFlag(kept, [first.id], "muted");
		expect(muted?.segments[0]?.muted).toBe(true);
		const unmuted = muted && toggleClipFlag(muted, [first.id], "muted");
		// Unmuting restores the opt-in; dropping the key would mute it again.
		expect(unmuted?.segments[0]?.muted).toBe(false);
		// A clip above the threshold with no opt-in is already silent, so the
		// toggle unmutes it (opts it in) rather than muting it again.
		const silentByDefault = { ...project, segments: [{ ...first, speed: 20 }] };
		expect(
			toggleClipFlag(silentByDefault, [first.id], "muted")?.segments[0]?.muted
		).toBe(false);
	});

	test("clips on locked tracks are left alone and nothing selected declines", () => {
		const { asset, first, project } = testProject();
		const locked = updateTrackSetting(project, 0, { locked: true });
		expect(toggleClipFlag(locked, [first.id], "muted")).toBeNull();
		const runtime = createTestRuntime(project, [asset]);
		expect(runAction("tracks.toggleClipMute", runtime)).toBe(false);
	});
});

describe("track header actions", () => {
	test("toggle the track eye and sync lock", () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		toggleTrackHidden(runtime, 1);
		toggleTrackSyncLock(runtime, 1);
		expect(trackSettingFor(runtime.project as Project, 1)).toMatchObject({
			hidden: true,
			syncLocked: false,
		});
		toggleTrackSyncLock(runtime, 1);
		expect(trackSettingFor(runtime.project as Project, 1).syncLocked).toBe(
			true
		);
	});

	test("set the lane height only when it changes", () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		setTrackHeight(runtime, 0, "medium");
		expect(runtime.project).toBe(project);
		setTrackHeight(runtime, 0, "small");
		expect(trackSettingFor(runtime.project as Project, 0).height).toBe("small");
	});

	test("add and remove tracks, reporting refusals as status", () => {
		const video = testVideo();
		const clip = newSegment(video, 0, 1);
		const project: Project = { ...testProject().project, segments: [clip] };
		const runtime = createTestRuntime(project, [video]);
		addTrackAt(runtime, 1);
		expect(segmentById(runtime.project, clip.id)?.track).toBe(2);
		expect(trackOrderFor(runtime.project as Project)).toEqual([0, 1, 2]);
		expect(
			runtime.project?.segments.some((segment) => segment.track === 1)
		).toBe(false);
		removeTrackAt(runtime, 2);
		expect(runtime.calls).toContainEqual([
			"setStatus",
			"Track 3 has 1 clip. Remove them first or force the removal.",
		]);
		removeTrackAt(runtime, 2, true);
		expect(runtime.project?.segments).toEqual([]);
	});
});
