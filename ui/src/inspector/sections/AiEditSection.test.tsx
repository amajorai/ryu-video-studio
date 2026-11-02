import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime } = await import("../../editor/test-runtime.ts");
const { newProject, newSegment } = await import(
	"../../../../shared/project.ts"
);
const { AiEditSection } = await import("./AiEditSection.tsx");

type Asset = import("../../../../shared/project.ts").Asset;
type Segment = import("../../../../shared/project.ts").Segment;

afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
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
	Reflect.deleteProperty(window, "ryu");
	document.body.replaceChildren();
});

function media(kind: Asset["kind"], name: string): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 5,
		hasAudio: kind !== "image",
		height: 720,
		id: crypto.randomUUID(),
		kind,
		name,
		width: 1280,
	};
}

function installHost(jobs: unknown[], withImage = true) {
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			app: { request: async () => ({ jobs }) },
			media: withImage
				? {
						image: async () => ["data:image/png;base64,AAAA"],
						tts: async () => "data:audio/wav;base64,AAAA",
					}
				: {},
		},
		writable: true,
	});
}

async function render(assets: Asset[], segment: Segment) {
	const project = { ...newProject("AI edit"), segments: [segment] };
	const runtime = createTestRuntime(project, assets);
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<AiEditSection
					isAudio={assets[0]?.kind === "audio"}
					onChange={() => undefined}
					segment={segment}
					visualControls
				/>
			</EditorProvider>
		);
	});
	return { element, project };
}

function completedJob(assetId: string, kind: "image" | "video" | "audio") {
	const requestId = crypto.randomUUID();
	return {
		assetIds: [assetId],
		createdAt: "2026-01-01T00:00:00.000Z",
		id: requestId,
		message: "",
		projectRevision: 0,
		request: {
			id: requestId,
			kind,
			language: "",
			model: "",
			projectId: crypto.randomUUID(),
			prompt: "Waves",
			provider: "",
			rationale: "",
			route: "node-default",
			speed: 1,
			voice: "",
		},
		status: "completed",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function button(element: HTMLElement, label: string) {
	return [...element.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === label
	);
}

describe("AiEditSection", () => {
	test("offers Edit with AI for image clips and lists other stills as references", async () => {
		installHost([]);
		const still = media("image", "poster.png");
		const reference = media("image", "style.png");
		const { element } = await render(
			[still, reference, media("video", "clip.mp4")],
			newSegment(still, 0)
		);
		const edit = button(element, "Edit with AI");
		expect(edit).toBeDefined();
		expect(edit?.disabled).toBe(true);
		expect(button(element, "Edit frame as still")).toBeUndefined();
		const labels = [...element.querySelectorAll("label")].map(
			(label) => label.textContent
		);
		expect(labels).toEqual(["style.png"]);
	});

	test("offers Edit frame as still for video clips", async () => {
		installHost([]);
		const clip = media("video", "clip.mp4");
		const { element } = await render([clip], newSegment(clip, 0));
		expect(button(element, "Edit frame as still")).toBeDefined();
		expect(element.textContent).toContain("freeze at the playhead");
	});

	test("renders nothing for audio that was not generated", async () => {
		installHost([]);
		const voice = media("audio", "vo.wav");
		const { element } = await render([voice], newSegment(voice, 0));
		expect(element.textContent).toBe("");
	});

	test("offers Regenerate for media with a completed generation request", async () => {
		const voice = media("audio", "Generated audio — Hello.wav");
		const segment = newSegment(voice, 0);
		const projectId = crypto.randomUUID();
		const requestId = crypto.randomUUID();
		installHost([
			{
				assetIds: [voice.id],
				createdAt: "2026-01-01T00:00:00.000Z",
				id: requestId,
				message: "",
				projectRevision: 0,
				request: {
					id: requestId,
					kind: "audio",
					language: "",
					model: "",
					projectId,
					prompt: "Hello",
					provider: "",
					rationale: "",
					route: "node-default",
					speed: 1,
					voice: "",
				},
				status: "completed",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const { element } = await render([voice], segment);
		await act(async () => {
			await Promise.resolve();
		});
		const regenerate = button(element, "Regenerate");
		expect(regenerate).toBeDefined();
		expect(regenerate?.disabled).toBe(false);
	});

	test("explains when the host cannot edit images", async () => {
		installHost([], false);
		const still = media("image", "poster.png");
		const { element } = await render([still], newSegment(still, 0));
		expect(element.textContent).toContain("AI image editing is unavailable");
	});

	test("a newly inspected clip gets a fresh form and refetched history", async () => {
		const jobs: unknown[] = [];
		installHost(jobs);
		const stillA = media("image", "a.png");
		const stillB = media("image", "b.png");
		const generated = media("video", "Generated video — Waves.mp4");
		const assets = [stillA, stillB, generated];
		const clipA = newSegment(stillA, 0);
		const clipB = newSegment(stillB, 5);
		const clipGen = newSegment(generated, 10);
		const project = {
			...newProject("Switch"),
			segments: [clipA, clipB, clipGen],
		};
		const runtime = createTestRuntime(project, assets);
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const show = async (segment: Segment) => {
			await act(async () => {
				root.render(
					<EditorProvider value={runtime}>
						<AiEditSection
							isAudio={false}
							onChange={() => undefined}
							segment={segment}
							visualControls
						/>
					</EditorProvider>
				);
			});
			await act(async () => {
				await Promise.resolve();
			});
		};
		await show(clipA);
		const reference = () =>
			element.querySelector<HTMLElement>(
				'[role="checkbox"], input[type="checkbox"]'
			);
		const checked = () => {
			const box = reference();
			return box instanceof HTMLInputElement
				? box.checked
				: box?.getAttribute("aria-checked") === "true";
		};
		await act(async () => {
			reference()?.click();
		});
		expect(checked()).toBe(true);
		// Clip A's reference choice does not follow the user to clip B.
		await show(clipB);
		expect(checked()).toBe(false);
		// Media generated elsewhere since mount shows Regenerate once inspected.
		jobs.push(completedJob(generated.id, "video"));
		await show(clipGen);
		expect(button(element, "Regenerate")).toBeDefined();
		await act(async () => {
			root.unmount();
		});
	});
});
