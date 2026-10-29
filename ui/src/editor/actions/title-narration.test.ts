import { describe, expect, test } from "bun:test";
import type { GenerationRequestInput } from "../../../../shared/generation.ts";
import {
	type Asset,
	newProject,
	type Project,
	type Title,
} from "../../../../shared/project.ts";
import type { GenerationServices } from "../../ai/media-bridge.ts";
import { createTestRuntime, lastStatus } from "../test-runtime.ts";
import { narrateTitle, titleNarrationRequest } from "./title-narration.ts";

const title: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 6,
	fadeIn: 0.2,
	fadeOut: 0.2,
	fontSize: 0.08,
	id: "33333333-3333-4333-8333-333333333333",
	start: 3,
	text: "Grace Hopper · Admiral",
	x: 0.5,
	y: 0.8,
};

const narration: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 2,
	hasAudio: true,
	height: 0,
	id: "44444444-4444-4444-8444-444444444444",
	kind: "audio",
	name: "Narration.wav",
	width: 0,
};

function setup(patch: Partial<Project> = {}) {
	const project: Project = {
		...newProject("Titles"),
		titles: [title],
		...patch,
	};
	const runtime = createTestRuntime(project, []);
	const routed: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		routed.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	const requests: GenerationRequestInput[] = [];
	const run = (
		_services: GenerationServices,
		input: GenerationRequestInput
	) => {
		requests.push(input);
		return Promise.resolve({ asset: narration });
	};
	return { requests, routed, run, runtime };
}

const services = {} as GenerationServices;

describe("title text to speech", () => {
	test("speaks the title text with the chosen voice and places it at the title start", async () => {
		const { requests, routed, run, runtime } = setup();
		const placed = await narrateTitle(
			runtime,
			title.id,
			{ engine: "kokoro", language: "en-us", speed: 1.1, voice: "af_heart" },
			{ run, services }
		);
		expect(placed).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			engine: "kokoro",
			kind: "audio",
			language: "en-us",
			prompt: "Grace Hopper, Admiral.",
			speed: 1.1,
			voice: "af_heart",
		});
		expect(routed).toEqual([
			["title-narration", { assetId: narration.id, titleId: title.id }],
		]);
		expect(runtime.calls).toContainEqual(["setTime", 3]);
	});

	test("an engine default request names no engine", () => {
		const request = titleNarrationRequest("p", "Hello.", {
			engine: "kokoro",
			language: "",
			speed: 1,
			voice: "",
		});
		expect(request.engine).toBeUndefined();
		expect(request.voice).toBe("");
	});

	test("an empty title is not sent to the speech engine", async () => {
		const { requests, run, runtime } = setup({
			titles: [{ ...title, text: " " }],
		});
		expect(
			await narrateTitle(runtime, title.id, undefined, { run, services })
		).toBe(false);
		expect(requests).toHaveLength(0);
		expect(lastStatus(runtime)).toContain("Add text");
	});

	test("a failed placement keeps the saved narration and says so", async () => {
		const { run, runtime } = setup();
		runtime.routeEdit = () => Promise.resolve({ status: "conflict" });
		expect(
			await narrateTitle(runtime, title.id, undefined, { run, services })
		).toBe(false);
		expect(lastStatus(runtime)).toContain("saved to the library");
	});
});
