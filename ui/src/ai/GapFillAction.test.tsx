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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime } = await import("../editor/test-runtime.ts");
const { newProject, newSegment } = await import("../../../shared/project.ts");
const { GapFillAction } = await import("./GapFillAction.tsx");

type Asset = import("../../../shared/project.ts").Asset;
type Segment = import("../../../shared/project.ts").Segment;

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

function installHost(withImage: boolean) {
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			media: withImage
				? { image: async () => ["data:image/png;base64,AAAA"] }
				: {},
		},
		writable: true,
	});
}

const video: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 10,
	hasAudio: true,
	height: 720,
	id: crypto.randomUUID(),
	kind: "video",
	name: "clip.mp4",
	width: 1280,
};

async function render(segments: Segment[], inspected: Segment) {
	const project = { ...newProject("Gap fill"), segments };
	const runtime = createTestRuntime(project, [video]);
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<GapFillAction segment={inspected} />
			</EditorProvider>
		);
	});
	return element;
}

const first = { ...newSegment(video, 0), sourceOut: 4 };
const second = { ...newSegment(video, 6), sourceOut: 4 };

function fillButton(element: HTMLElement) {
	return [...element.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Fill gap with AI"
	);
}

describe("GapFillAction", () => {
	test("offers gap fill when a clip follows on the same track", async () => {
		installHost(true);
		const element = await render([first, second], first);
		expect(fillButton(element)?.disabled).toBe(false);
		expect(element.textContent).toContain("bridging still");
	});

	test("renders nothing for the last clip on its track", async () => {
		installHost(true);
		const element = await render([first, second], second);
		expect(element.textContent).toBe("");
	});

	test("explains and disables when the host has no image model", async () => {
		installHost(false);
		const element = await render([first, second], first);
		expect(fillButton(element)?.disabled).toBe(true);
		expect(element.textContent).toContain("unavailable in this host");
	});
});
