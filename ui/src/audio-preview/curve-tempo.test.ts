import { expect, test } from "bun:test";
import { naturalCurveSpeed } from "../../../shared/speed-curve.ts";
import { previewTempo } from "./tempo.ts";

test("a curved clip previews at the curve's speed at the playhead, pitch kept", () => {
	const points = [
		{ speed: 0.5, t: 0 },
		{ speed: 4, t: 1 },
	];
	const clip = {
		muted: undefined,
		preservePitch: false,
		sourceIn: 0,
		sourceOut: 4,
		speed: naturalCurveSpeed(points),
		speedCurve: { points },
	};
	const start = previewTempo(clip, 0);
	expect(start.playbackRate).toBeCloseTo(0.5, 6);
	expect(start.preservesPitch).toBe(true);
	const end = previewTempo(clip, 4 / clip.speed);
	expect(end.playbackRate).toBeCloseTo(4, 6);
	// A constant clip keeps its own speed and pitch setting.
	expect(
		previewTempo({ muted: undefined, preservePitch: false, speed: 2 }, 1)
	).toEqual({ muted: false, playbackRate: 2, preservesPitch: false });
});

test("a tape-style curve previews with pitch following its playback rate", () => {
	const points = [
		{ speed: 0.5, t: 0 },
		{ speed: 4, t: 1 },
	];
	const clip = {
		muted: undefined,
		preservePitch: undefined,
		sourceIn: 0,
		sourceOut: 4,
		speed: naturalCurveSpeed(points),
		speedCurve: { points, preservePitch: false },
	};
	const start = previewTempo(clip, 0);
	expect(start.playbackRate).toBeCloseTo(0.5, 6);
	expect(start.preservesPitch).toBe(false);
});
