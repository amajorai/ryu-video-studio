import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSceneCuts, parseWaveform } from "../../shared/analysis.ts";
import { createMulticamGroup } from "../../shared/multicam.ts";
import {
	type Asset,
	activeCaptions,
	animatedValue,
	assetSchema,
	isTrackAudible,
	newProject,
	newSegment,
	type Project,
	parseSubtitles,
	projectDuration,
	projectSchema,
	splitSegment,
	subtitleText,
	trackSettingFor,
	updateTrackSetting,
	validateProject,
} from "../../shared/project.ts";
import { generateStageWorld } from "../../shared/stage-world.ts";
import {
	assembleStoryboard,
	fitSceneToAudio,
} from "../../shared/storyboard.ts";
import { trackOrderFor } from "../../shared/track-edits.ts";
import {
	applyTranslations,
	captionsForSource,
	transcriptSchema,
	transcriptWindowCues,
	transcriptWindowWords,
} from "../../shared/transcript.ts";
import { waveformPoints } from "../../shared/waveform.ts";
import { runMedia } from "./media.ts";
import { assCaptions, buildRender, RenderQueue } from "./render.ts";
import { createStudioServer, openapi } from "./server.ts";
import { ConflictError, StudioStore } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});
async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "ryu-video-studio-test-"));
	const store = new StudioStore(dir);
	cleanup.push(async () => {
		store.close();
		await rm(dir, { recursive: true, force: true });
	});
	return store;
}
function asset(): Asset {
	return {
		id: crypto.randomUUID(),
		name: "Footage",
		kind: "video",
		duration: 10,
		width: 640,
		height: 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

test("capabilities route advertises supported export codecs and containers", async () => {
	const store = await setup();
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/capabilities`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			codecs: ["h264", "h265", "prores"],
			formats: ["mp4", "mov"],
		});
	} finally {
		app.stop();
	}
});

test("media import route enforces auth and HTTPS source validation", async () => {
	const store = await setup();
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const url = `http://127.0.0.1:${app.server.port}/api/video-studio/assets/import`;
	try {
		const unauthorized = await fetch(url, {
			body: JSON.stringify({
				source: { url: "https://example.com/source.mp4" },
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(unauthorized.status).toBe(401);
		const invalid = await fetch(url, {
			body: JSON.stringify({
				source: { url: "http://example.com/source.mp4" },
			}),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
		expect(invalid.status).toBe(400);
	} finally {
		app.stop();
	}
});

test("media inspection combines metadata, transcript, analysis, and thumbnail state", async () => {
	const store = await setup();
	const source = { ...asset(), duration: 1 };
	store.putAsset(source);
	const fixture = join(store.directory, "inspect-fixture.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=red:size=640x360:rate=24:duration=1",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		fixture,
	]);
	await Bun.write(
		store.mediaPath(source.id),
		await Bun.file(fixture).arrayBuffer()
	);
	store.importTranscript(source, null, [
		{ end: 0.8, id: crypto.randomUUID(), start: 0.2, text: "A harbor" },
	]);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${source.id}/inspect?thumbnail=0&samples=1`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			asset: { id: source.id, name: source.name, width: source.width },
			frames: [{ time: 0, data: expect.any(String) }],
			transcript: { cues: [{ text: "A harbor" }] },
		});
	} finally {
		app.stop();
	}
});

test("timeline route returns stable clip, gap, and frame metadata", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const clip = newSegment(source, 2, 0);
	clip.sourceOut = 6;
	const project = store.save({
		...store.create("Timeline summary route"),
		segments: [clip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/timeline`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			duration: 8,
			fps: 30,
			tracks: [
				{
					clips: [{ assetName: source.name, end: 8, start: 2 }],
					gaps: [{ end: 2, start: 0 }],
					trackId: "track-0",
				},
			],
			totalFrames: 240,
		});
	} finally {
		app.stop();
	}
});

test("timeline transcript route maps saved source captions", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const clip = newSegment(source, 3);
	clip.sourceIn = 1;
	clip.sourceOut = 5;
	store.importTranscript(source, null, [
		{ end: 3, id: crypto.randomUUID(), start: 1, text: "Mapped speech" },
	]);
	const project = store.save({
		...store.create("Transcript route"),
		segments: [clip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/transcript`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			clips: [
				{
					clipId: clip.id,
					cues: [{ start: 3, end: 5, text: "Mapped speech" }],
				},
			],
		});
	} finally {
		app.stop();
	}
});

test("remove-words route ripples transcript-selected timeline ranges", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const clip = newSegment(source);
	clip.sourceOut = 4;
	const project = store.save({
		...store.create("Remove words route"),
		segments: [clip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/remove-words`,
			{
				body: JSON.stringify({
					ranges: [{ end: 2, start: 1 }],
					revision: project.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		expect(
			projectSchema.parse(await response.json()).segments[0]
		).toMatchObject({
			start: 0,
			sourceOut: 1,
		});
	} finally {
		app.stop();
	}
});

test("search route returns indexed transcript ranges", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	store.importTranscript(source, null, [
		{
			id: crypto.randomUUID(),
			start: 1,
			end: 3,
			text: "Harbor at sunset",
		},
	]);
	const index = store.beginSearchIndex(source, "space-1", "Video Studio");
	const entry = index.entries[0]!;
	store.updateSearchEntry(source.id, index.revision, entry.key, "doc-1", true);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/search?q=harbor%20sunset`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			results: [{ assetId: source.id, assetName: source.name, docId: "doc-1" }],
		});
	} finally {
		app.stop();
	}
});

test("generation requests are idempotent and completion requires saved matching media", async () => {
	const store = await setup();
	const project = store.create("Production log");
	const input = {
		id: crypto.randomUUID(),
		projectId: project.id,
		kind: "video",
		prompt: "A forest at dawn",
		route: "managed",
		rationale: "Approved hero shot for the opening scene.",
	};
	const first = store.beginGeneration(input);
	expect(first.created).toBe(true);
	expect(store.beginGeneration(input).created).toBe(false);
	expect(() =>
		store.beginGeneration({ ...input, prompt: "Different request" })
	).toThrow(ConflictError);
	expect(() =>
		store.finishGeneration(input.id, {
			status: "completed",
			assetIds: [crypto.randomUUID()],
		})
	).toThrow("saved media");
	const output = asset();
	store.putAsset(output);
	const completed = store.finishGeneration(input.id, {
		status: "completed",
		assetIds: [output.id],
	});
	expect(completed.request.prompt).toBe(input.prompt);
	expect(completed.request.route).toBe("managed");
	expect(completed.request.rationale).toContain("hero shot");
	expect(completed.projectRevision).toBe(project.revision);
	expect(
		store.finishGeneration(input.id, {
			status: "completed",
			assetIds: [output.id],
		})
	).toEqual(completed);
	expect(() =>
		store.finishGeneration(input.id, { status: "incomplete" })
	).toThrow(ConflictError);
});

test("generation history is scoped to its project and records uncertain outcomes", async () => {
	const store = await setup();
	const a = store.create("First");
	const b = store.create("Second");
	const job = store.beginGeneration({
		id: crypto.randomUUID(),
		projectId: a.id,
		kind: "audio",
		prompt: "Hello",
		voice: "af_heart",
		speed: 1.2,
	}).job;
	store.finishGeneration(job.id, {
		status: "incomplete",
		message: "Connection ended before an outcome was recorded.",
	});
	expect(store.generationJobs(b.id)).toEqual([]);
	expect(store.generationJobs(a.id)[0]?.status).toBe("incomplete");
	expect(store.generationJobs(a.id)[0]?.request.speed).toBe(1.2);
});

test("restart marks unresolved generation for review without retrying or losing request details", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-generation-restart-"));
	let store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const project = store.create("Restart");
	const job = store.beginGeneration({
		id: crypto.randomUUID(),
		projectId: project.id,
		kind: "video",
		prompt: "Keep this request",
	}).job;
	store.close();
	store = new StudioStore(directory);
	expect(store.generationJob(job.id)?.status).toBe("interrupted");
	expect(store.generationJob(job.id)?.request).toEqual(job.request);
	expect(store.beginGeneration(job.request).created).toBe(false);
	const output = asset();
	store.putAsset(output);
	expect(
		store.finishGeneration(job.id, {
			status: "completed",
			assetIds: [output.id],
		}).status
	).toBe("completed");
});

describe("project ownership and editing", () => {
	test("saves atomically, checks revisions and retains history", async () => {
		const store = await setup();
		const p = store.create("Film");
		const a = asset();
		store.putAsset(a);
		p.segments = [newSegment(a)];
		const saved = store.save(p);
		expect(saved.revision).toBe(1);
		expect(store.history(p.id)[0]?.revision).toBe(0);
		expect(() => store.save(p)).toThrow(ConflictError);
		expect(store.project(p.id).segments).toHaveLength(1);
	});
	test("history route restores a selected revision as a new revision", async () => {
		const store = await setup();
		const initial = store.create("History restore");
		const changed = store.save({ ...initial, title: "Changed title" });
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${initial.id}/history`,
				{
					body: JSON.stringify({
						historyRevision: 0,
						revision: changed.revision,
					}),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(response.status).toBe(200);
			const restored = projectSchema.parse(await response.json());
			expect(restored).toMatchObject({ revision: 2, title: initial.title });
		} finally {
			app.stop();
		}
	});
	test("invalidates scene approvals when approved content changes", async () => {
		const store = await setup();
		const a = asset();
		store.putAsset(a);
		const p = store.create("Review");
		p.scenes = [
			{
				id: crypto.randomUUID(),
				title: "Opening",
				script: "Original",
				prompt: "",
				assetIds: [a.id],
				duration: 5,
				sourceIn: 0,
				approved: true,
			},
		];
		const saved = store.save(p);
		expect(saved.scenes[0]?.approved).toBe(false);
		const reviewed = store.save({
			...saved,
			scenes: [
				{
					...saved.scenes[0]!,
					reviewNotes: "Use the wider establishing take.",
					reviewStatus: "changes-requested",
				},
			],
		});
		expect(reviewed.scenes[0]?.reviewStatus).toBe("changes-requested");
		const approved = store.approveScene(
			reviewed.id,
			reviewed.revision,
			reviewed.scenes[0]!.id,
			true
		);
		expect(approved.scenes[0]?.approved).toBe(true);
		expect(approved.scenes[0]?.reviewStatus).toBe("approved");
		expect(() =>
			store.approveScene(
				reviewed.id,
				reviewed.revision,
				reviewed.scenes[0]!.id,
				true
			)
		).toThrow(ConflictError);
		approved.scenes[0]!.script = "Revised";
		const changed = store.save(approved);
		expect(changed.scenes[0]?.approved).toBe(false);
		expect(changed.scenes[0]?.reviewStatus).toBe("in-review");
	});
	test("split preserves source time at non-unit speed", () => {
		const s = {
			...newSegment(asset()),
			sourceIn: 2,
			sourceOut: 8,
			speed: 2,
			start: 4,
		};
		const [left, right] = splitSegment(s, 5);
		expect(left.sourceOut).toBe(4);
		expect(right.sourceIn).toBe(4);
		expect(right.start).toBe(5);
		expect(() => splitSegment(s, 4)).toThrow();
	});
	test("track settings name, isolate audio, and lock edits", () => {
		const project = newProject("Tracks");
		const dialogue = updateTrackSetting(project, 1, {
			name: "Dialogue",
			solo: true,
		});
		const locked = updateTrackSetting(dialogue, 2, { locked: true });
		expect(trackSettingFor(locked, 1)).toMatchObject({
			name: "Dialogue",
			solo: true,
		});
		expect(isTrackAudible(locked, 1)).toBe(true);
		expect(isTrackAudible(locked, 0)).toBe(false);
		expect(isTrackAudible(locked, 2)).toBe(false);
		expect(trackSettingFor(locked, 2).locked).toBe(true);
		expect(() =>
			validateProject(
				{
					...locked,
					trackSettings: [...locked.trackSettings, trackSettingFor(locked, 2)],
				},
				[]
			)
		).toThrow("Duplicate timeline track setting");
	});
	test("rejects invalid timing and unresolved assets", async () => {
		const store = await setup();
		const a = asset();
		const p = store.create("Validation");
		p.segments = [newSegment(a)];
		expect(() => validateProject(p, [])).toThrow();
		p.segments[0]!.sourceOut = 11;
		expect(() => validateProject(p, [a])).toThrow();
		p.segments[0]!.sourceOut = 10;
		p.segments[0]!.speed = Number.NaN;
		expect(() => validateProject(p, [a])).toThrow();
	});
	test("imports timed captions and round-trips SRT/VTT", () => {
		const input = "1\n00:00:00,500 --> 00:00:02,250\nHello\nworld\n";
		const cues = parseSubtitles(input);
		expect(cues[0]?.start).toBe(0.5);
		expect(cues[0]?.end).toBe(2.25);
		expect(parseSubtitles(subtitleText(cues, "vtt"))[0]?.text).toBe(
			"Hello\nworld"
		);
		expect(() =>
			parseSubtitles("1\n00:00:02,000 --> 00:00:01,000\nWrong")
		).toThrow();
	});
});

test("caption route edits source and localization tracks with revision checks", async () => {
	const store = await setup();
	const project = store.save({
		...store.create("Caption route"),
		captions: [
			{
				end: 1,
				id: crypto.randomUUID(),
				start: 0,
				text: "Source",
			},
		],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/captions`,
			{
				body: JSON.stringify({
					action: "append",
					captions: [
						{
							end: 2,
							id: crypto.randomUUID(),
							start: 1,
							text: "Next",
						},
					],
					revision: project.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		expect(projectSchema.parse(await response.json()).captions).toHaveLength(2);
	} finally {
		app.stop();
	}
});

test("title route updates timed lower thirds with revision checks", async () => {
	const store = await setup();
	const initialTitle = {
		animation: "fade" as const,
		color: "#ffffff",
		end: 2,
		fadeIn: 0.2,
		fadeOut: 0.2,
		fontSize: 0.08,
		id: crypto.randomUUID(),
		start: 0,
		text: "Opening",
		x: 0.5,
		y: 0.5,
	};
	const project = store.save({
		...store.create("Title route"),
		titles: [initialTitle],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/titles`,
			{
				body: JSON.stringify({
					action: "update",
					patch: { text: "Updated" },
					revision: project.revision,
					titleId: initialTitle.id,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		expect(projectSchema.parse(await response.json()).titles[0]?.text).toBe(
			"Updated"
		);
	} finally {
		app.stop();
	}
});

test("color route applies a bounded grade without a full project PUT", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const clip = newSegment(source);
	const project = store.save({
		...store.create("Color route"),
		segments: [clip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/color`,
			{
				body: JSON.stringify({
					clipIds: [clip.id],
					patch: { exposure: 1 },
					revision: project.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		expect(
			projectSchema.parse(await response.json()).segments[0]?.colorGrade
		).toMatchObject({
			exposure: 1,
		});
	} finally {
		app.stop();
	}
});

test("effects route replaces a visual effect stack with revision checks", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const clip = newSegment(source);
	const project = store.save({
		...store.create("Effects route"),
		segments: [clip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/effects`,
			{
				body: JSON.stringify({
					clipIds: [clip.id],
					effects: [{ amount: 0.75, enabled: true, type: "sharpen" }],
					revision: project.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		expect(
			projectSchema.parse(await response.json()).segments[0]?.effects
		).toEqual([{ amount: 0.75, enabled: true, type: "sharpen" }]);
	} finally {
		app.stop();
	}
});

test("animation interpolation and splitting preserve motion", () => {
	const s = newSegment(asset());
	s.keyframes = [
		{ id: crypto.randomUUID(), property: "scale", time: 0, value: 1 },
		{ id: crypto.randomUUID(), property: "scale", time: 4, value: 2 },
		{ id: crypto.randomUUID(), property: "rotation", time: 0, value: -10 },
		{ id: crypto.randomUUID(), property: "rotation", time: 4, value: 30 },
		{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 0 },
		{ id: crypto.randomUUID(), property: "opacity", time: 4, value: 1 },
	];
	expect(animatedValue(s, "scale", 2)).toBe(1.5);
	expect(animatedValue(s, "rotation", 2)).toBe(10);
	expect(animatedValue(s, "opacity", 2)).toBe(0.5);
	const [left, right] = splitSegment(s, 2);
	expect(animatedValue(left, "scale", 2)).toBe(1.5);
	expect(animatedValue(left, "rotation", 2)).toBe(10);
	expect(animatedValue(left, "opacity", 2)).toBe(0.5);
	expect(animatedValue(right, "scale", 0)).toBe(1.5);
	expect(animatedValue(right, "scale", 1)).toBe(1.75);
	expect(animatedValue(right, "rotation", 0)).toBe(10);
	expect(animatedValue(right, "rotation", 1)).toBe(20);
	expect(animatedValue(right, "opacity", 0)).toBe(0.5);
	expect(animatedValue(right, "opacity", 1)).toBe(0.75);
});

test("source analysis parses media timestamps and audio levels", () => {
	expect(
		parseSceneCuts("frame:0 pts:10 pts_time:1.25\nlavfi.scene_score=0.8\n", 4)
	).toEqual([1.25]);
	const bins = parseWaveform(
		"frame:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-20\nframe:1 pts_time:0.1\nlavfi.astats.Overall.RMS_level=-inf",
		1
	);
	expect(bins[0]).toBeCloseTo(0.1);
	expect(bins[1]).toBe(0);
});
test("upgrades v1 storage and recovers interrupted analysis without losing projects", async () => {
	const store = await setup();
	const project = store.create("Existing film");
	store.db.exec("DROP TABLE analyses; PRAGMA user_version=1;");
	const upgraded = new StudioStore(store.directory);
	expect(upgraded.project(project.id).title).toBe("Existing film");
	const a = asset();
	upgraded.putAsset(a);
	upgraded.putAnalysis({
		assetId: a.id,
		status: "running",
		createdAt: new Date().toISOString(),
		sceneCuts: [],
		waveform: [],
		duration: a.duration,
	});
	upgraded.close();
	const recovered = new StudioStore(store.directory);
	expect(recovered.analysis(a.id)?.status).toBe("failed");
	recovered.close();
});

test("approval-required exports reject media outside approved scenes", async () => {
	const store = await setup();
	const approvedAsset = asset();
	const otherAsset = asset();
	store.putAsset(approvedAsset);
	store.putAsset(otherAsset);
	const project = store.create("Approved takes only");
	project.requireApproval = true;
	project.segments = [newSegment(otherAsset)];
	project.scenes = [
		{
			id: crypto.randomUUID(),
			title: "Approved",
			script: "",
			prompt: "",
			assetIds: [approvedAsset.id],
			duration: 5,
			sourceIn: 0,
			approved: false,
		},
	];
	const saved = store.save(project);
	const approved = store.approveScene(
		saved.id,
		saved.revision,
		saved.scenes[0]!.id,
		true
	);
	expect(() => new RenderQueue(store).start(approved)).toThrow(
		"not been approved"
	);
});

test("canceling an export persists a canceled job and restart fails pending jobs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-render-restart-"));
	let store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	const project = store.create("Cancelable export");
	project.avatars = [
		{
			accent: "#f97316",
			animation: "idle",
			depth: 0.4,
			end: 30,
			entryDuration: 0.2,
			height: 0.6,
			id: crypto.randomUUID(),
			outfit: "#4f46e5",
			pose: "neutral",
			skin: "#f4c7a1",
			start: 0,
			width: 0.3,
			x: 0.4,
			y: 0.2,
		},
	];
	const queue = new RenderQueue(store);
	const job = queue.start(project);
	queue.cancel(job.id);
	for (let attempt = 0; attempt < 50; attempt++) {
		const current = store.jobs().find((candidate) => candidate.id === job.id);
		if (current?.status === "canceled") {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(
		store.jobs().find((candidate) => candidate.id === job.id)?.status
	).toBe("canceled");
	const pending = {
		...job,
		id: crypto.randomUUID(),
		status: "pending" as const,
	};
	store.putJob(pending);
	store.close();
	store = new StudioStore(directory);
	expect(
		store.jobs().find((candidate) => candidate.id === pending.id)
	).toMatchObject({
		status: "failed",
		error: "Rendering was interrupted by a restart. Retry the export.",
	});
});

test("storyboard assembly respects source ranges and scene order", async () => {
	const store = await setup();
	const source = asset();
	const project = store.create("Scene assembly");
	project.scenes = [
		{
			id: crypto.randomUUID(),
			title: "Opening",
			script: "",
			prompt: "",
			assetIds: [source.id],
			approved: false,
			duration: 2,
			sourceIn: 1,
		},
		{
			id: crypto.randomUUID(),
			title: "Closing",
			script: "",
			prompt: "",
			assetIds: [source.id],
			approved: false,
			duration: 3,
			sourceIn: 4,
		},
	];
	const assembled = assembleStoryboard(project, [source], true);
	expect(
		assembled.segments.map((s) => [s.start, s.sourceIn, s.sourceOut])
	).toEqual([
		[0, 1, 3],
		[2, 4, 7],
	]);
	expect(assembled.titles.map((t) => [t.text, t.start, t.end])).toEqual([
		["Opening", 0, 2],
		["Closing", 2, 5],
	]);
	project.requireApproval = true;
	expect(() => assembleStoryboard(project, [source], true)).toThrow(
		"Approve each scene"
	);
});
test("titles support title-only timelines and reject unsafe style values", async () => {
	const store = await setup();
	const project = store.create("Title card");
	project.titles = [
		{
			id: crypto.randomUUID(),
			start: 0,
			end: 3,
			text: "Hello",
			x: 0.5,
			y: 0.5,
			fontSize: 0.1,
			color: "#ffffff",
			fadeIn: 0.2,
			fadeOut: 0.2,
			animation: "fade",
		},
	];
	expect(validateProject(project, []).titles).toHaveLength(1);
	project.titles[0]!.animation = "slide-up";
	expect(assCaptions(project)).toContain("\\move(");
	project.titles[0]!.color = "red;movie=file";
	expect(() => validateProject(project, [])).toThrow();
});

test("ASS captions and subtitle downloads use the selected localized track", () => {
	const source = {
		end: 2,
		id: crypto.randomUUID(),
		start: 0,
		text: "Hello world",
	};
	const translated = { ...source, text: "Bonjour le monde" };
	const track = {
		captions: [translated],
		id: crypto.randomUUID(),
		label: "Français",
		language: "fr",
	};
	const project = {
		...newProject(),
		captionTracks: [track],
		captionTrackId: track.id,
		captions: [source],
	};

	expect(activeCaptions(project)[0]?.text).toBe("Bonjour le monde");
	expect(assCaptions(project)).toContain("Bonjour le monde");
});

test("ducked audio uses the other audio layers as a sidechain", async () => {
	const store = await setup();
	const music = {
		...asset(),
		id: crypto.randomUUID(),
		kind: "audio" as const,
		duration: 4,
		width: 0,
		height: 0,
		hasAudio: true,
	};
	const voice = {
		...music,
		id: crypto.randomUUID(),
		name: "Voice",
	};
	store.putAsset(music);
	store.putAsset(voice);
	const project = store.create("Ducking");
	project.segments = [
		{ ...newSegment(music), duckUnderVoice: true },
		{ ...newSegment(voice), start: 0, track: 1 },
	];
	const args = buildRender(project, [music, voice], (id) => `/tmp/${id}`);
	const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
	expect(filter).toContain("sidechaincompress");
	expect(filter).toContain("sidechainMix");
});

test("audio processing uses the selected local enhancement graph", () => {
	const source = {
		...asset(),
		id: crypto.randomUUID(),
		kind: "audio" as const,
		duration: 4,
		width: 0,
		height: 0,
		hasAudio: true,
	};
	const project = newProject("Audio processing");
	project.segments = [{ ...newSegment(source), audioProcessing: "normalize" }];
	const normalized = buildRender(project, [source], (id) => `/tmp/${id}`);
	const normalizedFilter =
		normalized[normalized.indexOf("-filter_complex") + 1] ?? "";
	expect(normalizedFilter).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
	project.segments = [{ ...newSegment(source), audioProcessing: "denoise" }];
	const denoised = buildRender(project, [source], (id) => `/tmp/${id}`);
	const denoiseFilter = denoised[denoised.indexOf("-filter_complex") + 1] ?? "";
	expect(denoiseFilter).toContain("afftdn=nr=18:nf=-35");
	project.segments = [
		{ ...newSegment(source), audioProcessing: "voice-enhance" },
	];
	const enhanced = buildRender(project, [source], (id) => `/tmp/${id}`);
	const enhancedFilter =
		enhanced[enhanced.indexOf("-filter_complex") + 1] ?? "";
	expect(enhancedFilter).toContain("highpass=f=80");
	expect(enhancedFilter).toContain("afftdn=nr=12");
});

test("track mute and solo state controls rendered audio labels", () => {
	const first = {
		...asset(),
		id: crypto.randomUUID(),
		kind: "audio" as const,
		duration: 4,
		width: 0,
		height: 0,
		hasAudio: true,
	};
	const second = { ...first, id: crypto.randomUUID(), name: "Second" };
	const project = newProject("Track audio");
	project.segments = [newSegment(first, 0, 0), newSegment(second, 0, 1)];
	const mixed = buildRender(project, [first, second], (id) => `/tmp/${id}`);
	const mixedFilter = mixed[mixed.indexOf("-filter_complex") + 1] ?? "";
	expect(mixedFilter).toContain("[a1]");
	expect(mixedFilter).toContain("[a2]");
	project.trackSettings = [
		trackSettingFor(project, 0),
		{ ...trackSettingFor(project, 1), muted: true },
	];
	const muted = buildRender(project, [first, second], (id) => `/tmp/${id}`);
	const mutedFilter = muted[muted.indexOf("-filter_complex") + 1] ?? "";
	expect(mutedFilter).toContain("[a1]");
	expect(mutedFilter).not.toContain("[a2]");
	project.trackSettings = [
		{ ...trackSettingFor(project, 0), solo: true },
		trackSettingFor(project, 1),
	];
	const solo = buildRender(project, [first, second], (id) => `/tmp/${id}`);
	const soloFilter = solo[solo.indexOf("-filter_complex") + 1] ?? "";
	expect(soloFilter).toContain("[a1]");
	expect(soloFilter).not.toContain("[a2]");
});

test("visual effects use the selected local filter graph", () => {
	const source = { ...asset(), kind: "video" as const, duration: 2 };
	const project = newProject("Visual effects");
	project.segments = [
		{
			...newSegment(source),
			edgeRounding: 0.18,
			edgeSoftness: 6,
			keyframes: [
				{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 0 },
				{ id: crypto.randomUUID(), property: "opacity", time: 2, value: 1 },
			],
			rotation: 45,
			visualEffect: "grayscale",
		},
	];
	const args = buildRender(project, [source], (id) => `/tmp/${id}`);
	const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
	expect(filter).toContain("hue=s=0");
	expect(filter).toContain(
		"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(if(lt"
	);
	expect(filter).toContain("hypot(X-min(W,H)*0.18");
	expect(filter).toContain("boxblur=lr=0:lp=0:cr=0:cp=0:ar=6:ap=1");
	expect(filter).toContain("rotate=a='(45)*PI/180'");
	project.segments = [{ ...newSegment(source), visualEffect: "sepia" }];
	const sepiaArgs = buildRender(project, [source], (id) => `/tmp/${id}`);
	const sepiaFilter = sepiaArgs[sepiaArgs.indexOf("-filter_complex") + 1] ?? "";
	expect(sepiaFilter).toContain("colorchannelmixer=.393:.769:.189");
	project.segments = [
		{
			...newSegment(source),
			colorGrade: { exposure: 1, temperature: 0.2, tint: -0.1, vibrance: 0.4 },
			crop: { bottom: 0.1, left: 0.2, right: 0.1, top: 0.05 },
			effects: [{ amount: 1, enabled: true, type: "sharpen" }],
		},
	];
	const cropArgs = buildRender(project, [source], (id) => `/tmp/${id}`);
	const cropFilter = cropArgs[cropArgs.indexOf("-filter_complex") + 1] ?? "";
	expect(cropFilter).toContain("crop=w='iw*(1-");
	expect(cropFilter).toContain("x='iw*0.2'");
	expect(cropFilter).toContain("colorbalance=rs=0.2:gs=-0.1:bs=-0.2");
	expect(cropFilter).toContain("unsharp=lx=3:ly=3:la=1.500");
});

test("generated stage-world orbit expressions stay valid for FFmpeg", () => {
	const project = newProject("Stage world render");
	const world = generateStageWorld(
		"A coastal village with a river and a beacon"
	);
	const args = buildRender(
		{
			...project,
			spatialObjects: world.objects,
			stageCamera: world.camera,
		},
		[],
		() => "/tmp/world"
	);
	const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
	expect(filter).toContain("(-1)*sin");
	expect(filter).not.toContain("+-sin");
});

test("export codecs and presets select bounded encoder profiles", () => {
	const project = newProject("Export presets");
	const image = {
		...asset(),
		kind: "image" as const,
		duration: 1,
		hasAudio: false,
	};
	const renderProject = { ...project, segments: [newSegment(image)] };
	const args = (preset: Project["exportPreset"]) =>
		buildRender(
			{ ...renderProject, exportPreset: preset },
			[image],
			() => "/tmp/preset"
		);
	const review = args("review");
	const social = args("social");
	const master = args("master");
	expect(
		review.slice(review.indexOf("-preset"), review.indexOf("-pix_fmt"))
	).toEqual(["-preset", "veryfast", "-crf", "26"]);
	expect(
		social.slice(social.indexOf("-preset"), social.indexOf("-pix_fmt"))
	).toEqual(["-preset", "medium", "-crf", "21"]);
	expect(
		master.slice(master.indexOf("-preset"), master.indexOf("-pix_fmt"))
	).toEqual(["-preset", "fast", "-crf", "20"]);
	const h265 = buildRender(
		{ ...renderProject, exportCodec: "h265" },
		[image],
		() => "/tmp/h265"
	);
	expect(h265.slice(h265.indexOf("-c:v"), h265.indexOf("-movflags"))).toEqual([
		"-c:v",
		"libx265",
		"-preset",
		"fast",
		"-crf",
		"24",
		"-pix_fmt",
		"yuv420p",
		"-tag:v",
		"hvc1",
	]);
	const prores = buildRender(
		{ ...renderProject, exportCodec: "prores" },
		[image],
		() => "/tmp/prores"
	);
	expect(prores.slice(prores.indexOf("-c:v"))).toContainEqual("prores_ks");
	expect(prores.slice(prores.indexOf("-c:v"))).toContainEqual("yuv422p10le");
});

test("agent discovery covers every manifest HTTP operation", async () => {
	const manifest = await Bun.file(
		new URL("../../manifest.json", import.meta.url)
	).json();
	const paths = openapi().paths as Record<string, Record<string, unknown>>;
	for (const route of manifest.sidecars[0].http.routes) {
		const path = `/api/video-studio${route.path.replace(/:id/g, "{id}")}`;
		expect(paths[path]?.[route.method.toLowerCase()]).toBeDefined();
	}
});

test("ripple-delete route applies the shared range edit at the current revision", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const project = store.create("Range route");
	const saved = store.save({
		...project,
		segments: [{ ...newSegment(source), sourceOut: 4 }],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${saved.id}/ripple-delete`,
			{
				body: JSON.stringify({
					end: 2,
					revision: saved.revision,
					start: 1,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result.revision).toBe(saved.revision + 1);
		expect(
			result.segments.map((segment) => [
				segment.start,
				segment.sourceIn,
				segment.sourceOut,
			])
		).toEqual([
			[0, 0, 1],
			[1, 2, 4],
		]);
	} finally {
		app.stop();
	}
});

test("tracks route persists named mute, solo, and lock state with revision checks", async () => {
	const store = await setup();
	const project = store.create("Track route");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/tracks`,
			{
				body: JSON.stringify({
					locked: true,
					muted: true,
					name: "Dialogue",
					revision: project.revision,
					solo: true,
					track: 1,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result.trackSettings).toEqual([
			{ locked: true, muted: true, name: "Dialogue", solo: true, track: 1 },
		]);
		expect(result.revision).toBe(project.revision + 1);
		const conflict = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/tracks`,
			{
				body: JSON.stringify({
					revision: project.revision,
					track: 1,
					muted: false,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(conflict.status).toBe(409);
	} finally {
		app.stop();
	}
});

test("decision route appends an immutable production choice with revision checks", async () => {
	const store = await setup();
	const project = store.create("Decision log");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/decisions`,
			{
				body: JSON.stringify({
					category: "render_runtime",
					decision: "Use FFmpeg for the local delivery render.",
					optionsConsidered: ["FFmpeg", "Remotion"],
					rationale:
						"The current edit is a source-footage cut and needs deterministic local encoding.",
					revision: project.revision,
					subject: "Composition runtime",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const saved = projectSchema.parse(await response.json());
		expect(saved.decisions).toHaveLength(1);
		expect(saved.decisions[0]).toMatchObject({
			category: "render_runtime",
			decision: "Use FFmpeg for the local delivery render.",
			subject: "Composition runtime",
		});
		expect(saved.revision).toBe(project.revision + 1);
		const read = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/decisions`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect((await read.json()).decisions).toHaveLength(1);
		const conflict = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/decisions`,
			{
				body: JSON.stringify({
					category: "render_runtime",
					decision: "Switch runtime.",
					revision: project.revision,
					subject: "Composition runtime",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(conflict.status).toBe(409);
	} finally {
		app.stop();
	}
});

test("timeline workspace routes create, duplicate, list, and read projects", async () => {
	const store = await setup();
	const source = store.create("Source timeline");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const created = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/timelines`,
			{
				body: JSON.stringify({ from: source.id, title: "Alternate timeline" }),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(created.status).toBe(201);
		const alternate = projectSchema.parse(await created.json());
		expect(alternate.title).toBe("Alternate timeline");
		expect(alternate.id).not.toBe(source.id);
		expect(alternate.revision).toBe(0);
		const listed = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/timelines`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect((await listed.json()).timelines).toHaveLength(2);
		const read = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/timelines/${alternate.id}`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect((await read.json()).id).toBe(alternate.id);
	} finally {
		app.stop();
	}
});

test("stage route advances production checkpoints with ordering and conflicts", async () => {
	const store = await setup();
	const project = store.create("Stage checkpoints");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const blocked = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/stages`,
			{
				body: JSON.stringify({
					action: "start",
					revision: project.revision,
					stage: "edit",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(blocked.status).toBe(400);
		const start = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/stages`,
			{
				body: JSON.stringify({
					action: "start",
					note: "Research sources before writing the brief.",
					revision: project.revision,
					stage: "research",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(start.status).toBe(200);
		const active = projectSchema.parse(await start.json());
		expect(active.stages[0]).toMatchObject({
			id: "research",
			status: "active",
		});
		const complete = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/stages`,
			{
				body: JSON.stringify({
					action: "complete",
					revision: active.revision,
					stage: "research",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(complete.status).toBe(200);
		const finished = projectSchema.parse(await complete.json());
		expect(finished.stages[0]?.status).toBe("complete");
		const read = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/stages`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect((await read.json()).stages[0]?.status).toBe("complete");
	} finally {
		app.stop();
	}
});

test("stage-world route creates a revisioned editable world and camera path", async () => {
	const store = await setup();
	const project = store.create("World composition");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/stage-world`,
			{
				body: JSON.stringify({
					prompt: "A coastal village with a river and a beacon",
					revision: project.revision,
					startTime: 2,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const generated = projectSchema.parse(await response.json());
		expect(generated.stageWorldPrompt).toContain("coastal");
		expect(generated.spatialObjects).toHaveLength(8);
		expect(generated.stageCamera.keyframes).toHaveLength(15);
		expect(generated.revision).toBe(project.revision + 1);
	} finally {
		app.stop();
	}
});

test("preflight route combines gates, stages, decisions, and budget state", async () => {
	const store = await setup();
	const project = store.save({
		...store.create("Preflight snapshot"),
		brief: "A short product film",
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/preflight`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		const snapshot = (await response.json()) as {
			blockers: unknown[];
			decisions: number;
			nextStage: string | null;
			stages: { completed: number; total: number };
		};
		expect(snapshot.blockers.length).toBeGreaterThan(0);
		expect(snapshot.decisions).toBe(0);
		expect(snapshot.nextStage).toBe("research");
		expect(snapshot.stages).toEqual({ completed: 0, total: 7 });
	} finally {
		app.stop();
	}
});

test("soundtrack route creates an app-owned local audio asset", async () => {
	const store = await setup();
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/soundtrack`,
			{
				body: JSON.stringify({ bpm: 100, duration: 1, mood: "bright" }),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		if (response.status !== 201) {
			throw new Error(`Soundtrack request failed: ${await response.text()}`);
		}
		expect(response.status).toBe(201);
		const asset = assetSchema.parse(await response.json());
		expect(asset.kind).toBe("audio");
		expect(asset.duration).toBeGreaterThan(0.9);
		expect(asset.name).toContain("bright soundtrack");
	} finally {
		app.stop();
	}
});

test("undo route restores the newest saved revision with a conflict check", async () => {
	const store = await setup();
	const original = store.create("Undo source");
	const changed = store.save({ ...original, title: "Changed title" });
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${changed.id}/undo`,
			{
				body: JSON.stringify({ revision: changed.revision }),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const undone = projectSchema.parse(await response.json());
		expect(undone.title).toBe(original.title);
		expect(undone.revision).toBe(changed.revision + 1);
		const conflict = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${changed.id}/undo`,
			{
				body: JSON.stringify({ revision: changed.revision }),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(conflict.status).toBe(409);
	} finally {
		app.stop();
	}
});

test("track reorder route moves clips and saved settings together", async () => {
	const store = await setup();
	const assets = Array.from({ length: 3 }, (_, index) => ({
		...asset(),
		id: crypto.randomUUID(),
		name: `Track source ${index + 1}`,
	}));
	for (const item of assets) {
		store.putAsset(item);
	}
	let project = store.create("Track reorder");
	project = store.save({
		...project,
		segments: assets.map((item, track) => newSegment(item, track, track)),
		trackSettings: [0, 1, 2].map((track) => ({
			locked: track === 2,
			muted: track === 1,
			name: `Lane ${track + 1}`,
			solo: false,
			track,
		})),
	});
	expect(trackOrderFor(project)).toEqual([0, 1, 2]);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/tracks/reorder`,
			{
				body: JSON.stringify({
					order: [2, 0, 1],
					revision: project.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result.segments.map((segment) => segment.track)).toEqual([1, 2, 0]);
		expect(result.trackSettings).toEqual([
			{ locked: true, muted: false, name: "Lane 3", solo: false, track: 0 },
			{ locked: false, muted: false, name: "Lane 1", solo: false, track: 1 },
			{ locked: false, muted: true, name: "Lane 2", solo: false, track: 2 },
		]);
		const conflict = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/tracks/reorder`,
			{
				body: JSON.stringify({ order: [0, 1, 2], revision: project.revision }),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(conflict.status).toBe(409);
	} finally {
		app.stop();
	}
});

test("layout route applies ordered visual slots with revision checks", async () => {
	const store = await setup();
	const first = asset();
	const second = { ...asset(), id: crypto.randomUUID(), name: "Second" };
	store.putAsset(first);
	store.putAsset(second);
	const project = store.save({
		...store.create("Layout route"),
		segments: [newSegment(first), newSegment(second, 0, 1)],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/layout`,
			{
				body: JSON.stringify({
					layout: "side-by-side",
					revision: project.revision,
					segmentIds: project.segments.map((segment) => segment.id),
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result.segments.map(({ x, scale }) => ({ scale, x }))).toEqual([
			{ scale: 0.5, x: -0.5 },
			{ scale: 0.5, x: 0.5 },
		]);
		expect(result.revision).toBe(project.revision + 1);
	} finally {
		app.stop();
	}
});

test("layout route accepts larger deterministic grids", async () => {
	const store = await setup();
	const assets = Array.from({ length: 9 }, (_, index) => ({
		...asset(),
		id: crypto.randomUUID(),
		name: `Angle ${index + 1}`,
	}));
	for (const item of assets) {
		store.putAsset(item);
	}
	const project = store.save({
		...store.create("Large layout route"),
		segments: assets.map((item, index) => newSegment(item, index)),
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/layout`,
			{
				body: JSON.stringify({
					layout: "grid-3x3",
					revision: project.revision,
					segmentIds: project.segments.map((segment) => segment.id),
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result.segments).toHaveLength(9);
		expect(result.segments[8]?.scale).toBeCloseTo(1 / 3, 12);
		expect(result.segments[8]?.x).toBeCloseTo(2 / 3, 12);
		expect(result.segments[8]?.y).toBeCloseTo(2 / 3, 12);
	} finally {
		app.stop();
	}
});

test("timeline clip routes add, move, split, and remove revisions", async () => {
	const store = await setup();
	const first = asset();
	const second = { ...asset(), id: crypto.randomUUID(), name: "Second" };
	store.putAsset(first);
	store.putAsset(second);
	const firstClip = newSegment(first);
	const project = store.save({
		...store.create("Timeline clip routes"),
		segments: [firstClip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = (action: string, body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/${action}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	try {
		const addedResponse = await call("add", {
			at: 4,
			entries: [{ assetId: second.id, sourceIn: 1, sourceOut: 3 }],
			revision: project.revision,
			track: 1,
		});
		expect(addedResponse.status).toBe(200);
		const added = projectSchema.parse(await addedResponse.json());
		const addedClip = added.segments.find(
			(segment) => segment.assetId === second.id
		);
		if (!addedClip) {
			throw new Error("The added clip was not returned.");
		}
		expect(addedClip.start).toBe(4);
		const movedResponse = await call("move", {
			clipId: addedClip.id,
			revision: added.revision,
			start: 5.013,
			track: 2,
		});
		expect(movedResponse.status).toBe(200);
		const moved = projectSchema.parse(await movedResponse.json());
		expect(
			moved.segments.find((segment) => segment.id === addedClip.id)
		).toMatchObject({
			start: 5,
			track: 2,
		});
		const keyedResponse = await call("keyframes", {
			clipId: firstClip.id,
			keyframes: [{ time: 0, value: 18 }],
			property: "rotation",
			revision: moved.revision,
		});
		expect(keyedResponse.status).toBe(200);
		const keyed = projectSchema.parse(await keyedResponse.json());
		expect(keyed.segments[0]?.keyframes).toMatchObject([
			{ property: "rotation", time: 0, value: 18 },
		]);
		const splitResponse = await call("split", {
			clipId: firstClip.id,
			revision: keyed.revision,
			time: 2,
		});
		expect(splitResponse.status).toBe(200);
		const split = projectSchema.parse(await splitResponse.json());
		expect(split.segments).toHaveLength(3);
		const removedResponse = await call("remove", {
			clipIds: [addedClip.id],
			revision: split.revision,
		});
		expect(removedResponse.status).toBe(200);
		const removed = projectSchema.parse(await removedResponse.json());
		expect(removed.segments).toHaveLength(2);
	} finally {
		app.stop();
	}
});

test("clip links route moves and removes linked audio/video groups", async () => {
	const store = await setup();
	const video = asset();
	const audio = {
		...asset(),
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio" as const,
		name: "Mic",
		width: 0,
	};
	store.putAsset(video);
	store.putAsset(audio);
	const videoClip = newSegment(video);
	videoClip.sourceOut = 4;
	const audioClip = newSegment(audio, 0, 1);
	audioClip.sourceOut = 5;
	const project = store.save({
		...store.create("Clip links"),
		segments: [videoClip, audioClip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = (action: string, body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/${action}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	try {
		const linkedResponse = await call("links", {
			action: "link",
			clipIds: [videoClip.id, audioClip.id],
			revision: project.revision,
		});
		expect(linkedResponse.status).toBe(200);
		const linked = projectSchema.parse(await linkedResponse.json());
		expect(linked.segments[0]?.linkGroupId).toBeTruthy();
		const movedResponse = await call("move", {
			clipId: videoClip.id,
			revision: linked.revision,
			start: 2,
			track: 0,
		});
		expect(movedResponse.status).toBe(200);
		const moved = projectSchema.parse(await movedResponse.json());
		expect(moved.segments.map((segment) => segment.start)).toEqual([2, 2]);
		const removedResponse = await call("remove", {
			clipIds: [videoClip.id],
			revision: moved.revision,
		});
		expect(removedResponse.status).toBe(200);
		expect(projectSchema.parse(await removedResponse.json()).segments).toEqual(
			[]
		);
	} finally {
		app.stop();
	}
});

test("sync route aligns audio clips with measured analysis and revision checks", async () => {
	const store = await setup();
	const referenceAsset = asset();
	const targetAsset = { ...asset(), id: crypto.randomUUID(), name: "Recorder" };
	store.putAsset(referenceAsset);
	store.putAsset(targetAsset);
	const referenceClip = newSegment(referenceAsset, 0, 0);
	const targetClip = newSegment(targetAsset, 2, 1);
	const project = store.save({
		...store.create("Sync route"),
		segments: [referenceClip, targetClip],
	});
	const values = Array.from(
		{ length: 100 },
		(_, index) => 0.1 + ((index * 29) % 17) / 22
	);
	const delayed = Array.from(
		{ length: 100 },
		(_, index) => values[index - 5] ?? 0
	);
	store.putAnalysis({
		assetId: referenceAsset.id,
		createdAt: new Date().toISOString(),
		duration: 10,
		sceneCuts: [],
		status: "completed",
		waveform: values,
	});
	store.putAnalysis({
		assetId: targetAsset.id,
		createdAt: new Date().toISOString(),
		duration: 10,
		sceneCuts: [],
		status: "completed",
		waveform: delayed,
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/sync`,
			{
				body: JSON.stringify({
					mode: "audio",
					referenceClipId: referenceClip.id,
					revision: project.revision,
					searchWindowSeconds: 2,
					targetClipIds: [targetClip.id],
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			matches: Array<{ method: string; offsetFrames: number }>;
			project: Project;
			shiftedFrames: number;
		};
		const saved = projectSchema.parse(result.project);
		expect(result).toMatchObject({
			matches: [{ method: "audio", offsetFrames: -60 }],
			shiftedFrames: 15,
		});
		expect(saved.revision).toBe(project.revision + 1);
		expect(saved.segments.map((segment) => segment.start)).toEqual([0.5, 0]);
		const conflict = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/sync`,
			{
				body: JSON.stringify({
					mode: "manual",
					offsetSeconds: 0,
					referenceClipId: referenceClip.id,
					revision: project.revision,
					targetClipIds: [targetClip.id],
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(conflict.status).toBe(409);
	} finally {
		app.stop();
	}
});

test("sync route aligns clips from embedded source timecode", async () => {
	const store = await setup();
	const referenceAsset = {
		...asset(),
		timecodeFrameRate: 30,
		timecodeStart: "01:00:00:00",
	};
	const targetAsset = {
		...asset(),
		id: crypto.randomUUID(),
		name: "Timecode recorder",
		timecodeFrameRate: 30,
		timecodeStart: "01:00:05:00",
	};
	store.putAsset(referenceAsset);
	store.putAsset(targetAsset);
	const referenceClip = newSegment(referenceAsset, 0, 0);
	const targetClip = newSegment(targetAsset, 0, 1);
	const project = store.save({
		...store.create("Timecode sync route"),
		segments: [referenceClip, targetClip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/sync`,
			{
				body: JSON.stringify({
					mode: "timecode",
					referenceClipId: referenceClip.id,
					revision: project.revision,
					targetClipIds: [targetClip.id],
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			matches: Array<{ alignmentOffsetSeconds: number; method: string }>;
			project: Project;
		};
		expect(result.matches[0]).toMatchObject({
			alignmentOffsetSeconds: -5,
			method: "timecode",
		});
		expect(result.project.segments[1]?.start).toBe(5);
	} finally {
		app.stop();
	}
});

test("interchange route exports saved timelines for FCPXML and Premiere", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const project = store.save({
		...store.create("Interchange route"),
		segments: [{ ...newSegment(source), sourceOut: 2 }],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		for (const format of ["fcpxml", "xmeml"] as const) {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/interchange?format=${format}`,
				{ headers: { authorization: `Bearer ${token}` } }
			);
			expect(response.status).toBe(200);
			const result = (await response.json()) as {
				filename: string;
				format: string;
				text: string;
			};
			expect(result.format).toBe(format);
			expect(result.filename).toMatch(
				format === "fcpxml" ? /\.fcpxml$/ : /\.xml$/
			);
			expect(result.text).toContain(
				format === "fcpxml" ? "<fcpxml" : "<!DOCTYPE xmeml>"
			);
			expect(result.text).toContain(source.name);
		}
		const invalid = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/interchange?format=edl`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(invalid.status).toBe(400);
	} finally {
		app.stop();
	}
});

test("settings route updates canvas, fps, and preset with revision checks", async () => {
	const store = await setup();
	const project = store.create("Settings route");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/settings`,
			{
				body: JSON.stringify({
					exportCodec: "h265",
					exportPreset: "review",
					fps: 60,
					height: 1920,
					revision: project.revision,
					styleProfile: "cinematic",
					width: 1080,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result).toMatchObject({
			exportCodec: "h265",
			exportPreset: "review",
			fps: 60,
			height: 1920,
			revision: project.revision + 1,
			styleProfile: "cinematic",
			width: 1080,
		});
		const ratioResponse = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/settings`,
			{
				body: JSON.stringify({
					aspectRatio: "1:1",
					revision: result.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(ratioResponse.status).toBe(200);
		const ratioResult = projectSchema.parse(await ratioResponse.json());
		expect(ratioResult).toMatchObject({
			height: 1080,
			revision: result.revision + 1,
			width: 1080,
		});
		const invalid = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/settings`,
			{
				body: JSON.stringify({
					aspectRatio: "16:9",
					height: 1080,
					revision: ratioResult.revision,
					width: 1920,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(invalid.status).toBe(400);
	} finally {
		app.stop();
	}
});

test("recipe route creates a zero-footage animated explainer", async () => {
	const store = await setup();
	const project = store.create("Explainer route");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/recipe`,
			{
				body: JSON.stringify({
					assetIds: [],
					audioId: null,
					format: "landscape",
					kind: "animated-explainer",
					revision: project.revision,
					shotDuration: 5,
					title: "Explain it",
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const result = projectSchema.parse(await response.json());
		expect(result.graphics).toHaveLength(3);
		expect(result.titles[0]?.text).toBe("Explain it");
		expect(projectDuration(result)).toBe(12);
	} finally {
		app.stop();
	}
});

test("research route appends and removes HTTPS source citations", async () => {
	const store = await setup();
	const project = store.create("Research route");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const url = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/research`;
		const append = await fetch(url, {
			body: JSON.stringify({
				action: "append",
				revision: project.revision,
				source: {
					id: crypto.randomUUID(),
					retrievedAt: new Date().toISOString(),
					title: "Example source",
					url: "https://example.com/research",
				},
			}),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
		expect(append.status).toBe(200);
		const saved = projectSchema.parse(await append.json());
		expect(saved.researchSources).toHaveLength(1);
		const remove = await fetch(url, {
			body: JSON.stringify({
				action: "remove",
				revision: saved.revision,
				sourceId: saved.researchSources[0]!.id,
			}),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
		expect(remove.status).toBe(200);
		expect(projectSchema.parse(await remove.json()).researchSources).toEqual(
			[]
		);
	} finally {
		app.stop();
	}
});

test("markers route manages review cues with revision checks", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const project = store.save({
		...store.create("Marker route"),
		segments: [newSegment(source)],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const url = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/markers`;
	const call = (body: unknown) =>
		fetch(url, {
			body: JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
	try {
		const createdResponse = await call({
			action: "create",
			comment: "Tighten this passage.",
			duration: 1.5,
			label: "Review",
			revision: project.revision,
			status: "review",
			time: 2,
		});
		expect(createdResponse.status).toBe(200);
		const created = (await createdResponse.json()) as {
			marker: Project["markers"][number];
			project: Project;
		};
		expect(created.marker).toMatchObject({
			comment: "Tighten this passage.",
			duration: 1.5,
			status: "review",
		});
		const updatedResponse = await call({
			action: "update",
			markerId: created.marker.id,
			revision: created.project.revision,
			status: "resolved",
			time: 3,
		});
		expect(updatedResponse.status).toBe(200);
		const updated = (await updatedResponse.json()) as {
			marker: Project["markers"][number];
			project: Project;
		};
		expect(updated.marker).toMatchObject({ status: "resolved", time: 3 });
		const deletedResponse = await call({
			action: "delete",
			markerId: created.marker.id,
			revision: updated.project.revision,
		});
		expect(deletedResponse.status).toBe(200);
		const deleted = projectSchema.parse(
			((await deletedResponse.json()) as { project: Project }).project
		);
		expect(deleted.markers).toEqual([]);
	} finally {
		app.stop();
	}
});

test("duplicate route creates an independent alternate cut", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const project = store.save({
		...store.create("Master cut"),
		exportCodec: "prores",
		segments: [newSegment(source)],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/duplicate`,
			{
				body: JSON.stringify({ title: "Social cut" }),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(201);
		const copy = projectSchema.parse(await response.json());
		expect(copy).toMatchObject({
			exportCodec: "prores",
			revision: 0,
			title: "Social cut",
		});
		expect(copy.id).not.toBe(project.id);
		expect(copy.segments).toEqual(project.segments);
		expect(store.projects()).toHaveLength(2);
	} finally {
		app.stop();
	}
});

test("multicam route creates, switches, reads, and ungroups a session", async () => {
	const store = await setup();
	const wide = asset();
	const close = { ...asset(), id: crypto.randomUUID(), name: "Close" };
	const mic = {
		...asset(),
		duration: 6,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio" as const,
		name: "Recorder",
		width: 0,
	};
	store.putAsset(wide);
	store.putAsset(close);
	store.putAsset(mic);
	const project = store.create("Multicam route");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const url = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/multicam`;
	const call = (body?: unknown) =>
		fetch(url, {
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			method: body === undefined ? "GET" : "POST",
		});
	try {
		const createdResponse = await call({
			action: "create",
			members: [
				{ assetId: wide.id, kind: "angle", label: "Wide" },
				{ assetId: close.id, kind: "angle", label: "Close" },
				{ assetId: mic.id, kind: "mic", label: "Recorder" },
			],
			revision: project.revision,
		});
		expect(createdResponse.status).toBe(200);
		const created = (await createdResponse.json()) as {
			group: { id: string };
			project: Project;
		};
		const saved = projectSchema.parse(created.project);
		expect(saved.multicamGroups).toHaveLength(1);
		expect(saved.segments).toHaveLength(2);
		const groupId = created.group.id;
		const read = await call();
		expect(await read.json()).toEqual({ groups: saved.multicamGroups });
		const changedResponse = await call({
			action: "change",
			entries: [{ angle: "Close", end: 3, start: 1 }],
			groupId,
			revision: saved.revision,
		});
		expect(changedResponse.status).toBe(200);
		const changed = projectSchema.parse(
			((await changedResponse.json()) as { project: Project }).project
		);
		expect(changed.multicamGroups[0]?.switches).toEqual([
			{ angle: "Wide", end: 1, start: 0 },
			{ angle: "Close", end: 3, start: 1 },
			{ angle: "Wide", end: 6, start: 3 },
		]);
		const ungroupedResponse = await call({
			action: "ungroup",
			groupId,
			revision: changed.revision,
		});
		expect(ungroupedResponse.status).toBe(200);
		const ungrouped = projectSchema.parse(
			((await ungroupedResponse.json()) as { project: Project }).project
		);
		expect(ungrouped.multicamGroups).toEqual([]);
		expect(ungrouped.segments).toHaveLength(4);
	} finally {
		app.stop();
	}
});

test("clip edit routes patch, copy, and swap granular timeline properties", async () => {
	const store = await setup();
	const first = asset();
	const second = { ...asset(), id: crypto.randomUUID(), name: "Second" };
	const replacement = {
		...asset(),
		id: crypto.randomUUID(),
		name: "Replacement",
	};
	store.putAsset(first);
	store.putAsset(second);
	store.putAsset(replacement);
	const firstClip = newSegment(first, 0, 0);
	firstClip.rotation = 24;
	firstClip.visualEffect = "grayscale";
	const secondClip = newSegment(second, 2, 1);
	secondClip.sourceOut = 4;
	const project = store.save({
		...store.create("Clip edit routes"),
		segments: [firstClip, secondClip],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = (path: string, body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/${path}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	try {
		const patchedResponse = await call("clip-properties", {
			clipId: firstClip.id,
			patch: { rotation: 12, visualEffect: "sepia" },
			revision: project.revision,
		});
		expect(patchedResponse.status).toBe(200);
		const patched = projectSchema.parse(await patchedResponse.json());
		expect(patched.segments[0]).toMatchObject({
			rotation: 12,
			visualEffect: "sepia",
		});
		const copiedResponse = await call("copy-clip-settings", {
			revision: patched.revision,
			sourceClipId: firstClip.id,
			targetClipIds: [secondClip.id],
		});
		expect(copiedResponse.status).toBe(200);
		const copied = projectSchema.parse(await copiedResponse.json());
		expect(copied.segments[1]).toMatchObject({
			rotation: 12,
			visualEffect: "sepia",
		});
		const swappedResponse = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/swap-clip-media`,
			{
				body: JSON.stringify({
					assetId: replacement.id,
					clipId: secondClip.id,
					revision: copied.revision,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(swappedResponse.status).toBe(200);
		const swapped = projectSchema.parse(await swappedResponse.json());
		expect(swapped.segments[1]).toMatchObject({
			assetId: replacement.id,
			start: 2,
			sourceIn: 0,
		});
	} finally {
		app.stop();
	}
});

test("capture-frame route creates an app-owned image from the saved composition", async () => {
	const store = await setup();
	const source = {
		...asset(),
		id: crypto.randomUUID(),
		duration: 1,
		width: 320,
		height: 180,
		hasAudio: false,
	};
	const fixture = join(store.directory, "capture-fixture.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=red:size=320x180:duration=1",
		fixture,
	]);
	await Bun.write(
		store.mediaPath(source.id),
		await Bun.file(fixture).arrayBuffer()
	);
	store.putAsset(source);
	const project = store.save({
		...store.create("Capture frame"),
		width: 320,
		height: 180,
		fps: 30,
		segments: [{ ...newSegment(source), sourceOut: 1 }],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/capture-frame`,
			{
				body: JSON.stringify({
					name: "Opening still",
					revision: project.revision,
					time: 0.5,
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		expect(response.status).toBe(200);
		const captured = assetSchema.parse(await response.json());
		expect(captured).toMatchObject({
			name: "Opening still",
			kind: "image",
			width: 320,
			height: 180,
			hasAudio: false,
		});
		expect(await Bun.file(store.mediaPath(captured.id)).exists()).toBe(true);
		expect(store.assets().some((asset) => asset.id === captured.id)).toBe(true);
		const inspectedResponse = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/inspect-frame?time=0.5`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(inspectedResponse.status).toBe(200);
		const inspected = (await inspectedResponse.json()) as {
			data: string;
			height: number;
			width: number;
		};
		expect(inspected).toMatchObject({ height: 180, width: 320 });
		expect(inspected.data.length).toBeGreaterThan(100);
	} finally {
		app.stop();
	}
});

test("organize route renames, folders, and deletes media with timeline cleanup", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const project = store.save({
		...store.create("Organize media"),
		captionTracks: [
			{
				captions: [
					{
						end: 2,
						id: crypto.randomUUID(),
						sourceAssetId: source.id,
						start: 0,
						text: "Sunset",
					},
				],
				id: crypto.randomUUID(),
				label: "Français",
				language: "fr",
			},
		],
		segments: [newSegment(source)],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = (body: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${source.id}/organize`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
	try {
		const renamed = await call({
			folder: "B-roll/Sunset",
			name: "Sunset take",
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({
			asset: { folder: "B-roll/Sunset", name: "Sunset take" },
			deleted: false,
		});
		const invalid = await call({ folder: "../outside" });
		expect(invalid.status).toBe(400);
		const deleted = await call({
			delete: true,
			projectRevisions: { [project.id]: project.revision },
		});
		expect(deleted.status).toBe(200);
		const result = (await deleted.json()) as {
			clipsRemoved: number;
			deleted: boolean;
			projects: Project[];
		};
		expect(result).toMatchObject({ clipsRemoved: 1, deleted: true });
		const cleaned = result.projects.find((item) => item.id === project.id);
		expect(cleaned?.segments).toEqual([]);
		expect(cleaned?.captionTracks[0]?.captions).toEqual([]);
		expect(store.assets().some((item) => item.id === source.id)).toBe(false);
	} finally {
		app.stop();
	}
});

test("deleting a multicam member dissolves its metadata without losing clips", async () => {
	const store = await setup();
	const wide = asset();
	const close = { ...asset(), id: crypto.randomUUID(), name: "Close" };
	const mic = {
		...asset(),
		duration: 6,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio" as const,
		name: "Recorder",
		width: 0,
	};
	store.putAsset(wide);
	store.putAsset(close);
	store.putAsset(mic);
	const created = createMulticamGroup(
		store.create("Delete multicam"),
		[wide, close, mic],
		{
			action: "create",
			members: [
				{ assetId: wide.id, kind: "angle" },
				{ assetId: close.id, kind: "angle" },
				{ assetId: mic.id, kind: "mic" },
			],
			revision: 0,
		}
	);
	const saved = store.save(created.project);
	const result = store.organizeAsset(wide.id, {
		delete: true,
		projectRevisions: { [saved.id]: saved.revision },
	});
	const updated = result.projects.find((project) => project.id === saved.id);
	expect(updated?.multicamGroups).toEqual([]);
	expect(updated?.segments.every((segment) => !segment.multicamGroupId)).toBe(
		true
	);
});

test("beats route exposes estimated onsets from completed source analysis", async () => {
	const store = await setup();
	const source = { ...asset(), id: crypto.randomUUID(), duration: 10 };
	store.putAsset(source);
	store.putAnalysis({
		assetId: source.id,
		createdAt: new Date().toISOString(),
		duration: 10,
		sceneCuts: [],
		status: "completed",
		waveform: Array.from({ length: 20 }, (_, index) =>
			[1, 5, 9, 13, 17].includes(index) ? 0.9 : 0.08
		),
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${source.id}/beats`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			assetId: source.id,
			times: [0.75, 2.75, 4.75, 6.75, 8.75],
		});
	} finally {
		app.stop();
	}
});

test("silence route exposes source ranges for a reviewed ripple edit", async () => {
	const store = await setup();
	const source = { ...asset(), id: crypto.randomUUID(), duration: 11 };
	store.putAsset(source);
	store.putAnalysis({
		assetId: source.id,
		createdAt: new Date().toISOString(),
		duration: 11,
		sceneCuts: [],
		status: "completed",
		waveform: [0, 0, 0.2, 0.5, 0.1, 0, 0, 0.3, 0, 0, 0],
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${source.id}/silence`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			assetId: source.id,
			ranges: [
				[0, 2],
				[5, 7],
				[8, 11],
			],
		});
	} finally {
		app.stop();
	}
});

test("agent chunk and subtitle operations expose their query controls", () => {
	const document = openapi();
	expect(
		document.paths["/api/video-studio/assets/{id}/data"].get.parameters?.some(
			(parameter) => parameter.name === "offset"
		)
	).toBe(true);
	expect(
		document.paths[
			"/api/video-studio/projects/{id}/subtitles"
		].get.parameters?.some((parameter) => parameter.name === "format")
	).toBe(true);
});

test("stock operations advertise the configured Pexels provider", () => {
	const document = openapi();
	const search = document.paths["/api/video-studio/stock/search"].get;
	const searchProvider = search.parameters?.find(
		(parameter) => parameter.name === "provider"
	);
	const importProvider =
		document.paths["/api/video-studio/stock"].post.requestBody?.content?.[
			"application/json"
		].schema;
	const searchEnum = (searchProvider?.schema as { enum?: string[] } | undefined)
		?.enum;
	const importEnum = (
		importProvider as {
			properties?: { provider?: { enum?: string[] } };
		}
	).properties?.provider?.enum;
	expect(searchEnum).toContain("pexels");
	expect(searchEnum).toContain("pixabay");
	expect(searchEnum).toContain("openverse.image");
	expect(searchEnum).toContain("unsplash.image");
	expect(importEnum).toContain("pexels");
	expect(importEnum).toContain("pixabay");
	expect(importEnum).toContain("openverse.image");
	expect(importEnum).toContain("unsplash.image");
});

test("transcription windows checkpoint and resume without accepting stale results", async () => {
	const store = await setup();
	const source = { ...asset(), duration: 45 };
	store.putAsset(source);
	const first = store.beginTranscript(source);
	const saved = store.appendTranscript(
		source.id,
		first.revision,
		0,
		[{ id: crypto.randomUUID(), start: 0, end: 2, text: "Opening" }],
		"segments"
	);
	expect(saved.nextOffset).toBe(20);
	expect(saved.timing).toBe("segments");
	const stopped = store.stopTranscript(source.id, saved.revision, "canceled");
	expect(stopped.cues).toHaveLength(1);
	const resumed = store.beginTranscript(source);
	expect(resumed.nextOffset).toBe(20);
	expect(() =>
		store.appendTranscript(source.id, saved.revision, 20, [])
	).toThrow(ConflictError);
	const imported = store.importTranscript(source, resumed.revision, [
		{ id: crypto.randomUUID(), start: 1, end: 3, text: "Imported" },
	]);
	expect(imported.origin).toBe("imported");
	expect(imported.status).toBe("completed");
});
test("source transcript mapping follows trims and speed", async () => {
	const store = await setup();
	const source = asset();
	const project = store.create("Mapped captions");
	project.segments = [
		{ ...newSegment(source), start: 10, sourceIn: 2, sourceOut: 8, speed: 2 },
	];
	const transcript = transcriptSchema.parse({
		assetId: source.id,
		revision: 0,
		status: "completed",
		nextOffset: 10,
		duration: 10,
		updatedAt: new Date().toISOString(),
		cues: [
			{ id: crypto.randomUUID(), start: 1, end: 3, text: "First" },
			{ id: crypto.randomUUID(), start: 5, end: 7, text: "Second" },
		],
	});
	expect(
		captionsForSource(project, transcript).map((cue) => [cue.start, cue.end])
	).toEqual([
		[10, 10.5],
		[11.5, 12.5],
	]);
});
test("engine segments retain real timestamps and text-only engines retain window timing", () => {
	expect(
		transcriptWindowCues(
			{
				text: "Words",
				segments: [{ startMs: 250, endMs: 1250, text: "Words" }],
			},
			20,
			2
		).map((cue) => [cue.start, cue.end])
	).toEqual([[20.25, 21.25]]);
	expect(
		transcriptWindowCues("Words", 20, 2).map((cue) => [cue.start, cue.end])
	).toEqual([[20, 22]]);
});
test("caption translation preserves timing and rejects missing or duplicate IDs", () => {
	const original = [
		{ id: crypto.randomUUID(), start: 1, end: 3, text: "Hello" },
	];
	expect(
		applyTranslations(original, {
			translations: [{ id: original[0]!.id, text: "Bonjour" }],
		})
	).toEqual([{ ...original[0], text: "Bonjour" }]);
	expect(() => applyTranslations(original, { translations: [] })).toThrow();
	expect(() =>
		applyTranslations(original, {
			translations: [{ id: crypto.randomUUID(), text: "Wrong ID" }],
		})
	).toThrow();
});

test("waveform samples source PCM and mixes channels without decorative fallback", () => {
	const left = new Float32Array([0, 1, 0, -1, 0]);
	const right = new Float32Array([0, 0, 0, 0, 0]);
	expect(waveformPoints([left, right], 4, 0, 1, 5)).toEqual([
		0, 0.5, 0, -0.5, 0,
	]);
	expect(waveformPoints([left], 4, 1, 1, 5)).toEqual([0, 0, 0, 0, 0]);
	expect(waveformPoints([], 4, 0, 1)).toEqual([]);
});

test("transcript index checkpoints reject stale revisions and retain old document references", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const transcript = store.importTranscript(source, null, [
		{ id: crypto.randomUUID(), start: 1, end: 3, text: "Film editing" },
	]);
	const index = store.beginSearchIndex(source, "space", "Video sources");
	const saved = store.updateSearchEntry(
		source.id,
		index.revision,
		index.entries[0]!.key,
		"doc",
		false
	);
	expect(() =>
		store.updateSearchEntry(
			source.id,
			index.revision,
			index.entries[0]!.key,
			"doc",
			true
		)
	).toThrow(ConflictError);
	const ready = store.updateSearchEntry(
		source.id,
		saved.revision,
		index.entries[0]!.key,
		"doc",
		true
	);
	expect(store.searchIndexes()[0]?.current).toBe(true);
	store.importTranscript(source, transcript.revision, [
		{ id: crypto.randomUUID(), start: 2, end: 4, text: "A revised edit" },
	]);
	expect(store.searchIndexes()[0]?.current).toBe(false);
	const rebuilt = store.beginSearchIndex(source, "space", "Video sources");
	expect(rebuilt.obsolete[0]?.docId).toBe("doc");
	expect(rebuilt.entries[0]?.docId).toBeNull();
	expect(rebuilt.revision).toBeGreaterThan(ready.revision);
});

test("word timestamps persist in source windows and map through trims and speed", async () => {
	const store = await setup();
	const media = { ...asset(), duration: 2 };
	store.putAsset(media);
	const initial = store.beginTranscript(media);
	const words = transcriptWindowWords(
		{
			words: [
				{ startMs: 100, endMs: 500, text: "Hello" },
				{ startMs: 700, endMs: 1200, text: "world" },
			],
		},
		0,
		2
	);
	const result = store.appendTranscript(
		media.id,
		initial.revision,
		0,
		[{ id: crypto.randomUUID(), start: 0, end: 2, text: "Hello world" }],
		"segments",
		words
	);
	expect(store.transcript(media.id)?.words).toEqual(words);
	const project = store.create("Word captions");
	project.segments = [
		{ ...newSegment(media, 3), sourceIn: 0.3, sourceOut: 1, speed: 2 },
	];
	const captions = captionsForSource(project, {
		...result,
		cues: result.words,
	});
	expect(captions.map((cue) => [cue.text, cue.start, cue.end])).toEqual([
		["Hello", 3, 3.1],
		["world", 3.2, 3.35],
	]);
	expect(
		transcriptWindowWords({ text: "No alignment", segments: [] }, 0, 2)
	).toEqual([]);
	const imported = store.importTranscript(media, result.revision, [
		{ id: crypto.randomUUID(), start: 0, end: 2, text: "Replacement" },
	]);
	expect(imported.words).toEqual([]);
});

test("word captions attach punctuation using measured boundaries", () => {
	const words = transcriptWindowWords(
		{
			words: [
				{ text: "Hello", startMs: 100, endMs: 400 },
				{ text: ".", startMs: 400, endMs: 450 },
			],
		},
		20,
		2
	);
	expect(
		words.map((word) => ({ text: word.text, start: word.start, end: word.end }))
	).toEqual([{ text: "Hello.", start: 20.1, end: 20.45 }]);
});

test("retranscription requires a current stopped revision and clears old alignment", async () => {
	const store = await setup();
	const media = asset();
	store.putAsset(media);
	const imported = store.importTranscript(media, null, [
		{ id: crypto.randomUUID(), text: "Old", start: 0, end: 1 },
	]);
	expect(() => store.restartTranscript(media, imported.revision + 1)).toThrow(
		ConflictError
	);
	const restarted = store.restartTranscript(media, imported.revision);
	expect(restarted.nextOffset).toBe(0);
	expect(restarted.cues).toEqual([]);
	expect(restarted.words).toEqual([]);
	expect(() => store.restartTranscript(media, restarted.revision)).toThrow(
		ConflictError
	);
});

test("storyboard audio retains independent trims and can mute the visual sound", async () => {
	const store = await setup();
	const video = asset();
	const voice = {
		...asset(),
		kind: "audio" as const,
		duration: 4.5,
		width: 0,
		height: 0,
	};
	store.putAsset(video);
	store.putAsset(voice);
	const project = store.create("Narrated scene");
	const scene = {
		id: crypto.randomUUID(),
		title: "Opening",
		script: "",
		prompt: "",
		assetIds: [video.id, voice.id],
		sourceIn: 3,
		duration: 4,
		audioOffsets: { [voice.id]: 0.25 },
		muteVisualAudio: true,
		approved: false,
	};
	project.scenes = [scene];
	const assembled = assembleStoryboard(project, [video, voice], false);
	expect(
		assembled.segments.map((segment) => [
			segment.sourceIn,
			segment.sourceOut,
			segment.volume,
		])
	).toEqual([
		[3, 7, 0],
		[0.25, 4.25, 1],
	]);
	const saved = store.save(project);
	const approved = store.approveScene(saved.id, saved.revision, scene.id, true);
	const changed = store.save({
		...approved,
		scenes: [{ ...approved.scenes[0]!, audioOffsets: { [voice.id]: 0.5 } }],
	});
	expect(changed.scenes[0]?.approved).toBe(false);
});
test("fitting narration uses its remaining duration and rejects short visual takes", async () => {
	const store = await setup();
	const image = { ...asset(), kind: "image" as const, hasAudio: false };
	const voice = { ...asset(), kind: "audio" as const, duration: 4.5 };
	const short = { ...asset(), duration: 2 };
	const scene = {
		id: crypto.randomUUID(),
		title: "Narration",
		script: "",
		prompt: "",
		assetIds: [image.id, voice.id],
		sourceIn: 0,
		duration: 5,
		audioOffsets: { [voice.id]: 0.5 },
		approved: false,
	};
	expect(fitSceneToAudio(scene, voice, [image, voice]).duration).toBe(4);
	expect(() =>
		fitSceneToAudio({ ...scene, assetIds: [short.id, voice.id] }, voice, [
			short,
			voice,
		])
	).toThrow("longer visual");
	const project = store.create("Short visual");
	project.scenes = [{ ...scene, assetIds: [short.id, voice.id] }];
	expect(() => assembleStoryboard(project, [short, voice], false)).toThrow(
		"shorter"
	);
	project.scenes = [
		{
			...scene,
			assetIds: [voice.id],
			audioOffsets: undefined,
			sourceIn: 1,
			duration: 2,
		},
	];
	expect(
		assembleStoryboard(project, [voice], false).segments[0]?.sourceIn
	).toBe(1);
});
