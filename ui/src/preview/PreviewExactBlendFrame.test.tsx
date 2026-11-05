import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	graphicSchema,
	newProject,
	newSegment,
	type Project,
	segmentSchema,
	titleSchema,
} from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

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
const { EditorProvider } = await import("../editor/context.tsx");
const { SERVER_FRAME_DELAY_MS } = await import("./PreviewAdjustmentLayer.tsx");
const { PreviewExactBlendFrame } = await import("./PreviewExactBlendFrame.tsx");
const { overlayBlendGapAt } = await import("./stages/blend.ts");
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

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 5,
	hasAudio: false,
	height: 1080,
	id: uuid(0xa1),
	kind: "image" as const,
	name: "still.png",
	width: 1920,
};

/** A subtract clip (CSS approximates it) over a base, with optional overlays. */
function scene(overlays: Partial<Project> = {}): Project {
	return {
		...newProject("Exact blend frame"),
		id: uuid(0xf0),
		segments: [
			segmentSchema.parse({ ...newSegment(asset), id: uuid(1), sourceOut: 4 }),
			segmentSchema.parse({
				...newSegment(asset),
				blendMode: "subtract",
				id: uuid(2),
				sourceOut: 4,
				track: 1,
			}),
		],
		...overlays,
	};
}

const graphic = (fields: Record<string, unknown> = {}) =>
	graphicSchema.parse({
		end: 4,
		fill: "#ff0000",
		height: 0.2,
		id: uuid(20),
		opacity: 1,
		shape: "rectangle",
		start: 0,
		width: 0.3,
		x: 0.1,
		y: 0.1,
		...fields,
	});

const title = (fields: Record<string, unknown> = {}) =>
	titleSchema.parse({
		color: "#ffffff",
		end: 4,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.08,
		id: uuid(10),
		start: 0,
		text: "Title",
		x: 0.5,
		y: 0.5,
		...fields,
	});

const roots: { unmount: () => void }[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

/** Paused, saved: the frames the server was asked for. */
async function requestsFor(
	project: Project,
	compositorShown: boolean
): Promise<string[]> {
	const requests: string[] = [];
	const runtime = {
		api: (path: string) => {
			requests.push(path);
			return Promise.resolve({ data: "AAAA", height: 1, width: 1 });
		},
		dirty: false,
		playing: false,
	} as Partial<EditorRuntime>;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime as EditorRuntime}>
				<PreviewExactBlendFrame
					compositorShown={compositorShown}
					project={project}
					time={1}
				/>
			</EditorProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(SERVER_FRAME_DELAY_MS + 30);
	});
	return requests;
}

describe("PreviewExactBlendFrame", () => {
	test("until the compositor has drawn, an approximate clip blend fetches the exact frame", async () => {
		expect(await requestsFor(scene(), false)).toEqual([
			`/projects/${uuid(0xf0)}/inspect-frame?time=1.000`,
		]);
	});

	test("a drawn compositor covers clip blends, so no frame is fetched", async () => {
		expect(await requestsFor(scene(), true)).toEqual([]);
	});

	test("a blended title or graphic above the compositor keeps the exact paused frame", async () => {
		const subtractGraphic = scene({
			graphics: [graphic({ blendMode: "subtract" })],
		});
		expect(await requestsFor(subtractGraphic, true)).toHaveLength(1);
		const blendedTitle = scene({ titles: [title({ blendMode: "screen" })] });
		expect(await requestsFor(blendedTitle, true)).toHaveLength(1);
	});
});

describe("overlayBlendGapAt", () => {
	test("counts on-screen titles with any blend and graphics with a preview gap", () => {
		expect(overlayBlendGapAt(scene(), 1)).toBe(false);
		// CSS draws screen exactly for an opaque graphic.
		expect(
			overlayBlendGapAt(
				scene({ graphics: [graphic({ blendMode: "screen" })] }),
				1
			)
		).toBe(false);
		expect(
			overlayBlendGapAt(
				scene({ graphics: [graphic({ blendMode: "add", opacity: 0.5 })] }),
				1
			)
		).toBe(true);
		// Titles preview without their blend mode.
		expect(
			overlayBlendGapAt(scene({ titles: [title({ blendMode: "screen" })] }), 1)
		).toBe(true);
		expect(
			overlayBlendGapAt(
				scene({ titles: [title({ blendMode: "screen", start: 2 })] }),
				1
			)
		).toBe(false);
	});
});
