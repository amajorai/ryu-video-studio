import { describe, expect, test } from "bun:test";
import { detachClipAudio } from "../../../../shared/detach-audio.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import {
	pendingAudioDetachActions,
	RECOVER_AUDIO_ACTION,
	recoverableSelection,
	recoverSelectedAudio,
} from "./audio-detach.ts";

function setup(patch: (project: Project) => Project = (value) => value) {
	const video = testVideo("camera.mp4", 10);
	const audio: Asset = {
		...testVideo("camera audio", 10),
		derivation: "audio",
		derivedFromAssetId: video.id,
		height: 0,
		kind: "audio",
		width: 0,
	};
	const clip = newSegment(video, 0, 0);
	const plain = newSegment(video, 12, 0);
	const project: Project = {
		...newProject("Recover"),
		segments: [clip, plain],
	};
	const detached = patch(
		detachClipAudio(
			project,
			[video, audio],
			{ clipIds: [clip.id], revision: project.revision },
			() => audio
		)
	);
	const runtime = createTestRuntime(detached, [video, audio]);
	const routed: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		routed.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	const audioClip = detached.segments.find(
		(segment) => segment.assetId === audio.id
	);
	return { audioClip, clip, plain, routed, runtime };
}

function select(runtime: ReturnType<typeof setup>["runtime"], ids: string[]) {
	runtime.selectedIds = ids;
	runtime.selectedId = ids[0] ?? null;
	runtime.selectedSegment = runtime.project?.segments.find(
		(segment) => segment.id === ids[0]
	);
}

describe("recover detached audio action", () => {
	test("names each detached pair once and skips plain clips", () => {
		const { audioClip, clip, plain, runtime } = setup();
		select(runtime, [clip.id, audioClip?.id ?? "", plain.id]);
		expect(recoverableSelection(runtime)).toEqual([clip.id]);
	});

	test("routes reattach-audio for the selection", () => {
		const { audioClip, routed, runtime } = setup();
		select(runtime, [audioClip?.id ?? ""]);
		expect(recoverSelectedAudio(runtime)).toBeUndefined();
		expect(routed).toEqual([["reattach-audio", { clipIds: [audioClip?.id] }]]);
		expect(pendingAudioDetachActions[RECOVER_AUDIO_ACTION]).toBe(
			recoverSelectedAudio
		);
	});

	test("declines without detached audio and refuses locked tracks", () => {
		const { plain, routed, runtime } = setup();
		select(runtime, [plain.id]);
		expect(recoverSelectedAudio(runtime)).toBe(false);
		const locked = setup((project) =>
			updateTrackSetting(project, 0, { locked: true })
		);
		select(locked.runtime, [locked.clip.id]);
		locked.runtime.selectedTrackLocked = true;
		recoverSelectedAudio(locked.runtime);
		expect(lastStatus(locked.runtime)).toContain("Unlock");
		expect(routed).toEqual([]);
		expect(locked.routed).toEqual([]);
	});
});
