import { describe, expect, test } from "bun:test";
import { manageClipLinks } from "./clip-links.ts";
import {
	detachAllClipAudio,
	detachAudioState,
	detachableClipIds,
	detachClipAudio,
	detachedAudioPairs,
	hasExtractableAudio,
	reattachAudio,
	recoverableClipIds,
	recoverBlockingTrack,
} from "./detach-audio.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	updateTrackSetting,
	validateProject,
} from "./project.ts";

function videoAsset(hasAudio = true): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Camera",
		width: 640,
	};
}

function extractedAudio(video: Asset): Asset {
	return {
		createdAt: new Date().toISOString(),
		derivation: "audio",
		derivedFromAssetId: video.id,
		duration: video.duration,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: `${video.name} audio`,
		width: 0,
	};
}

function cameraClip(video: Asset, start = 0, track = 0): Segment {
	return {
		...newSegment(video, start, track),
		sourceIn: 1,
		sourceOut: 5,
		speed: 2,
		volume: 0.8,
		fadeIn: 0.25,
		fadeOut: 0.5,
		duckUnderVoice: true,
		audioProcessing: "denoise",
		keyframes: [
			{ id: crypto.randomUUID(), property: "volume", time: 1, value: 0.4 },
			{ id: crypto.randomUUID(), property: "scale", time: 1, value: 1.2 },
		],
	};
}

describe("detach audio", () => {
	test("copies timing and volume onto a linked audio clip and mutes the video", () => {
		const video = videoAsset();
		const audio = extractedAudio(video);
		const clip = cameraClip(video, 2);
		const project = { ...newProject("Detach"), segments: [clip] };
		const next = detachClipAudio(
			project,
			[video, audio],
			{ clipIds: [clip.id], revision: project.revision },
			(id) => (id === video.id ? audio : undefined)
		);
		const muted = next.segments.find((segment) => segment.id === clip.id);
		const detached = next.segments.find((segment) => segment.id !== clip.id);
		expect(muted?.volume).toBe(0);
		expect(muted?.keyframes.map((frame) => frame.property)).toEqual(["scale"]);
		expect(detached).toMatchObject({
			assetId: audio.id,
			audioProcessing: "denoise",
			duckUnderVoice: true,
			fadeIn: 0.25,
			fadeOut: 0.5,
			sourceIn: 1,
			sourceOut: 5,
			speed: 2,
			start: 2,
			track: 1,
			volume: 0.8,
		});
		expect(detached?.keyframes).toHaveLength(1);
		expect(detached?.keyframes[0]).toMatchObject({
			property: "volume",
			time: 1,
			value: 0.4,
		});
		expect(detached?.linkGroupId).toBeTruthy();
		expect(detached?.linkGroupId).toBe(muted?.linkGroupId);
		expect(() => validateProject(next, [video, audio])).not.toThrow();
	});

	test("rejects a clip whose media has no audio", () => {
		const video = videoAsset(false);
		const audio = extractedAudio(video);
		const clip = newSegment(video);
		const project = { ...newProject("Silent"), segments: [clip] };
		expect(() =>
			detachClipAudio(
				project,
				[video, audio],
				{ clipIds: [clip.id], revision: 0 },
				() => audio
			)
		).toThrow("embedded audio");
	});

	test("rejects a clip on a locked track", () => {
		const video = videoAsset();
		const audio = extractedAudio(video);
		const clip = newSegment(video);
		const project = updateTrackSetting(
			{ ...newProject("Locked"), segments: [clip] },
			0,
			{ locked: true }
		);
		expect(() =>
			detachClipAudio(
				project,
				[video, audio],
				{ clipIds: [clip.id], revision: 0 },
				() => audio
			)
		).toThrow("Unlock");
	});

	test("rejects audio that was not extracted from the clip's media", () => {
		const video = videoAsset();
		const unrelated = extractedAudio(videoAsset());
		const clip = newSegment(video);
		const project = { ...newProject("Wrong audio"), segments: [clip] };
		expect(() =>
			detachClipAudio(
				project,
				[video, unrelated],
				{ clipIds: [clip.id], revision: 0 },
				() => unrelated
			)
		).toThrow("Extract the clip audio");
	});

	test("leaves a clip already linked to audio unchanged", () => {
		const video = videoAsset();
		const audio = extractedAudio(video);
		const clip = newSegment(video);
		const partner = newSegment(audio, 0, 1);
		const project = manageClipLinks(
			{ ...newProject("Linked"), segments: [clip, partner] },
			[video, audio],
			{ action: "link", clipIds: [clip.id, partner.id], revision: 0 }
		);
		const next = detachClipAudio(
			project,
			[video, audio],
			{ clipIds: [clip.id], revision: project.revision },
			() => audio
		);
		expect(next.segments).toEqual(project.segments);
		expect(detachableClipIds(project, [video, audio])).toEqual([]);
	});

	test("places audio on the first free track below the visuals", () => {
		const video = videoAsset();
		const music: Asset = { ...extractedAudio(videoAsset()), name: "Music" };
		const audio = extractedAudio(video);
		const clip = newSegment(video, 0, 0);
		const overlay = { ...newSegment(video, 6, 2), volume: 0 };
		const bed = newSegment(music, 1, 3);
		const project = { ...newProject("Tracks"), segments: [clip, overlay, bed] };
		const next = detachClipAudio(
			project,
			[video, audio, music],
			{ clipIds: [clip.id], revision: 0 },
			() => audio
		);
		const detached = next.segments.find(
			(segment) => segment.assetId === audio.id
		);
		expect(detached?.track).toBe(4);
		expect(() =>
			detachClipAudio(
				project,
				[video, audio, music],
				{ audioTrack: 3, clipIds: [clip.id], revision: 0 },
				() => audio
			)
		).toThrow("already has a clip");
	});

	test("detaches every unlinked camera clip without colliding and keeps groups of two", () => {
		const first = videoAsset();
		const second = videoAsset();
		const firstAudio = extractedAudio(first);
		const secondAudio = extractedAudio(second);
		const a = newSegment(first, 0, 0);
		const b = newSegment(second, 4, 0);
		const project = { ...newProject("Batch"), segments: [a, b] };
		const assets = [first, second, firstAudio, secondAudio];
		const next = detachAllClipAudio(project, assets, (id) =>
			[firstAudio, secondAudio].find((audio) => audio.derivedFromAssetId === id)
		);
		const audioClips = next.segments.filter(
			(segment) =>
				segment.assetId === firstAudio.id || segment.assetId === secondAudio.id
		);
		expect(audioClips.map((segment) => segment.track)).toEqual([1, 2]);
		const groups = new Map<string, number>();
		for (const segment of next.segments) {
			if (segment.linkGroupId) {
				groups.set(
					segment.linkGroupId,
					(groups.get(segment.linkGroupId) ?? 0) + 1
				);
			}
		}
		expect([...groups.values()]).toEqual([2, 2]);
		expect(detachableClipIds(next, assets)).toEqual([]);
	});

	test("clips the audio member to a shorter extracted stream", () => {
		const video = videoAsset();
		const audio = { ...extractedAudio(video), duration: 7.5 };
		const clip = { ...newSegment(video), fadeOut: 0.2 };
		const project = { ...newProject("Short audio"), segments: [clip] };
		const next = detachClipAudio(
			project,
			[video, audio],
			{ clipIds: [clip.id], revision: 0 },
			() => audio
		);
		expect(
			next.segments.find((segment) => segment.assetId === audio.id)?.sourceOut
		).toBe(7.5);
	});
});

describe("media whose audio cannot be extracted", () => {
	test("reversed clips and nested sequences are not detachable and do not block the rest", () => {
		const video = videoAsset();
		const audio = extractedAudio(video);
		const reversed: Asset = {
			...videoAsset(),
			derivation: "reverse",
			derivedFromAssetId: video.id,
		};
		const sequence: Asset = {
			...videoAsset(),
			sequenceProjectId: crypto.randomUUID(),
		};
		const assets = [video, audio, reversed, sequence];
		const camera = newSegment(video, 0, 0);
		const backwards = newSegment(reversed, 10, 0);
		const nested = newSegment(sequence, 20, 0);
		const project = {
			...newProject("Mixed"),
			segments: [camera, backwards, nested],
		};
		expect(hasExtractableAudio(reversed)).toBe(false);
		expect(hasExtractableAudio(sequence)).toBe(false);
		expect(hasExtractableAudio(video)).toBe(true);
		expect(detachableClipIds(project, assets)).toEqual([camera.id]);
		const lookup = (id: string) => (id === video.id ? audio : undefined);
		const all = detachAllClipAudio(project, assets, lookup);
		expect(all.segments).toHaveLength(4);
		expect(() =>
			detachClipAudio(
				project,
				assets,
				{ clipIds: [backwards.id], revision: project.revision },
				lookup
			)
		).toThrow("Reversed clips keep their audio embedded");
		expect(() =>
			detachClipAudio(
				project,
				assets,
				{ clipIds: [nested.id], revision: project.revision },
				lookup
			)
		).toThrow("Nested sequences keep their audio embedded");
	});
});

/**
 * Strip ids so a round trip can be compared with the original clip.
 * Keyframe order is not meaningful (channels group by property), so it is
 * normalized too.
 */
function withoutIds(segment: Segment | undefined) {
	if (!segment) {
		return segment;
	}
	return {
		...segment,
		id: "",
		linkGroupId: undefined,
		keyframes: segment.keyframes
			.map((frame) => ({ ...frame, id: "" }))
			.sort((a, b) => a.property.localeCompare(b.property) || a.time - b.time),
	};
}

function detachedProject() {
	const video = videoAsset();
	const audio = extractedAudio(video);
	const clip = cameraClip(video, 2);
	const project = { ...newProject("Recover"), segments: [clip] };
	const assets = [video, audio];
	const detached = detachClipAudio(
		project,
		assets,
		{ clipIds: [clip.id], revision: project.revision },
		(id) => (id === video.id ? audio : undefined)
	);
	const audioClip = detached.segments.find(
		(segment) => segment.assetId === audio.id
	);
	if (!audioClip) {
		throw new Error("Detach did not create an audio clip.");
	}
	return { assets, audio, audioClip, clip, detached, project, video };
}

describe("recover detached audio", () => {
	test("detach then recover returns the original clip except ids", () => {
		const { assets, clip, detached } = detachedProject();
		const recovered = reattachAudio(detached, assets, {
			clipIds: [clip.id],
			revision: detached.revision,
		});
		expect(recovered.segments).toHaveLength(1);
		const [restored] = recovered.segments;
		expect(restored?.id).toBe(clip.id);
		expect(restored?.linkGroupId).toBeUndefined();
		expect(withoutIds(restored)).toEqual(withoutIds(clip));
		expect(
			restored?.keyframes
				.filter((frame) => frame.property === "volume")
				.map(({ time, value }) => ({ time, value }))
		).toEqual([{ time: 1, value: 0.4 }]);
	});

	test("either member of the pair recovers the audio", () => {
		const { assets, audioClip, clip, detached } = detachedProject();
		const recovered = reattachAudio(detached, assets, {
			clipIds: [audioClip.id],
			revision: detached.revision,
		});
		expect(recovered.segments.map((segment) => segment.id)).toEqual([clip.id]);
	});

	test("carries edits made on the detached audio back to the camera clip", () => {
		const { assets, audioClip, clip, detached } = detachedProject();
		const edited = {
			...detached,
			segments: detached.segments.map((segment) =>
				segment.id === audioClip.id
					? {
							...segment,
							volume: 1.5,
							pan: -0.5,
							audioProcessing: "normalize" as const,
							keyframes: [
								{
									id: crypto.randomUUID(),
									property: "volume" as const,
									time: 0.5,
									value: 1,
								},
							],
						}
					: segment
			),
		};
		const recovered = reattachAudio(edited, assets, {
			clipIds: [clip.id],
			revision: edited.revision,
		});
		const [restored] = recovered.segments;
		expect(restored).toMatchObject({
			audioProcessing: "normalize",
			pan: -0.5,
			volume: 1.5,
		});
		expect(
			restored?.keyframes.map(({ property, time, value }) => ({
				property,
				time,
				value,
			}))
		).toEqual([
			{ property: "scale", time: 1, value: 1.2 },
			{ property: "volume", time: 0.5, value: 1 },
		]);
	});

	test("re-bases volume keyframes when the audio member was moved", () => {
		const { assets, audioClip, clip, detached } = detachedProject();
		const moved = {
			...detached,
			segments: detached.segments.map((segment) =>
				segment.id === audioClip.id
					? {
							...segment,
							start: segment.start - 0.5,
							keyframes: segment.keyframes.map((frame) => ({
								...frame,
								time: 1.5,
							})),
						}
					: segment
			),
		};
		const recovered = reattachAudio(moved, assets, {
			clipIds: [clip.id],
			revision: moved.revision,
		});
		const volume = recovered.segments[0]?.keyframes.filter(
			(frame) => frame.property === "volume"
		);
		expect(
			volume?.some((frame) => frame.time === 1 && frame.value === 0.4)
		).toBe(true);
	});

	test("carries pan keyframes both ways and re-bases them after a move", () => {
		const video = videoAsset();
		const audio = extractedAudio(video);
		const clip: Segment = {
			...cameraClip(video, 2),
			pan: 0.25,
			keyframes: [
				{ id: crypto.randomUUID(), property: "pan", time: 0, value: -1 },
				{ id: crypto.randomUUID(), property: "pan", time: 1, value: 1 },
			],
		};
		const project = { ...newProject("Pan"), segments: [clip] };
		const assets = [video, audio];
		const detached = detachClipAudio(
			project,
			assets,
			{ clipIds: [clip.id], revision: project.revision },
			() => audio
		);
		const audioClip = detached.segments.find(
			(segment) => segment.assetId === audio.id
		);
		expect(audioClip?.pan).toBe(0.25);
		expect(
			audioClip?.keyframes
				.filter((frame) => frame.property === "pan")
				.map(({ time, value }) => ({ time, value }))
		).toEqual([
			{ time: 0, value: -1 },
			{ time: 1, value: 1 },
		]);
		const roundTrip = reattachAudio(detached, assets, {
			clipIds: [clip.id],
			revision: detached.revision,
		});
		expect(withoutIds(roundTrip.segments[0])).toEqual(withoutIds(clip));

		const edited = {
			...detached,
			segments: detached.segments.map((segment) =>
				segment.id === audioClip?.id
					? {
							...segment,
							start: segment.start - 0.5,
							pan: 0.5,
							keyframes: [
								{
									id: crypto.randomUUID(),
									property: "pan" as const,
									time: 0.5,
									value: -1,
								},
								{
									id: crypto.randomUUID(),
									property: "pan" as const,
									time: 1.5,
									value: 1,
								},
							],
						}
					: segment
			),
		};
		const recovered = reattachAudio(edited, assets, {
			clipIds: [clip.id],
			revision: edited.revision,
		});
		const [restored] = recovered.segments;
		expect(restored?.pan).toBe(0.5);
		const pan = restored?.keyframes
			.filter((frame) => frame.property === "pan")
			.map(({ time, value }) => ({ time, value }));
		expect(pan).toContainEqual({ time: 0, value: -1 });
		expect(pan).toContainEqual({ time: 1, value: 1 });
		expect(
			restored?.keyframes.filter((frame) => frame.property === "volume")
		).toEqual([]);
	});

	test("a locked partner track blocks recovery from either member", () => {
		const { assets, audioClip, clip, detached } = detachedProject();
		expect(recoverBlockingTrack(detached, assets, clip.id)).toBeUndefined();
		const locked = updateTrackSetting(detached, audioClip.track, {
			locked: true,
		});
		for (const id of [clip.id, audioClip.id]) {
			expect(recoverBlockingTrack(locked, assets, id)).toBe(audioClip.track);
		}
		expect(recoverableClipIds(locked, assets)).toEqual([]);
		expect(recoverableClipIds(detached, assets)).toEqual([clip.id]);
	});

	test("reports detach or recover state for the inspector toggle", () => {
		const { assets, audioClip, clip, detached, project } = detachedProject();
		expect(detachAudioState(project, assets, clip.id)).toBe("detach");
		expect(detachAudioState(detached, assets, clip.id)).toBe("recover");
		expect(detachAudioState(detached, assets, audioClip.id)).toBe("recover");
		expect(recoverableClipIds(detached, assets)).toEqual([clip.id]);
		expect(detachedAudioPairs(detached, assets, clip.id)).toHaveLength(1);
		const silent = videoAsset(false);
		const quiet = newSegment(silent, 20);
		expect(
			detachAudioState(
				{ ...project, segments: [quiet] },
				[...assets, silent],
				quiet.id
			)
		).toBe("unavailable");
	});

	test("refuses clips without detached audio and locked tracks", () => {
		const { assets, audioClip, clip, detached, project } = detachedProject();
		expect(() =>
			reattachAudio(project, assets, {
				clipIds: [clip.id],
				revision: project.revision,
			})
		).toThrow("detached camera audio");
		const locked = updateTrackSetting(detached, audioClip.track, {
			locked: true,
		});
		expect(() =>
			reattachAudio(locked, assets, {
				clipIds: [clip.id],
				revision: locked.revision,
			})
		).toThrow("Unlock track 2");
		expect(() =>
			reattachAudio(detached, assets, {
				clipIds: [clip.id, clip.id],
				revision: detached.revision,
			})
		).toThrow("each clip once");
	});

	test("does not treat a manually linked unrelated audio clip as detached", () => {
		const video = videoAsset();
		const music: Asset = {
			...extractedAudio(videoAsset()),
			derivation: undefined,
		};
		const clip = newSegment(video);
		const bed = newSegment(music, 0, 1);
		const linked = manageClipLinks(
			{ ...newProject("Music"), segments: [clip, bed] },
			[video, music],
			{ action: "link", clipIds: [clip.id, bed.id], revision: 0 }
		);
		expect(detachAudioState(linked, [video, music], clip.id)).toBe(
			"unavailable"
		);
		expect(() =>
			reattachAudio(linked, [video, music], {
				clipIds: [clip.id],
				revision: linked.revision,
			})
		).toThrow("detached camera audio");
	});

	test("recovers a batch of detached clips and keeps the result valid", () => {
		const first = videoAsset();
		const second = videoAsset();
		const firstAudio = extractedAudio(first);
		const secondAudio = extractedAudio(second);
		const a = cameraClip(first, 0, 0);
		const b = cameraClip(second, 4, 0);
		const original = { ...newProject("Batch"), segments: [a, b] };
		const assets = [first, second, firstAudio, secondAudio];
		const detached = detachAllClipAudio(original, assets, (id) =>
			[firstAudio, secondAudio].find((audio) => audio.derivedFromAssetId === id)
		);
		const ids = recoverableClipIds(detached, assets);
		expect(ids).toEqual([a.id, b.id]);
		const recovered = reattachAudio(detached, assets, {
			clipIds: ids,
			revision: detached.revision,
		});
		expect(recovered.segments.map(withoutIds)).toEqual(
			original.segments.map(withoutIds)
		);
		expect(() => validateProject(recovered, assets)).not.toThrow();
	});
});
