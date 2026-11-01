import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSegment } from "../../shared/project.ts";
import { sfxParameters } from "../../shared/sfx.ts";
import * as media from "./media.ts";
import { createStudioServer } from "./server.ts";
import { sfxExpression, sfxMediaArgs } from "./sfx.ts";
import { StudioStore } from "./store.ts";

describe("sfx synthesis arguments", () => {
	test("noise kinds seed the generator and sweep a band-pass between their centres", () => {
		const parameters = sfxParameters({ kind: "whoosh", seed: 7 });
		const expression = sfxExpression(parameters);
		const statements = expression.split(";");
		expect(statements[0]).toBe("if(eq(n,0),st(0,7),0)");
		expect(statements[1]).toBe("st(5,2*random(0)-1)");
		expect(expression).toContain("347.2*pow(1.625,t/0.8)");
		// Unit-gain band-pass: (1 - r^2)/2 input scale and 2r, r^2 feedback.
		expect(expression).toContain("st(6,0.014887*(ld(5)-ld(4))+1.97*cos(");
		expect(expression).toContain("-0.970225*ld(2))");
		// Swell envelope peaking 52.2% into the effect; no tonal part.
		expect(statements.at(-1)).toBe(
			"3.2*if(lt(t/0.8,0.522),pow(t/0.8/0.522,2),pow((1-t/0.8)/0.478,2))*(1*ld(6))"
		);
		expect(expression.includes("'")).toBe(false);
		expect(expression.includes("|")).toBe(false);
	});

	test("tonal kinds decay, glide, or ring as a bell", () => {
		const impact = sfxExpression(
			sfxParameters({ duration: 2, kind: "impact", seed: 42 })
		);
		expect(impact).toContain("min(1,t/0.002)*exp(-3.846*t)");
		expect(impact).toContain("sin(2*PI*(44.7*t+8.74935*(1-exp(-7.692*t))))");
		const ding = sfxExpression(sfxParameters({ kind: "ding" }));
		expect(ding).toContain("sin(2*PI*1253.2*t)+0.45*sin(2*PI*3453.8192*t)");
		const riser = sfxExpression(sfxParameters({ kind: "riser" }));
		expect(riser).toMatch(/sin\(2\*PI\*[\d.]+\*\(pow\([\d.]+,t\/3\)-1\)\)/u);
		const click = sfxExpression(sfxParameters({ kind: "click" }));
		expect(click).toMatch(/sin\(2\*PI\*[\d.]+\*t\)/u);
	});

	test("arguments limit peaks, fade the tail and write 48 kHz stereo", () => {
		const parameters = sfxParameters({ kind: "pop" });
		const args = sfxMediaArgs(parameters, "/tmp/pop.wav");
		expect(args.at(-1)).toBe("/tmp/pop.wav");
		expect(args[args.indexOf("-i") + 1]).toEndWith("':s=48000:d=0.15");
		expect(args[args.indexOf("-filter_complex") + 1]).toBe(
			"[0:a]alimiter=limit=0.89:attack=1:release=20:level=false:latency=true,afade=t=out:st=0.13:d=0.02"
		);
		expect(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2)).toEqual([
			"-ac",
			"2",
		]);
	});
});

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];

async function fixture() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-sfx-routes-"))
	);
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	servers.push(app);
	const call = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { call, store };
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	mock.restore();
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

describe("sfx and soundtrack plan routes", () => {
	test("POST /sfx synthesizes the requested effect and imports an audio asset", async () => {
		const launches: string[][] = [];
		spyOn(media, "runMedia").mockImplementation(async (args) => {
			launches.push(args);
			await Bun.write(args.at(-1)!, "fixture WAV source");
			return "";
		});
		spyOn(media, "probe").mockResolvedValue({
			kind: "audio",
			duration: 0.4,
			width: 0,
			height: 0,
			hasAudio: true,
		});
		const { call, store } = await fixture();
		const response = await call("/sfx", "POST", { kind: "swoosh", seed: 9 });
		expect(response.status).toBe(201);
		const asset = await response.json();
		expect(asset).toMatchObject({
			kind: "audio",
			name: "Swoosh SFX seed 9.wav",
		});
		expect(launches).toHaveLength(1);
		expect(launches[0]?.join(" ")).toContain("st(0,9)");
		expect(store.assets().map((item) => item.id)).toEqual([asset.id]);
		expect(await readdir(join(store.directory, "imports", "sfx"))).toEqual([]);
	});

	test("POST /sfx rejects an invalid body without launching ffmpeg", async () => {
		const launch = spyOn(media, "runMedia");
		const { call } = await fixture();
		const response = await call("/sfx", "POST", { kind: "boing" });
		expect(response.status).toBe(400);
		expect(launch).not.toHaveBeenCalled();
	});

	test("soundtrack-plan returns planning context and aligns a plan to cuts", async () => {
		const { call, store } = await fixture();
		const video = {
			id: crypto.randomUUID(),
			name: "shot.mp4",
			kind: "video" as const,
			duration: 10,
			width: 640,
			height: 360,
			hasAudio: false,
			createdAt: new Date().toISOString(),
		};
		store.putAsset(video);
		const created = store.create("Trailer");
		const project = store.save({
			...created,
			segments: [newSegment(video, 0, 0), newSegment(video, 10, 0)],
		});
		const context = await call(`/projects/${project.id}/soundtrack-plan`);
		expect(context.status).toBe(200);
		const body = await context.json();
		expect(body.sceneCuts).toEqual([10]);
		expect(body.beats).toEqual([]);
		expect(body.summary.duration).toBe(20);
		expect(body.prompt.system).toContain("cinematic");

		const aligned = await call(
			`/projects/${project.id}/soundtrack-plan`,
			"POST",
			{
				plan: {
					bpm: 96,
					sections: [
						{ start: 0, end: 9, intensity: 0.2 },
						{ start: 9, end: 20, intensity: 0.9 },
					],
					style: "cinematic",
				},
			}
		);
		expect(aligned.status).toBe(200);
		expect(await aligned.json()).toEqual({
			plan: {
				bpm: 96,
				sections: [
					{ start: 0, end: 10, intensity: 0.2 },
					{ start: 10, end: 20, intensity: 0.9 },
				],
				style: "cinematic",
			},
			request: {
				bpm: 96,
				duration: 20,
				mood: "cinematic",
				sections: [
					{ start: 0, end: 10, intensity: 0.2 },
					{ start: 10, end: 20, intensity: 0.9 },
				],
			},
		});
	});

	test("soundtrack-plan takes a music description and a timeline range", async () => {
		const { call, store } = await fixture();
		const video = {
			id: crypto.randomUUID(),
			name: "shot.mp4",
			kind: "video" as const,
			duration: 10,
			width: 640,
			height: 360,
			hasAudio: false,
			createdAt: new Date().toISOString(),
		};
		store.putAsset(video);
		const created = store.create("Range");
		const project = store.save({
			...created,
			segments: [
				newSegment(video, 0, 0),
				newSegment(video, 10, 0),
				newSegment(video, 20, 0),
			],
		});
		const context = await call(
			`/projects/${project.id}/soundtrack-plan?description=${encodeURIComponent("Slow lo-fi piano, no drums")}&start=5&end=25`
		);
		expect(context.status).toBe(200);
		const body = await context.json();
		expect(body.range).toEqual({ end: 25, start: 5 });
		expect(body.summary.duration).toBe(20);
		expect(body.sceneCuts).toEqual([5, 15]);
		expect(body.prompt.prompt).toContain("Slow lo-fi piano, no drums");
		expect(body.prompt.system).toContain("musicDescription");
		expect(body.prompt.system).toContain("layers");
		const half = await call(`/projects/${project.id}/soundtrack-plan?start=5`);
		expect(half.status).toBe(400);

		const aligned = await call(
			`/projects/${project.id}/soundtrack-plan`,
			"POST",
			{
				end: 25,
				plan: {
					bpm: 80,
					layers: ["pad", "pluck"],
					sections: [
						{ start: 0, end: 6, intensity: 0.3 },
						{ start: 6, end: 20, intensity: 0.6 },
					],
					style: "lo-fi",
				},
				start: 5,
			}
		);
		expect(aligned.status).toBe(200);
		const result = await aligned.json();
		expect(result.request.duration).toBe(20);
		expect(result.request.layers).toEqual(["pad", "pluck"]);
		expect(
			result.plan.sections.map((section: { start: number }) => section.start)
		).toEqual([0, 5]);
	});
});
