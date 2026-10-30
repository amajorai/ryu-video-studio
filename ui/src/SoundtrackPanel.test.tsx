import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
// React DOM detects input-event support when it loads, so it loads after the DOM.
const { createRoot } = await import("react-dom/client");
const { newProject, newSegment } = await import("../../shared/project.ts");
const { EditorProvider } = await import("./editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"./editor/test-runtime.ts"
);
const { z } = await import("zod");
const {
	createSoundtrack,
	errorMessage,
	SoundtrackPanel,
	soundtrackBody,
	toggleLayer,
} = await import("./SoundtrackPanel.tsx");

const previousRyu = window.ryu;

afterAll(() => {
	GlobalRegistrator.unregister();
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

afterEach(() => {
	window.ryu = previousRyu;
});

describe("soundtrack panel helpers", () => {
	test("the request body omits default layers and clips sections to the duration", () => {
		expect(
			soundtrackBody({
				bpm: 90,
				duration: 12,
				mood: "cinematic",
				sections: [
					{ start: 0, end: 10, intensity: 0.2 },
					{ start: 10, end: 20, intensity: 1 },
				],
			})
		).toEqual({
			bpm: 90,
			duration: 12,
			mood: "cinematic",
			sections: [
				{ start: 0, end: 10, intensity: 0.2 },
				{ start: 10, end: 12, intensity: 1 },
			],
		});
		expect(
			soundtrackBody({
				bpm: 96,
				duration: 4,
				layers: ["pad"],
				mood: "warm",
				sections: [],
			})
		).toEqual({ bpm: 96, duration: 4, layers: ["pad"], mood: "warm" });
	});

	test("layer toggles start from the style band and keep at least one layer", () => {
		expect(toggleLayer("lo-fi", undefined, "snare", false)).toEqual([
			"pad",
			"bass",
			"kick",
			"hat",
		]);
		expect(toggleLayer("warm", undefined, "kick", true)).toEqual([
			"pluck",
			"kick",
		]);
		expect(toggleLayer("warm", ["pad"], "pad", false)).toEqual(["pad"]);
	});
});

function control<T extends Element>(
	host: HTMLElement,
	selector: string,
	type: new () => T
): T {
	const element = host.querySelector(selector);
	if (!(element instanceof type)) {
		throw new Error(`missing ${selector}`);
	}
	return element;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
	const match = [...host.querySelectorAll("button")].find(
		(item) => item.textContent === text
	);
	if (!match) {
		throw new Error(`missing button ${text}`);
	}
	return match;
}

async function render(
	beats: number[] = [],
	range?: { end: number; start: number }
) {
	const video = testVideo();
	const project = {
		...newProject("Teaser"),
		markers: beats.map((time, index) => ({
			id: crypto.randomUUID(),
			label: `Beat ${index + 1}`,
			time,
		})),
		segments: [newSegment(video, 0, 0), newSegment(video, 10, 0)],
	};
	const runtime = createTestRuntime(project, [video]);
	if (range) {
		runtime.range = range;
		runtime.rangeMarked = true;
	}
	const assets: string[] = [];
	const statuses: string[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<SoundtrackPanel
					onAsset={(asset) => assets.push(asset.id)}
					onStatus={(status) => statuses.push(status)}
				/>
			</EditorProvider>
		);
	});
	return {
		assets,
		host,
		runtime,
		statuses,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const audioAsset = () => ({
	id: crypto.randomUUID(),
	name: "Generated.wav",
	kind: "audio",
	duration: 4,
	width: 0,
	height: 0,
	hasAudio: true,
	createdAt: new Date().toISOString(),
});

type AppReply = Awaited<
	ReturnType<
		NonNullable<NonNullable<NonNullable<typeof window.ryu>["app"]>["request"]>
	>
>;

describe("soundtrack requests", () => {
	test("schema errors become the fallback message, never raw issue JSON", () => {
		const zodError = z.object({ a: z.number() }).safeParse({}).error;
		expect(errorMessage(zodError, "Soundtrack planning failed.")).toBe(
			"Soundtrack planning failed."
		);
		expect(errorMessage(new Error("Readable"), "fallback")).toBe("Readable");
		expect(errorMessage("thrown string", "fallback")).toBe("fallback");
	});

	test("a 202 job is polled until it returns the saved asset", async () => {
		const asset = audioAsset();
		const jobId = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const paths: string[] = [];
		const replies: AppReply[] = [
			{ job: { id: jobId, status: "running", createdAt } },
			{ id: jobId, status: "running", createdAt },
			{ id: jobId, status: "done", createdAt, asset },
		];
		window.ryu = {
			app: {
				request: (input) => {
					paths.push(input.path);
					return Promise.resolve(replies.shift());
				},
			},
		};
		const waits: number[] = [];
		let background = 0;
		const result = await createSoundtrack(
			{ bpm: 120, duration: 600, mood: "upbeat" },
			{
				onBackground: () => {
					background++;
				},
				wait: (milliseconds) => {
					waits.push(milliseconds);
					return Promise.resolve();
				},
			}
		);
		expect(result.id).toBe(asset.id);
		expect(background).toBe(1);
		expect(waits).toEqual([2000, 2000]);
		expect(paths).toEqual([
			"/soundtrack",
			`/soundtrack-jobs?id=${jobId}`,
			`/soundtrack-jobs?id=${jobId}`,
		]);
	});

	test("a failed job surfaces its message", async () => {
		const jobId = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const replies: AppReply[] = [
			{ job: { id: jobId, status: "running", createdAt } },
			{
				id: jobId,
				status: "failed",
				createdAt,
				error: { code: "SOUNDTRACK_FAILED", message: "ffmpeg exited" },
			},
		];
		window.ryu = {
			app: { request: () => Promise.resolve(replies.shift()) },
		};
		await expect(
			createSoundtrack(
				{ bpm: 120, duration: 600, mood: "upbeat" },
				{ wait: () => Promise.resolve() }
			)
		).rejects.toThrow("ffmpeg exited");
	});
});

describe("SoundtrackPanel", () => {
	test("offers every style, plans from the timeline and posts the planned sections", async () => {
		const requests: { body?: unknown; path: string }[] = [];
		const prompts: string[] = [];
		const duration = 2 * testVideo().duration;
		window.ryu = {
			app: {
				request: (input) => {
					requests.push({ body: input.body, path: input.path });
					return Promise.resolve(audioAsset());
				},
			},
			model: {
				complete: (input) => {
					prompts.push(input.prompt);
					return Promise.resolve(
						JSON.stringify({
							bpm: 100,
							sections: [
								{ start: 0, end: 9.5, intensity: 0.2 },
								{ start: 9.5, end: duration, intensity: 0.9 },
							],
							style: "upbeat",
						})
					);
				},
			},
		};
		const view = await render();
		const style = control(
			view.host,
			'select[aria-label="Soundtrack style"]',
			HTMLSelectElement
		);
		expect([...style.options].map((option) => option.value)).toContain("lo-fi");
		expect(style.options).toHaveLength(9);
		await act(async () => {
			button(view.host, "Plan from timeline").click();
		});
		expect(prompts).toHaveLength(1);
		expect(JSON.parse(prompts[0] ?? "{}").sceneCuts).toEqual([10]);
		expect(style.value).toBe("upbeat");
		const sections = control(
			view.host,
			'ol[aria-label="Planned soundtrack sections"]',
			HTMLOListElement
		);
		expect(sections.children).toHaveLength(2);
		expect(sections.textContent).toContain("10.0 s");
		await act(async () => {
			button(view.host, "Create soundtrack").click();
		});
		expect(requests).toEqual([
			{
				body: {
					bpm: 100,
					duration,
					mood: "upbeat",
					sections: [
						{ start: 0, end: 10, intensity: 0.2 },
						{ start: 10, end: duration, intensity: 0.9 },
					],
				},
				path: "/soundtrack",
			},
		]);
		expect(view.assets).toHaveLength(1);
		await view.unmount();
	});

	test("a music description reaches the planner and a marked range is scored in place", async () => {
		const requests: { body?: unknown; path: string }[] = [];
		const prompts: { prompt: string; system?: string }[] = [];
		const scored = { ...audioAsset(), duration: 10 };
		window.ryu = {
			app: {
				request: (input) => {
					requests.push({ body: input.body, path: input.path });
					return Promise.resolve(scored);
				},
			},
			model: {
				complete: (input) => {
					prompts.push(input);
					return Promise.resolve(
						JSON.stringify({
							bpm: 80,
							layers: ["pad", "pluck"],
							sections: [{ start: 0, end: 10, intensity: 0.4 }],
							style: "lo-fi",
						})
					);
				},
			},
		};
		const view = await render([], { end: 15, start: 5 });
		const describe = control(
			view.host,
			'textarea[aria-label="Describe the music"]',
			HTMLTextAreaElement
		);
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			setter?.call(describe, "Slow lo-fi piano, no drums");
			describe.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
		const span = control(
			view.host,
			'select[aria-label="Soundtrack span"]',
			HTMLSelectElement
		);
		await act(async () => {
			span.value = "range";
			span.dispatchEvent(new window.Event("change", { bubbles: true }));
		});
		await act(async () => {
			button(view.host, "Plan for the range").click();
		});
		expect(prompts).toHaveLength(1);
		const sent = JSON.parse(prompts[0]?.prompt ?? "{}");
		expect(sent.musicDescription).toBe("Slow lo-fi piano, no drums");
		expect(sent.timeline.duration).toBe(10);
		expect(sent.sceneCuts).toEqual([5]);
		await act(async () => {
			button(view.host, "Create soundtrack").click();
		});
		expect(requests[0]?.body).toMatchObject({
			duration: 10,
			layers: ["pad", "pluck"],
			mood: "lo-fi",
		});
		const placed = view.runtime.project?.segments.find(
			(segment) => segment.assetId === scored.id
		);
		expect(placed?.start).toBe(5);
		expect(placed?.track).toBeGreaterThanOrEqual(1);
		await view.unmount();
	});

	test("a plan from beat markers keeps the measured tempo and bar phase", async () => {
		const requests: { body?: unknown; path: string }[] = [];
		const duration = 2 * testVideo().duration;
		const beatSeconds = 60 / 97.4;
		const beats = Array.from(
			{ length: 16 },
			(_, index) => Math.round((0.3 + index * beatSeconds) * 1000) / 1000
		);
		window.ryu = {
			app: {
				request: (input) => {
					requests.push({ body: input.body, path: input.path });
					return Promise.resolve(audioAsset());
				},
			},
			model: {
				complete: () =>
					Promise.resolve(
						`Plan: {"style":"Upbeat","bpm":100,"sections":[{"start":0,"end":${duration},"intensity":0.6}]}`
					),
			},
		};
		const view = await render(beats);
		await act(async () => {
			button(view.host, "Plan from timeline").click();
		});
		await act(async () => {
			button(view.host, "Create soundtrack").click();
		});
		expect(requests[0]?.body).toMatchObject({
			bpm: 97.4,
			downbeatOffset: 0.3,
			mood: "upbeat",
		});
		await view.unmount();
	});

	test("an unusable model plan shows a readable status line", async () => {
		window.ryu = {
			app: { request: () => Promise.resolve(audioAsset()) },
			model: {
				complete: () =>
					Promise.resolve('{"style":"polka","bpm":100,"sections":[]}'),
			},
		};
		const view = await render();
		await act(async () => {
			button(view.host, "Plan from timeline").click();
		});
		expect(view.statuses.at(-1)).toBe(
			"The model returned an unusable soundtrack plan. Try planning again."
		);
		await view.unmount();
	});

	test("creates a sound effect of the chosen kind with the default seed", async () => {
		const requests: { body?: unknown; path: string }[] = [];
		window.ryu = {
			app: {
				request: (input) => {
					requests.push({ body: input.body, path: input.path });
					return Promise.resolve(audioAsset());
				},
			},
		};
		const view = await render();
		expect(button(view.host, "Plan from timeline").disabled).toBe(true);
		const kind = control(
			view.host,
			'select[aria-label="Sound effect kind"]',
			HTMLSelectElement
		);
		await act(async () => {
			kind.value = "riser";
			kind.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			button(view.host, "Create sound effect").click();
		});
		expect(requests).toEqual([
			{ body: { kind: "riser", seed: 1 }, path: "/sfx" },
		]);
		expect(view.statuses.at(-1)).toBe(
			"Sound effect saved to the media library."
		);
		await view.unmount();
	});
});
