import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePluginKeys, type PluginKeys } from "@ryu/sidecar-runtime/seal";
import type { Asset } from "../../shared/project.ts";
import { StudioStore } from "./store.ts";

const PROMPT = "prompt-secret-harbor-at-dawn";
const SPOKEN = "spoken-secret-words";
const TITLE = "project-secret-title";

function keys(fill = 8): PluginKeys {
	return capturePluginKeys("@ryu/video-studio", {
		RYU_SEAL_KEY: Buffer.from(new Uint8Array(32).fill(fill)).toString("base64"),
		RYU_SEAL_SCOPE: "plugin:@ryu/video-studio",
	});
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ryu-video-studio-seal-"));
	roots.push(dir);
	return dir;
}

function disk(dir: string): string {
	const path = join(dir, "studio.sqlite");
	let text = readFileSync(path).toString("latin1");
	try {
		text += readFileSync(`${path}-wal`).toString("latin1");
	} catch {
		// No WAL.
	}
	return text;
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

function fill(store: StudioStore) {
	const project = store.create(TITLE);
	const renamed = store.save({ ...project, title: `${TITLE} v2` });
	const source = asset();
	store.putAsset(source);
	store.importTranscript(source, null, [
		{ end: 0.8, id: crypto.randomUUID(), start: 0.2, text: SPOKEN },
	]);
	store.beginSearchIndex(source, "space-1", "Space");
	const job = store.beginGeneration({
		id: crypto.randomUUID(),
		projectId: project.id,
		kind: "video",
		prompt: PROMPT,
	}).job;
	return { project: renamed, source, job };
}

test("seals projects, history, transcripts, search indexes and generation prompts", () => {
	const dir = tempDir();
	const store = new StudioStore(dir, { keys: keys() });
	const { project, source, job } = fill(store);
	expect(store.project(project.id).title).toBe(`${TITLE} v2`);
	expect(store.history(project.id)[0]?.title).toBe(TITLE);
	expect(store.transcript(source.id)?.cues[0]?.text).toBe(SPOKEN);
	expect(JSON.stringify(store.searchIndexes())).toContain(SPOKEN);
	expect(store.generationJobs(project.id)[0]?.request.prompt).toBe(PROMPT);
	expect([...store.generationBudgetJobs(project.id)]).toHaveLength(1);
	const row = store.db
		.query("SELECT data, status, project_id FROM generation_jobs WHERE id=?")
		.get(job.id) as { data: string; project_id: string; status: string };
	expect(row.data.startsWith("encb:v1:")).toBe(true);
	expect(row).toMatchObject({ status: "requested", project_id: project.id });
	store.close();
	const text = disk(dir);
	for (const secret of [PROMPT, SPOKEN, TITLE]) {
		expect(text).not.toContain(secret);
	}
	// Restart recovery finds requested jobs through the plaintext status.
	const reopened = new StudioStore(dir, { keys: keys() });
	expect(reopened.generationJob(job.id)?.status).toBe("interrupted");
	reopened.close();
});

test("migrates a version 5 plaintext store, lifting status and project ids", () => {
	const dir = tempDir();
	const legacy = new StudioStore(dir);
	const { project, source, job } = fill(legacy);
	legacy.close();
	const raw = new Database(join(dir, "studio.sqlite"));
	raw.exec(
		"DROP INDEX generation_jobs_project; ALTER TABLE generation_jobs DROP COLUMN status; ALTER TABLE generation_jobs DROP COLUMN project_id; PRAGMA user_version=5;"
	);
	raw.close();
	expect(disk(dir)).toContain(PROMPT);

	const sealed = new StudioStore(dir, { keys: keys() });
	expect(sealed.generationJobs(project.id).map((item) => item.id)).toEqual([
		job.id,
	]);
	expect(sealed.generationJob(job.id)?.status).toBe("interrupted");
	expect(sealed.transcript(source.id)?.cues[0]?.text).toBe(SPOKEN);
	expect(sealed.history(project.id)[0]?.title).toBe(TITLE);
	expect(sealed.seal.health()).toMatchObject({
		sealing: "ok",
		unreadableRows: 0,
	});
	expect(
		(sealed.db.query("PRAGMA user_version").get() as { user_version: number })
			.user_version
	).toBe(6);
	sealed.close();
	const text = disk(dir);
	for (const secret of [PROMPT, SPOKEN, TITLE]) {
		expect(text).not.toContain(secret);
	}
});

test("seals a project written in plaintext after the store was sealed", () => {
	const dir = tempDir();
	const store = new StudioStore(dir, { keys: keys() });
	const project = store.create("sealed title");
	store.close();
	// A plaintext write that bypassed the seal (an older build or a tool).
	const raw = new Database(join(dir, "studio.sqlite"));
	raw
		.query("UPDATE projects SET data = ? WHERE id = ?")
		.run(JSON.stringify({ ...project, title: TITLE }), project.id);
	raw.close();
	expect(disk(dir)).toContain(TITLE);

	const reopened = new StudioStore(dir, { keys: keys() });
	const stored = reopened.db
		.query("SELECT data FROM projects WHERE id = ?")
		.get(project.id) as { data: string };
	expect(stored.data.startsWith("encb:v1:")).toBe(true);
	reopened.close();
	expect(disk(dir)).not.toContain(TITLE);
});

test("skips a project that does not open and fails a direct read of it", () => {
	const dir = tempDir();
	const store = new StudioStore(dir, { keys: keys() });
	const first = store.create("One");
	const second = store.create("Two");
	const stored = store.db
		.query("SELECT data FROM projects WHERE id=?")
		.get(first.id) as { data: string };
	store.db
		.query("UPDATE projects SET data=? WHERE id=?")
		.run(stored.data, second.id);
	expect(store.projects().map((item) => item.id)).toEqual([first.id]);
	expect(store.seal.unreadableRows).toBe(1);
	expect(() => store.project(second.id)).toThrow();
	store.close();
});

test.skipIf(process.platform === "win32")(
	"plaintext media folders are narrowed to the owner on open",
	() => {
		const dir = tempDir();
		new StudioStore(dir, { keys: keys() }).close();
		const nested = join(dir, "media", "clips");
		mkdirSync(nested, { mode: 0o755 });
		chmodSync(nested, 0o755);
		chmodSync(join(dir, "renders"), 0o755);
		const clip = join(nested, "clip.mp4");
		writeFileSync(clip, "frames");
		chmodSync(clip, 0o644);
		const outside = join(tempDir(), "outside.txt");
		writeFileSync(outside, "keep");
		chmodSync(outside, 0o644);
		symlinkSync(outside, join(dir, "imports", "link.txt"));

		new StudioStore(dir, { keys: keys() }).close();

		const mode = (path: string) => statSync(path).mode & 0o777;
		expect(mode(dir)).toBe(0o700);
		expect(mode(join(dir, "renders"))).toBe(0o700);
		expect(mode(nested)).toBe(0o700);
		expect(mode(clip)).toBe(0o600);
		// A symlink is never followed.
		expect(mode(outside)).toBe(0o644);
	}
);

test("work files left by a crashed job are removed on open; exports stay", () => {
	const dir = tempDir();
	new StudioStore(dir, { keys: keys() }).close();
	const renders = join(dir, "renders");
	const jobFolder = join(renders, "job-1");
	mkdirSync(jobFolder);
	writeFileSync(join(jobFolder, "captions.ass"), SPOKEN);
	writeFileSync(join(jobFolder, "mesh-0.png"), "frame");
	mkdirSync(join(renders, "capture-1"));
	writeFileSync(join(renders, "capture-1", "frame.png"), "frame");
	mkdirSync(join(renders, ".sequence-1"));
	const audioWindow = join(dir, "audio-window-abc");
	mkdirSync(audioWindow);
	writeFileSync(join(audioWindow, "window.wav"), "audio");
	mkdirSync(join(dir, "tmp"), { recursive: true });
	const probe = join(dir, "tmp", "probe-1.json");
	writeFileSync(probe, "{}");
	const exported = join(renders, "job-0.mp4");
	writeFileSync(exported, "video");
	const thumb = join(renders, "job-0.jpg");
	writeFileSync(thumb, "thumb");
	// A symlinked folder is removed as a link; its target is never touched.
	const outside = tempDir();
	writeFileSync(join(outside, "keep.txt"), "keep");
	symlinkSync(outside, join(renders, "linked"));

	new StudioStore(dir, { keys: keys() }).close();

	const exists = (path: string) => {
		try {
			statSync(path);
			return true;
		} catch {
			return false;
		}
	};
	for (const gone of [
		jobFolder,
		join(renders, "capture-1"),
		join(renders, ".sequence-1"),
		audioWindow,
		probe,
		join(renders, "linked"),
	]) {
		expect(exists(gone)).toBe(false);
	}
	expect(exists(exported)).toBe(true);
	expect(exists(thumb)).toBe(true);
	expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
});

test("creation times fall back to the oldest sealed history revision", () => {
	const dir = tempDir();
	const store = new StudioStore(dir, { keys: keys() });
	const project = store.create(TITLE);
	store.save({ ...project, title: `${TITLE} v2` });
	// A project saved before the library kept creation times.
	store.db.query("DELETE FROM project_meta WHERE id=?").run(project.id);
	expect(store.projectCreatedTimes().get(project.id)).toBe(project.updatedAt);
	store.db.close();
	expect(disk(dir)).not.toContain(TITLE);
});
