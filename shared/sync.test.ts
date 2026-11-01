import { expect, test } from "bun:test";
import type { MediaAnalysis } from "./analysis.ts";
import { newProject, newSegment } from "./project.ts";
import {
	bestEnvelopeLag,
	correlateAudio,
	DRIFT_ENVELOPE_RATE,
	type DriftEnvelopeReader,
	driftDecision,
	driftWindowPlan,
	MAX_CORRECTABLE_DRIFT,
	measureDrift,
	pcmEnvelope,
	refineSyncMatch,
	syncClips,
	syncDriftNotice,
	timecodeSeconds,
} from "./sync.ts";

function analysis(assetId: string, waveform: number[]): MediaAnalysis {
	return {
		assetId,
		createdAt: new Date().toISOString(),
		duration: 8,
		sceneCuts: [],
		status: "completed",
		waveform,
	};
}

function source(id = crypto.randomUUID()) {
	return {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 360,
		id,
		kind: "video" as const,
		name: "Camera",
		width: 640,
	};
}

test("timecodeSeconds handles regular and drop-frame timecode", () => {
	expect(timecodeSeconds("01:00:00:00", 30)).toBe(3600);
	expect(timecodeSeconds("00:01:00;00", 29.97)).toBeCloseTo(59.993, 2);
});

test("audio correlation finds a delayed target source", () => {
	const reference = source();
	const values = Array.from(
		{ length: 80 },
		(_, index) => 0.1 + ((index * 29) % 17) / 22
	);
	const targetValues = Array.from(
		{ length: 80 },
		(_, index) => values[index - 8] ?? 0
	);
	const match = correlateAudio(
		analysis(reference.id, values),
		analysis(crypto.randomUUID(), targetValues),
		2,
		0.8
	);
	expect(match.lagSeconds).toBeCloseTo(0.8, 1);
	expect(match.confidence).toBeGreaterThan(0.8);
});

test("long sparse envelopes cannot expand short selected trims into whole-source work", () => {
	const values = Array.from(
		{ length: 600 },
		(_, index) => ((index * 29) % 17) / 22
	);
	const reference = {
		...analysis(crypto.randomUUID(), values),
		duration: 7200,
	};
	const target = { ...reference, assetId: crypto.randomUUID() };
	const started = performance.now();
	expect(() =>
		correlateAudio(reference, target, 600, 0.5, {
			referenceIn: 0,
			referenceOut: 8,
			targetIn: 0,
			targetOut: 8,
		})
	).toThrow("too weak");
	expect(performance.now() - started).toBeLessThan(1000);
	expect(correlateAudio(reference, target, 600, 0.5).lagSeconds).toBe(0);
});

test("audio correlation refuses silent ambiguous measurements", () => {
	expect(() =>
		correlateAudio(
			analysis(
				crypto.randomUUID(),
				Array.from({ length: 80 }, () => 0.2)
			),
			analysis(
				crypto.randomUUID(),
				Array.from({ length: 80 }, () => 0.2)
			),
			30,
			0.5
		)
	).toThrow("too weak");
});

test("direct audio correlation rejects nonfinite and out-of-source work bounds", () => {
	const measured = analysis(
		crypto.randomUUID(),
		Array.from({ length: 80 }, (_, index) => (index % 13) / 13)
	);
	for (const ranges of [
		{
			referenceIn: 0,
			referenceOut: Number.POSITIVE_INFINITY,
			targetIn: 0,
			targetOut: Number.POSITIVE_INFINITY,
		},
		{ referenceIn: -1, referenceOut: 8, targetIn: 0, targetOut: 8 },
		{ referenceIn: 0, referenceOut: 9, targetIn: 0, targetOut: 8 },
	]) {
		expect(() => correlateAudio(measured, measured, 30, 0.5, ranges)).toThrow(
			"finite search bounds"
		);
	}
	expect(() =>
		correlateAudio(measured, measured, Number.POSITIVE_INFINITY, 0.5)
	).toThrow("finite search bounds");
	expect(() => correlateAudio(measured, measured, 30, Number.NaN)).toThrow(
		"finite search bounds"
	);
});

test("syncClips aligns targets and shifts a negative group into the timeline", () => {
	const reference = source();
	const target = source();
	target.name = "Recorder";
	const project = newProject("Sync");
	const referenceClip = newSegment(reference, 0, 0);
	const targetClip = newSegment(target, 2, 1);
	project.segments = [referenceClip, targetClip];
	const values = Array.from(
		{ length: 80 },
		(_, index) => 0.1 + ((index * 29) % 17) / 22
	);
	const delayed = Array.from(
		{ length: 80 },
		(_, index) => values[index - 8] ?? 0
	);
	const result = syncClips(
		project,
		[reference, target],
		new Map([
			[reference.id, analysis(reference.id, values)],
			[target.id, analysis(target.id, delayed)],
		]),
		{
			mode: "audio",
			referenceClipId: referenceClip.id,
			revision: project.revision,
			searchWindowSeconds: 2,
			targetClipIds: [targetClip.id],
		}
	);
	const alignedReference = result.project.segments.find(
		(segment) => segment.id === referenceClip.id
	);
	const alignedTarget = result.project.segments.find(
		(segment) => segment.id === targetClip.id
	);
	expect(result.shiftedFrames).toBe(24);
	expect(alignedReference?.start).toBeCloseTo(0.8, 2);
	expect(alignedTarget?.start).toBe(0);
	expect(result.matches[0]).toMatchObject({
		confidence: expect.any(Number),
		method: "audio",
		offsetFrames: -60,
	});
});

test("manual sync applies a bounded target offset without source analysis", () => {
	const reference = source();
	const target = source();
	const project = newProject("Manual sync");
	const referenceClip = newSegment(reference, 1, 0);
	const targetClip = newSegment(target, 2, 1);
	project.segments = [referenceClip, targetClip];
	const result = syncClips(project, [reference, target], new Map(), {
		offsetSeconds: -0.5,
		mode: "manual",
		referenceClipId: referenceClip.id,
		revision: project.revision,
		targetClipIds: [targetClip.id],
	});
	expect(
		result.project.segments.find((segment) => segment.id === targetClip.id)
			?.start
	).toBe(1.5);
	expect(result.matches[0]).toMatchObject({
		alignmentOffsetSeconds: -0.5,
		method: "manual",
		offsetFrames: -15,
	});
});

test("timecode sync aligns clips from embedded source starts", () => {
	const reference = {
		...source(),
		timecodeFrameRate: 30,
		timecodeStart: "01:00:00:00",
	};
	const target = {
		...source(),
		name: "Recorder",
		timecodeFrameRate: 30,
		timecodeStart: "01:00:05:00",
	};
	const project = newProject("Timecode sync");
	const referenceClip = newSegment(reference, 0, 0);
	const targetClip = newSegment(target, 0, 1);
	project.segments = [referenceClip, targetClip];
	const result = syncClips(project, [reference, target], new Map(), {
		mode: "timecode",
		referenceClipId: referenceClip.id,
		revision: project.revision,
		targetClipIds: [targetClip.id],
	});
	expect(
		result.project.segments.find((segment) => segment.id === targetClip.id)
			?.start
	).toBe(5);
	expect(result.matches[0]).toMatchObject({
		alignmentOffsetSeconds: -5,
		method: "timecode",
		offsetFrames: 150,
	});
});

// Clock drift ----------------------------------------------------------------

/** Deterministic burst envelope: decaying hits at pseudo-random times. */
function burstEnvelope(seconds: number): (second: number) => number {
	const hits: { at: number; level: number }[] = [];
	let seed = 7;
	const random = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	for (let at = 0.1; at < seconds; at += 0.12 + random() * 0.5) {
		hits.push({ at, level: 0.2 + random() * 0.8 });
	}
	return (second) => {
		let value = 0.01;
		for (const hit of hits) {
			if (hit.at > second) {
				break;
			}
			if (second - hit.at < 0.4) {
				value += hit.level * Math.exp(-(second - hit.at) / 0.04);
			}
		}
		return value;
	};
}

const reference120 = { ...source(), duration: 120, name: "Camera" };
const recorderSource = { ...source(), duration: 124, name: "Recorder" };
const referenceEnvelope = burstEnvelope(125);

/** Target source time `t = r * (1 + drift) + offset` for reference time `r`. */
function driftReader(drift: number, offset: number): DriftEnvelopeReader {
	return (role, start, duration) => {
		const samples = Math.floor(duration * DRIFT_ENVELOPE_RATE + 1e-6);
		return Promise.resolve(
			Float32Array.from({ length: samples }, (_, index) => {
				const second = start + index / DRIFT_ENVELOPE_RATE;
				return role === "reference"
					? referenceEnvelope(second)
					: referenceEnvelope((second - offset) / (1 + drift));
			})
		);
	};
}

async function driftSync(
	drift: number,
	options: { coarseError?: number; correct?: boolean } = {}
) {
	const project = newProject("Drift");
	const referenceClip = newSegment(reference120, 0, 0);
	const targetClip = newSegment(recorderSource, 3, 1);
	project.segments = [referenceClip, targetClip];
	const offset = 1.5;
	const refinement = await refineSyncMatch(
		{
			coarse: {
				confidence: 0.9,
				lagSeconds: offset + drift * 10 + (options.coarseError ?? 0.12),
			},
			coarseStepSeconds: 0.2,
			correct: options.correct ?? true,
			fps: project.fps,
			reference: referenceClip,
			target: targetClip,
			targetDuration: recorderSource.duration,
		},
		driftReader(drift, offset)
	);
	const result = syncClips(
		project,
		[reference120, recorderSource],
		new Map(),
		{
			driftCorrection: options.correct ?? true,
			mode: "audio",
			referenceClipId: referenceClip.id,
			revision: project.revision,
			targetClipIds: [targetClip.id],
		},
		new Map([[targetClip.id, refinement]])
	);
	const placedReference = result.project.segments.find(
		(segment) => segment.id === referenceClip.id
	)!;
	const placedTarget = result.project.segments.find(
		(segment) => segment.id === targetClip.id
	)!;
	/** Timeline seconds between the same sound in both clips at reference `r`. */
	const misalignment = (second: number) => {
		const referenceTime =
			placedReference.start +
			(second - placedReference.sourceIn) / placedReference.speed;
		const targetTime =
			placedTarget.start +
			(second * (1 + drift) + offset - placedTarget.sourceIn) /
				placedTarget.speed;
		return Math.abs(referenceTime - targetTime);
	};
	return { misalignment, placedTarget, project, refinement, result };
}

test("drift windows sit at both ends of the overlap with a drift-wide search", () => {
	const plan = driftWindowPlan({
		coarseStepSeconds: 0.2,
		lagSeconds: 1.5,
		reference: { sourceIn: 0, sourceOut: 120 },
		target: { sourceIn: 0, sourceOut: 122 },
		targetDuration: 130,
	});
	if ("reason" in plan) {
		throw new Error(plan.reason);
	}
	const [first, second] = plan.windows;
	expect(first.referenceStart).toBe(0);
	expect(second.referenceStart + second.referenceDuration).toBe(120);
	expect(plan.spanSeconds).toBe(110);
	// Each end searches ±(coarse error + half of a 1% drift over the span).
	expect(first.targetStart).toBeCloseTo(1.5 - (0.5 + 0.55), 6);
	expect(second.targetDuration).toBeCloseTo(10 + 2 * 1.05, 6);
	expect(
		driftWindowPlan({
			coarseStepSeconds: 0.2,
			lagSeconds: 0,
			reference: { sourceIn: 0, sourceOut: 8 },
			target: { sourceIn: 0, sourceOut: 8 },
			targetDuration: 8,
		})
	).toMatchObject({ reason: expect.stringContaining("20 s") });
});

test("envelope lag finds a sub-sample offset inside a longer target", () => {
	const reference = Float32Array.from({ length: 4000 }, (_, index) =>
		referenceEnvelope(10 + index / 1000)
	);
	const target = Float32Array.from({ length: 6000 }, (_, index) =>
		referenceEnvelope(9.2 + index / 1000 - 0.0004)
	);
	const match = bestEnvelopeLag(reference, target);
	expect(match?.lagSeconds).toBeCloseTo(0.8004, 3);
	expect(match?.confidence).toBeGreaterThan(0.95);
});

test("measureDrift is the lag change over the span", () => {
	expect(
		measureDrift(
			{ anchorSeconds: 5, lagSeconds: 1.51 },
			{ anchorSeconds: 105, lagSeconds: 1.71 }
		)
	).toBeCloseTo(0.002, 9);
	expect(() =>
		measureDrift(
			{ anchorSeconds: 5, lagSeconds: 0 },
			{ anchorSeconds: 5, lagSeconds: 0 }
		)
	).toThrow("source order");
});

test("a 0.2% drifted copy is corrected within one frame at the end", async () => {
	const { misalignment, placedTarget, refinement, result } =
		await driftSync(0.002);
	expect(refinement.drift.status).toBe("corrected");
	expect(refinement.drift.driftPercent).toBeCloseTo(0.2, 2);
	expect(placedTarget.speed).toBeCloseTo(1.002, 4);
	expect(result.matches[0]?.drift?.status).toBe("corrected");
	expect(result.warnings).toBeUndefined();
	const frame = 1 / 30;
	expect(misalignment(5)).toBeLessThan(frame);
	expect(misalignment(115)).toBeLessThan(frame);
	expect(misalignment(119.5)).toBeLessThan(frame);
});

test("negative drift slows the target and still lands within a frame", async () => {
	const { misalignment, placedTarget } = await driftSync(-0.003, {
		coarseError: -0.15,
	});
	expect(placedTarget.speed).toBeCloseTo(0.997, 4);
	expect(misalignment(115)).toBeLessThan(1 / 30);
});

test("drift beyond 0.5% warns and keeps the clip speed", async () => {
	const { placedTarget, refinement, result } = await driftSync(0.008);
	expect(refinement.drift.status).toBe("too-large");
	expect(refinement.drift.driftPercent).toBeCloseTo(0.8, 1);
	expect(placedTarget.speed).toBe(1);
	expect(result.warnings?.[0]).toContain("exceeds");
});

test("disabled correction reports drift without changing speed", async () => {
	const { placedTarget, refinement, result } = await driftSync(0.002, {
		correct: false,
	});
	expect(refinement.drift.status).toBe("disabled");
	expect(placedTarget.speed).toBe(1);
	expect(result.warnings?.[0]).toContain("uncorrected");
});

test("matching clocks are negligible and still sync to the sub-frame", async () => {
	const { misalignment, placedTarget, refinement } = await driftSync(0);
	expect(refinement.drift.status).toBe("negligible");
	expect(placedTarget.speed).toBe(1);
	expect(misalignment(60)).toBeLessThan(0.005);
});

test("drift decisions bound speed and ignore sub-frame drift", () => {
	const decide = (drift: number) =>
		driftDecision({
			correct: true,
			drift,
			fps: 30,
			overlapSeconds: 60,
			referenceSpeed: 1,
			spanSeconds: 50,
		});
	expect(decide(0.0001).status).toBe("negligible");
	expect(decide(0.004)).toMatchObject({ speed: 1.004, status: "corrected" });
	expect(decide(-0.0051).status).toBe("too-large");
	expect(MAX_CORRECTABLE_DRIFT).toBe(0.005);
});

test("unreadable drift audio falls back to the coarse lag", async () => {
	const referenceClip = newSegment(reference120, 0, 0);
	const targetClip = newSegment(recorderSource, 0, 1);
	const refinement = await refineSyncMatch(
		{
			coarse: { confidence: 0.8, lagSeconds: 1.4 },
			coarseStepSeconds: 0.2,
			correct: true,
			fps: 30,
			reference: referenceClip,
			target: targetClip,
			targetDuration: recorderSource.duration,
		},
		() => Promise.reject(new Error("decode failed"))
	);
	expect(refinement).toMatchObject({
		anchorSeconds: 0,
		lagSeconds: 1.4,
		subFrame: false,
	});
	expect(refinement.drift).toMatchObject({ status: "unmeasured" });
	expect(refinement.drift.reason).toContain("decode failed");
});

test("pcmEnvelope averages absolute samples per block", () => {
	expect([
		...pcmEnvelope(Float32Array.from([1, -1, 0.5, -0.5, 0.25]), 8, 4),
	]).toEqual([1, 0.5]);
});

test("sync drift notices count corrections and keep every warning", () => {
	expect(syncDriftNotice([], [])).toBe("");
	expect(
		syncDriftNotice(
			[
				{ drift: { status: "corrected" } },
				{ drift: { status: "too-large" } },
				{},
			],
			["Measured clock drift of 0.80% exceeds the 0.5% correction limit."]
		)
	).toBe(
		"Clock drift corrected on 1 clip. Measured clock drift of 0.80% exceeds the 0.5% correction limit."
	);
	expect(
		syncDriftNotice(
			[{ drift: { status: "corrected" } }, { drift: { status: "corrected" } }],
			[]
		)
	).toBe("Clock drift corrected on 2 clips.");
});
