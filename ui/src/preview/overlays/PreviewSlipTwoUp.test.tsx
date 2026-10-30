import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";
import { createTestRuntime, testVideo } from "../../editor/test-runtime.ts";
import {
	type FilmstripPlan,
	type FilmstripSprite,
	loadFilmstrip,
} from "../../timeline/clip-visual-cache.ts";
import {
	trimFeedbackFrames,
	trimFeedbackStoreFor,
	trimFramePlan,
} from "../../timeline/trim-feedback.ts";

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
	value: true,
	configurable: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("../../editor/context.tsx");
const { PreviewSlipTwoUp, TrimFeedbackViewer } = await import(
	"./PreviewSlipTwoUp.tsx"
);
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

const FPS = 30;

function fixture() {
	const asset = testVideo("slip.mp4", 60);
	const first: Segment = {
		...newSegment(asset, 0),
		sourceIn: 10,
		sourceOut: 20,
	};
	const second: Segment = {
		...newSegment(asset, 10),
		sourceIn: 30,
		sourceOut: 40,
	};
	const project: Project = {
		...newProject("Two-up"),
		fps: FPS,
		segments: [first, second],
	};
	return { asset, first, project, second };
}

const spriteFor = (plan: FilmstripPlan): FilmstripSprite => ({
	count: plan.count,
	frameHeight: plan.height,
	frameWidth: 160,
	url: `data:image/png;base64,${plan.start}`,
});

function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return {
		cleanup: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
		container,
		root,
	};
}

const wait = (ms: number) =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});

const imageTimes = (container: HTMLElement) =>
	[...container.querySelectorAll("img")].map((image) =>
		Number(image.dataset.time)
	);

describe("PreviewSlipTwoUp", () => {
	test("renders the slip's first and last source frames with their time queries", async () => {
		const { asset, first, project } = fixture();
		const runtime = createTestRuntime(project, [asset]);
		const proposal = { clipId: first.id, delta: 2, mode: "slip" as const };
		// Seed the shared filmstrip cache so the overlay loads without a sidecar.
		const expected = trimFeedbackFrames(project, [asset], proposal);
		for (const frame of expected?.frames ?? []) {
			const plan = trimFramePlan(frame, asset);
			if (plan) {
				await loadFilmstrip(plan, async (input) => spriteFor(input));
			}
		}
		const { cleanup, container, root } = mount();
		await act(async () => {
			root.render(
				<EditorProvider value={runtime}>
					<PreviewSlipTwoUp playing={false} project={project} time={0} />
				</EditorProvider>
			);
		});
		expect(container.querySelector('[data-testid="slip-two-up"]')).toBeNull();

		// A proposal alone, or a drag of another kind, shows nothing.
		await act(async () => {
			trimFeedbackStoreFor(runtime.store).set(proposal);
		});
		expect(container.querySelector('[data-testid="slip-two-up"]')).toBeNull();
		await act(async () => {
			runtime.store.setState({
				drag: { ids: [first.id], kind: "move", originX: 0, originY: 0 },
			});
		});
		expect(container.querySelector('[data-testid="slip-two-up"]')).toBeNull();

		await act(async () => {
			runtime.store.setState({
				drag: { ids: [first.id], kind: "slip", originX: 0, originY: 0 },
			});
		});
		await wait(0);
		const viewer = container.querySelector('[data-testid="slip-two-up"]');
		expect(viewer?.getAttribute("data-mode")).toBe("slip");
		const images = [...container.querySelectorAll("img")];
		expect(images).toHaveLength(2);
		expect(imageTimes(container)[0]).toBeCloseTo(12, 5);
		expect(imageTimes(container)[1]).toBeCloseTo(22 - 1 / FPS, 5);
		expect(images[0]?.dataset.request).toBe(
			`/assets/${asset.id}/filmstrip?count=1&end=12.002&height=90&start=12`
		);
		expect(images[1]?.dataset.request).toContain("start=21.966");
		expect(
			[...container.querySelectorAll("figcaption")].map(
				(caption) => caption.textContent
			)
		).toEqual(["First frame00:00:12:00", "Last frame00:00:21:29"]);

		await act(async () => {
			runtime.store.setState({ drag: null });
			trimFeedbackStoreFor(runtime.store).clear();
		});
		expect(container.querySelector('[data-testid="slip-two-up"]')).toBeNull();
		await cleanup();
	});

	test("roll drags show outgoing and incoming frames", async () => {
		const { asset, first, project, second } = fixture();
		const runtime = createTestRuntime(project, [asset]);
		const { cleanup, container, root } = mount();
		await act(async () => {
			trimFeedbackStoreFor(runtime.store).set({
				delta: 1,
				inClipId: second.id,
				mode: "roll",
				outClipId: first.id,
			});
			runtime.store.setState({
				drag: { ids: [first.id], kind: "roll", originX: 0, originY: 0 },
			});
			root.render(
				<EditorProvider value={runtime}>
					<PreviewSlipTwoUp playing={false} project={project} time={0} />
				</EditorProvider>
			);
		});
		const frames = [
			...container.querySelectorAll('[data-testid="slip-two-up-frame"]'),
		].map((frame) => frame.getAttribute("data-role"));
		expect(frames).toEqual(["outgoing", "incoming"]);
		await cleanup();
	});

	test("renders nothing outside an editor", async () => {
		const { project } = fixture();
		const { cleanup, container, root } = mount();
		await act(async () => {
			root.render(
				<PreviewSlipTwoUp playing={false} project={project} time={0} />
			);
		});
		expect(container.innerHTML).toBe("");
		await cleanup();
	});
});

describe("TrimFeedbackViewer", () => {
	test("debounces frame requests until the proposal holds still", async () => {
		const { asset, first, project } = fixture();
		const requested: FilmstripPlan[] = [];
		const load = async (plan: FilmstripPlan) => {
			requested.push(plan);
			return spriteFor(plan);
		};
		const feedbackAt = (delta: number) => {
			const feedback = trimFeedbackFrames(project, [asset], {
				clipId: first.id,
				delta,
				mode: "slip",
			});
			if (!feedback) {
				throw new Error("no feedback");
			}
			return feedback;
		};
		const { cleanup, container, root } = mount();
		const render = (delta: number) =>
			act(async () => {
				root.render(
					<TrimFeedbackViewer
						assets={[asset]}
						debounceMs={40}
						feedback={feedbackAt(delta)}
						fps={FPS}
						load={load}
					/>
				);
			});
		await render(1);
		await wait(0);
		expect(requested.map((plan) => plan.start)).toEqual([11, 20.966]);
		await render(2);
		await render(3);
		// Captions follow the live proposal; pictures wait for the debounce.
		expect(container.querySelector("figcaption")?.textContent).toBe(
			"First frame00:00:13:00"
		);
		expect(requested).toHaveLength(2);
		expect(imageTimes(container)[0]).toBe(11);
		await wait(80);
		expect(requested.map((plan) => plan.start)).toEqual([
			11, 20.966, 13, 22.966,
		]);
		expect(imageTimes(container)[0]).toBe(13);
		await cleanup();
	});

	test("a frame near the media's end shows the last tile of its sprite", async () => {
		// Regression: the route never seeks into the final 50 ms, so a tail
		// frame is read from a multi-tile range whose last tile is the frame.
		const asset = testVideo("tail.mp4", 59.99);
		const clip: Segment = {
			...newSegment(asset, 0),
			sourceIn: 50,
			sourceOut: 59.99,
		};
		const project: Project = {
			...newProject("Tail"),
			fps: 60,
			segments: [clip],
		};
		const feedback = trimFeedbackFrames(project, [asset], {
			clipId: clip.id,
			delta: 0,
			mode: "slip",
		});
		if (!feedback) {
			throw new Error("no feedback");
		}
		const { cleanup, container, root } = mount();
		await act(async () => {
			root.render(
				<TrimFeedbackViewer
					assets={[asset]}
					debounceMs={0}
					feedback={feedback}
					fps={60}
					load={async (plan) => spriteFor(plan)}
				/>
			);
		});
		await wait(10);
		const last = container.querySelectorAll("img")[1];
		expect(last?.dataset.request).toBe(
			`/assets/${asset.id}/filmstrip?count=2&end=59.99&height=90&start=59.926`
		);
		expect(last?.dataset.tile).toBe("1");
		expect(last?.style.left).toBe("-100%");
		expect(last?.style.width).toBe("200%");
		expect(container.querySelectorAll("img")[0]?.dataset.tile).toBe("0");
		await cleanup();
	});

	test("audio frames show a placeholder instead of a picture", async () => {
		const audio: Asset = { ...testVideo("voice.wav", 30), kind: "audio" };
		const clip: Segment = {
			...newSegment(audio, 0),
			sourceIn: 5,
			sourceOut: 10,
		};
		const project: Project = {
			...newProject("Audio"),
			fps: FPS,
			segments: [clip],
		};
		const feedback = trimFeedbackFrames(project, [audio], {
			clipId: clip.id,
			delta: 1,
			mode: "slip",
		});
		if (!feedback) {
			throw new Error("no feedback");
		}
		const { cleanup, container, root } = mount();
		await act(async () => {
			root.render(
				<TrimFeedbackViewer
					assets={[audio]}
					feedback={feedback}
					fps={FPS}
					load={async () => {
						throw new Error("audio has no frames");
					}}
				/>
			);
		});
		expect(container.querySelectorAll("img")).toHaveLength(0);
		expect(container.textContent).toContain("No picture");
		await cleanup();
	});
});
