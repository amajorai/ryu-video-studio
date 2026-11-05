/**
 * OpenTimelineIO library proof for the `.otio` speed-curve export.
 *
 * Exports a timeline with one curved clip (0.5x -> 3x -> 1x) and one
 * constant-speed clip through `interchangeText(..., "otio")`, then loads the
 * file with the real `opentimelineio` Python package
 * (`otio.adapters.read_from_string`) and checks what that library keeps:
 *
 * - the file parses as an `otio.schema.Timeline`;
 * - the curved clip's effects are an `otio.schema.LinearTimeWarp` with the
 *   average speed and a generic `otio.schema.Effect` named
 *   `Ryu.SpeedCurve.1` whose metadata still holds every keyframe;
 * - the clip's `metadata.ryu.speedCurve` survives;
 * - re-serializing with the library and reading the result back with
 *   `readOtioSpeedCurves` yields the exported curve.
 *
 * This only proves the OpenTimelineIO library itself keeps the data. Editors
 * that import `.otio` (through their own importers or adapters) were not
 * tested; they apply at most the `LinearTimeWarp` average and do not apply the
 * custom effect.
 *
 * Needs Python 3 with `opentimelineio` installed (`pip install
 * opentimelineio`); set `OTIO_PYTHON` to pick the interpreter. Without it the
 * script exits non-zero and says so instead of reporting success.
 *
 * Run: `bun src/verify-otio.ts`
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	interchangeText,
	OTIO_SPEED_CURVE_EFFECT,
	readOtioSpeedCurves,
} from "../../shared/interchange.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentDuration,
} from "../../shared/project.ts";
import { naturalCurveSpeed } from "../../shared/speed-curve.ts";

const python = process.env.OTIO_PYTHON ?? "python3";

const PROBE = `
import json, sys
try:
    import opentimelineio as otio
except ImportError as error:
    print(json.dumps({"missing": str(error)}))
    sys.exit(3)
source, roundtrip = sys.argv[1], sys.argv[2]
with open(source, encoding="utf-8") as handle:
    timeline = otio.adapters.read_from_string(handle.read(), "otio_json")
clips = []
for clip in timeline.find_clips():
    effects = []
    for effect in clip.effects:
        effects.append({
            "class": type(effect).__name__,
            "effect_name": effect.effect_name,
            "time_scalar": getattr(effect, "time_scalar", None),
            "keyframes": len(effect.metadata.get("ryu", {}).get("keyframes", [])),
        })
    ryu = clip.metadata.get("ryu", {})
    clips.append({
        "clipId": ryu.get("clipId"),
        "effects": effects,
        "hasSpeedCurve": "speedCurve" in ryu,
    })
with open(roundtrip, "w", encoding="utf-8") as handle:
    handle.write(otio.adapters.write_to_string(timeline, "otio_json"))
print(json.dumps(sort_keys=True, obj={
    "version": otio.__version__,
    "timeline": type(timeline).__name__,
    "clips": clips,
}))
`;

interface ProbeClip {
	clipId: string | null;
	effects: {
		class: string;
		effect_name: string;
		keyframes: number;
		time_scalar: number | null;
	}[];
	hasSpeedCurve: boolean;
}

function fail(message: string): never {
	process.stderr.write(`verify-otio: FAIL: ${message}\n`);
	process.exit(1);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (!isDeepStrictEqual(actual, expected)) {
		fail(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
		);
	}
}

const video: Asset = {
	createdAt: new Date().toISOString(),
	duration: 4,
	hasAudio: true,
	height: 360,
	id: "00000000-0000-4000-8000-0000000000d1",
	kind: "video",
	name: "Ramp",
	width: 640,
};
const points = [
	{ speed: 0.5, t: 0 },
	{ speed: 3, t: 0.5 },
	{ speed: 1, t: 1 },
];
const curved = {
	...newSegment(video, 0, 0),
	id: "00000000-0000-4000-8000-0000000000d2",
	sourceOut: 4,
	speed: naturalCurveSpeed(points),
	speedCurve: { points, preservePitch: false },
};
const constant = {
	...newSegment(video, 0, segmentDuration(curved) + 1),
	id: "00000000-0000-4000-8000-0000000000d3",
	sourceOut: 2,
	speed: 2,
};
const project: Project = {
	...newProject("OTIO proof"),
	id: "00000000-0000-4000-8000-0000000000d4",
	segments: [curved, constant],
};

const dir = await mkdtemp(join(tmpdir(), "ryu-verify-otio-"));
try {
	const source = join(dir, "export.otio");
	const roundtrip = join(dir, "roundtrip.otio");
	await writeFile(source, interchangeText(project, [video], "otio"));
	const probe = Bun.spawnSync([python, "-I", "-c", PROBE, source, roundtrip], {
		stderr: "pipe",
		stdout: "pipe",
	});
	const stdout = probe.stdout.toString().trim();
	if (probe.exitCode === 3) {
		fail(
			`${python} has no opentimelineio (${stdout}); install it with \`pip install opentimelineio\` or set OTIO_PYTHON`
		);
	}
	if (probe.exitCode !== 0) {
		fail(
			`opentimelineio could not load the export (exit ${probe.exitCode}): ${probe.stderr.toString().trim()}`
		);
	}
	const result = JSON.parse(stdout) as {
		clips: ProbeClip[];
		timeline: string;
		version: string;
	};
	assertEqual(result.timeline, "Timeline", "loaded object");
	const byId = new Map(result.clips.map((clip) => [clip.clipId, clip]));
	const curvedClip = byId.get(curved.id) ?? fail("curved clip missing");
	assertEqual(
		curvedClip.effects,
		[
			{
				class: "LinearTimeWarp",
				effect_name: "LinearTimeWarp",
				keyframes: 0,
				time_scalar: Number(curved.speed.toFixed(6)),
			},
			{
				class: "Effect",
				effect_name: OTIO_SPEED_CURVE_EFFECT,
				keyframes: points.length,
				time_scalar: null,
			},
		],
		"curved clip effects after opentimelineio load"
	);
	assertEqual(curvedClip.hasSpeedCurve, true, "metadata.ryu.speedCurve kept");
	const constantClip = byId.get(constant.id) ?? fail("constant clip missing");
	assertEqual(
		constantClip.effects.map((effect) => effect.class),
		["LinearTimeWarp"],
		"constant clip effects"
	);
	const reread = readOtioSpeedCurves(await readFile(roundtrip, "utf8"));
	assertEqual(
		Object.fromEntries(reread),
		{ [curved.id]: curved.speedCurve },
		"curves read back after an opentimelineio re-serialize"
	);
	process.stdout.write(
		`verify-otio: PASS with opentimelineio ${result.version}: the library keeps the LinearTimeWarp average, the ${OTIO_SPEED_CURVE_EFFECT} effect, and metadata.ryu.speedCurve\n`
	);
} finally {
	await rm(dir, { force: true, recursive: true });
}
