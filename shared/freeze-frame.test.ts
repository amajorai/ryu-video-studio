import { describe, expect, test } from "bun:test";
import { freezeFrame, planFreezeFrame } from "./freeze-frame.ts";
import { newProject, newSegment, projectDuration } from "./project.ts";

function asset(id: string, kind: "video" | "audio" | "image" = "video") {
	return {
		id,
		name: id,
		kind,
		duration: kind === "image" ? 0 : 8,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: kind !== "image",
		createdAt: new Date().toISOString(),
	};
}

function title(start: number, end: number) {
	return {
		id: crypto.randomUUID(),
		start,
		end,
		text: "Title",
		x: 0.5,
		y: 0.5,
		fontSize: 0.05,
		color: "#ffffff",
		fadeIn: 0,
		fadeOut: 0,
		animation: "fade" as const,
	};
}

function fixture() {
	const video = asset(crypto.randomUUID());
	const still = asset(crypto.randomUUID(), "image");
	const clip = newSegment(video, 0, 0);
	clip.sourceIn = 1;
	clip.sourceOut = 5;
	const later = newSegment(video, 4, 0);
	later.sourceOut = 2;
	const project = { ...newProject("Freeze"), segments: [clip, later] };
	return { clip, later, project, still, video };
}

describe("freeze frame", () => {
	test("splits the clip and inserts the still with ripple", () => {
		const { clip, later, project, still, video } = fixture();
		project.titles = [title(3, 5)];
		project.markers = [
			{ id: crypto.randomUUID(), time: 4.5, label: "Beat", color: "#ffcc00" },
		];
		const request = {
			at: 2,
			clipId: clip.id,
			duration: 1.5,
			mode: "insert" as const,
			revision: project.revision,
		};
		expect(planFreezeFrame(project, [video], request).sourceTime).toBe(3);
		const next = freezeFrame(project, [video], request, still);
		expect(
			next.segments.map((segment) => [
				segment.assetId === still.id ? "still" : "video",
				segment.start,
				segment.sourceIn,
				segment.sourceOut,
			])
		).toEqual([
			["video", 0, 1, 3],
			["still", 2, 0, 1.5],
			["video", 3.5, 3, 5],
			["video", 5.5, 0, 2],
		]);
		expect(next.segments.find((s) => s.id === later.id)?.start).toBe(5.5);
		expect(next.titles[0]?.start).toBe(4.5);
		expect(next.titles[0]?.end).toBe(6.5);
		expect(next.markers[0]?.time).toBe(6);
		expect(projectDuration(next)).toBe(7.5);
	});

	test("copies the clip look and resolves animation at the frozen time", () => {
		const { clip, project, still, video } = fixture();
		clip.crop = { bottom: 0.1, left: 0.2, right: 0, top: 0 };
		clip.colorGrade = { exposure: 0.5, temperature: 0, tint: 0, vibrance: 0 };
		clip.effects = [{ amount: 0.4, enabled: true, type: "vignette" }];
		clip.saturation = 1.4;
		clip.keyframes = [
			{ id: crypto.randomUUID(), property: "scale", time: 0, value: 1 },
			{ id: crypto.randomUUID(), property: "scale", time: 4, value: 2 },
		];
		const next = freezeFrame(
			project,
			[video],
			{
				at: 2,
				clipId: clip.id,
				duration: 1,
				mode: "insert",
				revision: project.revision,
			},
			still
		);
		const frozen = next.segments.find((s) => s.assetId === still.id);
		expect(frozen?.scale).toBe(1.5);
		expect(frozen?.keyframes).toEqual([]);
		expect(frozen?.crop).toEqual(clip.crop);
		expect(frozen?.colorGrade.exposure).toBe(0.5);
		expect(frozen?.effects).toEqual(clip.effects);
		expect(frozen?.saturation).toBe(1.4);
	});

	test("hold-end appends the last frame after the clip", () => {
		const { clip, project, still, video } = fixture();
		const request = {
			at: 0,
			clipId: clip.id,
			duration: 2,
			mode: "hold-end" as const,
			revision: project.revision,
		};
		expect(planFreezeFrame(project, [video], request).sourceTime).toBe(4.96);
		const next = freezeFrame(project, [video], request, still);
		expect(
			next.segments.map((segment) => [
				segment.assetId === still.id ? "still" : "video",
				segment.start,
			])
		).toEqual([
			["video", 0],
			["still", 4],
			["video", 6],
		]);
	});

	test("rejects locked tracks, non-video clips and non-image stills", () => {
		const { clip, project, still, video } = fixture();
		const request = {
			at: 2,
			clipId: clip.id,
			duration: 1,
			mode: "insert" as const,
			revision: project.revision,
		};
		expect(() => freezeFrame(project, [video], request, video)).toThrow(
			"captured still"
		);
		const locked = {
			...project,
			trackSettings: [
				{ locked: true, muted: false, name: "V1", solo: false, track: 0 },
			],
		};
		expect(() => freezeFrame(locked, [video], request, still)).toThrow(
			"Unlock"
		);
		const audio = asset(crypto.randomUUID(), "audio");
		const audioClip = newSegment(audio, 0, 1);
		const withAudio = { ...project, segments: [audioClip] };
		expect(() =>
			freezeFrame(
				withAudio,
				[audio],
				{ ...request, clipId: audioClip.id },
				still
			)
		).toThrow("video clips");
		expect(() =>
			freezeFrame(project, [video], { ...request, at: 7 }, still)
		).toThrow("inside the clip");
	});

	test("linked audio partner gets a gap and keeps its link on both sides", () => {
		const video = asset(crypto.randomUUID());
		const audio = asset(crypto.randomUUID(), "audio");
		const still = asset(crypto.randomUUID(), "image");
		const groupId = crypto.randomUUID();
		const videoClip = { ...newSegment(video, 0, 0), linkGroupId: groupId };
		videoClip.sourceOut = 4;
		const audioClip = { ...newSegment(audio, 0, 1), linkGroupId: groupId };
		audioClip.sourceOut = 4;
		const project = {
			...newProject("Linked freeze"),
			segments: [videoClip, audioClip],
		};
		const next = freezeFrame(
			project,
			[video, audio],
			{
				at: 1,
				clipId: videoClip.id,
				duration: 2,
				mode: "insert",
				revision: project.revision,
			},
			still
		);
		const audioParts = next.segments.filter((s) => s.assetId === audio.id);
		expect(audioParts.map((s) => [s.start, s.sourceIn, s.sourceOut])).toEqual([
			[0, 0, 1],
			[3, 1, 4],
		]);
		const left = next.segments.filter((s) => s.start === 0);
		const right = next.segments.filter((s) => s.start === 3);
		expect(left.every((s) => s.linkGroupId === groupId)).toBe(true);
		expect(right[0]?.linkGroupId).toBeTruthy();
		expect(right.every((s) => s.linkGroupId === right[0]?.linkGroupId)).toBe(
			true
		);
		expect(right[0]?.linkGroupId).not.toBe(groupId);
		expect(
			next.segments.find((s) => s.assetId === still.id)?.linkGroupId
		).toBeUndefined();
	});

	test("a playhead at the clip edge inserts without a sliver split", () => {
		const { clip, project, still, video } = fixture();
		const next = freezeFrame(
			project,
			[video],
			{
				at: 0.01,
				clipId: clip.id,
				duration: 1,
				mode: "insert",
				revision: project.revision,
			},
			still
		);
		expect(next.segments).toHaveLength(3);
		expect(next.segments[0]?.assetId).toBe(still.id);
		expect(next.segments[1]?.start).toBe(1);
	});

	test("frame-aligned segments near the playhead never fail to split", () => {
		const video = asset(crypto.randomUUID());
		const audio = asset(crypto.randomUUID(), "audio");
		const still = asset(crypto.randomUUID(), "image");
		for (let frame = 1; frame < 200; frame += 1) {
			const clip = newSegment(video, 0, 0);
			const sound = newSegment(audio, frame * 0.04, 1);
			sound.sourceOut = 0.5;
			const project = {
				...newProject("Aligned"),
				segments: [clip, sound],
			};
			expect(() =>
				freezeFrame(
					project,
					[video, audio],
					{
						at: (frame + 1) * 0.04,
						clipId: clip.id,
						duration: 1,
						mode: "insert",
						revision: project.revision,
					},
					still
				)
			).not.toThrow();
		}
	});

	test("hold-end captures inside the media when sourceOut overruns it", () => {
		const { clip, project, video } = fixture();
		clip.sourceIn = 5;
		clip.sourceOut = 8.05;
		const plan = planFreezeFrame(project, [video], {
			at: 0,
			clipId: clip.id,
			duration: 1,
			mode: "hold-end",
			revision: project.revision,
		});
		expect(plan.sourceTime).toBeCloseTo(7.96, 9);
	});

	test("refuses multicam clips and ripples later multicam groups", () => {
		const { clip, later, project, still, video } = fixture();
		const other = asset(crypto.randomUUID());
		const groupId = crypto.randomUUID();
		const group = {
			duration: 2,
			id: groupId,
			masterAssetId: video.id,
			members: [
				{
					assetId: video.id,
					kind: "both" as const,
					label: "A",
					offsetSeconds: 0,
				},
				{
					assetId: other.id,
					kind: "angle" as const,
					label: "B",
					offsetSeconds: 0,
				},
			],
			name: "Cam",
			segmentIds: [later.id],
			start: 4,
			switches: [
				{ angle: "A", end: 5, start: 4 },
				{ angle: "B", end: 6, start: 5 },
			],
		};
		const grouped = {
			...project,
			multicamGroups: [group],
			segments: [clip, { ...later, multicamGroupId: groupId }],
		};
		const request = {
			at: 2,
			clipId: clip.id,
			duration: 1,
			mode: "insert" as const,
			revision: project.revision,
		};
		const next = freezeFrame(grouped, [video, other], request, still);
		expect(next.multicamGroups[0]?.start).toBe(5);
		expect(next.multicamGroups[0]?.switches).toEqual([
			{ angle: "A", end: 6, start: 5 },
			{ angle: "B", end: 7, start: 6 },
		]);
		expect(() =>
			freezeFrame(
				grouped,
				[video, other],
				{ ...request, at: 5, clipId: later.id },
				still
			)
		).toThrow("multicam");
		const cut = {
			...grouped,
			multicamGroups: [
				{
					...group,
					start: 0,
					duration: 6,
					switches: [{ angle: "A", end: 6, start: 0 }],
				},
			],
			segments: [clip, { ...later, multicamGroupId: groupId }],
		};
		expect(() => freezeFrame(cut, [video, other], request, still)).toThrow(
			"multicam"
		);
	});

	test("the still keeps flips and fit and bakes scale X/Y (W2-V2)", () => {
		const { clip, project, still, video } = fixture();
		clip.flipH = true;
		clip.fit = "fill";
		clip.scaleY = 0.5;
		clip.keyframes = [
			{ id: crypto.randomUUID(), property: "scaleX", time: 0, value: 1 },
			{ id: crypto.randomUUID(), property: "scaleX", time: 2, value: 3 },
		];
		const next = freezeFrame(
			project,
			[video],
			{
				at: 1,
				clipId: clip.id,
				duration: 1,
				mode: "insert",
				revision: project.revision,
			},
			still
		);
		const frozen = next.segments.find((s) => s.assetId === still.id);
		expect(frozen?.flipH).toBe(true);
		expect(frozen?.flipV).toBeUndefined();
		expect(frozen?.fit).toBe("fill");
		expect(frozen?.scaleX).toBe(2);
		expect(frozen?.scaleY).toBe(0.5);
		expect(frozen?.keyframes).toEqual([]);
	});

	test("a legacy clip's still has no flip, scale X/Y or fit fields", () => {
		const { clip, project, still, video } = fixture();
		const next = freezeFrame(
			project,
			[video],
			{
				at: 1,
				clipId: clip.id,
				duration: 1,
				mode: "insert",
				revision: project.revision,
			},
			still
		);
		const frozen = next.segments.find((s) => s.assetId === still.id);
		for (const key of ["flipH", "flipV", "fit", "scaleX", "scaleY"]) {
			expect(frozen).not.toHaveProperty(key);
		}
	});
});
