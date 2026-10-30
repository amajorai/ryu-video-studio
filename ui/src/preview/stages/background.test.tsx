import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";
import type { PreviewSources } from "../../preview-sources.ts";

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
const { createTestRuntime } = await import("../../editor/test-runtime.ts");
const {
	backgroundSourceTime,
	clipFillStyle,
	PreviewCanvasBackground,
	PreviewClipBackground,
} = await import("./background.tsx");
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

const roots: { unmount: () => void }[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 8,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-0000000000a2",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const tone: Asset = {
	...video,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-0000000000a3",
	kind: "audio",
	name: "Tone",
	width: 0,
};
const still: Asset = {
	...video,
	id: "00000000-0000-4000-8000-0000000000a1",
	kind: "image",
	name: "Still",
};

async function render(
	node: ReactNode,
	project?: Project,
	assets: Asset[] = []
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const runtime = project ? createTestRuntime(project, assets) : null;
	if (runtime) {
		runtime.previewSources = {
			snapshot: () => ({
				[video.id]: "blob:clip",
				[still.id]: "blob:still",
				[tone.id]: "blob:tone",
			}),
		} as unknown as PreviewSources;
	}
	await act(async () => {
		root.render(
			runtime ? <EditorProvider value={runtime}>{node}</EditorProvider> : node
		);
	});
	return container;
}

const projectWith = (fields: Partial<Project>, segments: Segment[] = []) => ({
	...newProject("Preview backgrounds"),
	...fields,
	segments,
});

describe("PreviewCanvasBackground", () => {
	test("renders nothing without an explicit background or for blur", async () => {
		for (const project of [
			projectWith({}),
			projectWith({ background: { amount: 0.5, dim: 0, type: "blur" } }),
		]) {
			const container = await render(
				<PreviewCanvasBackground project={project} time={0} />
			);
			expect(container.innerHTML).toBe("");
		}
	});

	test("draws colors and CSS gradients", async () => {
		const colored = await render(
			<PreviewCanvasBackground
				project={projectWith({
					background: { color: "#336699", type: "color" },
				})}
				time={0}
			/>
		);
		const fill = colored.querySelector<HTMLElement>(
			"[data-testid=preview-canvas-background]"
		);
		expect(fill?.style.background).toContain("#336699");
		const graded = await render(
			<PreviewCanvasBackground
				project={projectWith({
					background: {
						angle: 45,
						color: "#000000",
						color2: "#ffffff",
						type: "gradient",
					},
				})}
				time={0}
			/>
		);
		expect(
			graded.querySelector<HTMLElement>(
				"[data-testid=preview-canvas-background]"
			)?.style.background
		).toContain("linear-gradient(45deg");
	});

	test("an image reuses the clip preview source and covers the frame", async () => {
		const project = projectWith({
			background: { assetId: still.id, type: "image" },
		});
		const container = await render(
			<PreviewCanvasBackground project={project} time={0} />,
			project,
			[still]
		);
		const image = container.querySelector("img");
		expect(image?.getAttribute("src")).toBe("blob:still");
		expect(image?.className).toContain("object-cover");
	});

	test("a canvas video follows the playhead, looped", async () => {
		const project = projectWith({
			background: { assetId: video.id, type: "image" },
		});
		const container = await render(
			<PreviewCanvasBackground project={project} time={19.5} />,
			project,
			[video]
		);
		const element = container.querySelector("video");
		expect(element?.getAttribute("src")).toBe("blob:clip");
		expect(element?.loop).toBe(true);
		expect(element?.autoplay).toBe(false);
		// 19.5 s into an 8 s loop is 3.5 s in.
		expect(element?.currentTime).toBeCloseTo(3.5, 3);
	});
});

describe("PreviewClipBackground", () => {
	const segment = { ...newSegment(video), sourceOut: 4 };

	test("draws a clip color only while the clip is active, at its z-index", async () => {
		const colored = {
			...segment,
			background: { color: "#c02090", type: "color" as const },
			track: 2,
		};
		const project = projectWith({}, [colored]);
		const inactive = await render(
			<PreviewClipBackground
				active={false}
				project={project}
				segment={colored}
				time={9}
			/>
		);
		expect(inactive.innerHTML).toBe("");
		const active = await render(
			<PreviewClipBackground
				active
				project={project}
				segment={colored}
				time={1}
			/>
		);
		const fill = active.querySelector<HTMLElement>(
			"[data-testid=preview-clip-background]"
		);
		expect(fill?.style.background).toContain("#c02090");
		expect(fill?.style.zIndex).toBe("3");
	});

	test("a project blur draws a blurred copy under base-track clips", async () => {
		const project = projectWith(
			{ background: { amount: 0.5, dim: 0.25, type: "blur" } },
			[segment]
		);
		const container = await render(
			<PreviewClipBackground
				active
				project={project}
				segment={segment}
				time={1}
			/>,
			project,
			[video]
		);
		const copy = container.querySelector("video");
		expect(copy?.getAttribute("src")).toBe("blob:clip");
		expect(copy?.muted).toBe(true);
		expect(copy?.style.filter).toContain("brightness(0.75)");
		const upper = { ...segment, track: 1 };
		const none = await render(
			<PreviewClipBackground
				active
				project={project}
				segment={upper}
				time={1}
			/>,
			project,
			[video]
		);
		expect(none.innerHTML).toBe("");
	});

	test("blur without an editor (or a source) renders nothing", async () => {
		const blurred = {
			...segment,
			background: { amount: 1, dim: 0, type: "blur" as const },
		};
		const container = await render(
			<PreviewClipBackground
				active
				project={projectWith({}, [blurred])}
				segment={blurred}
				time={1}
			/>
		);
		expect(container.innerHTML).toBe("");
	});

	test("a fill takes the clip's opacity and fades", async () => {
		const faint = {
			...segment,
			background: { color: "#c02090", type: "color" as const },
			fadeIn: 1,
			opacity: 0.5,
		};
		const project = projectWith({}, [faint]);
		const container = await render(
			<PreviewClipBackground
				active
				project={project}
				segment={faint}
				time={0.5}
			/>
		);
		const fill = container.querySelector<HTMLElement>(
			"[data-testid=preview-clip-background]"
		);
		expect(Number(fill?.style.opacity)).toBeCloseTo(0.25, 5);
		const blurred = projectWith(
			{ background: { amount: 0.5, dim: 0.25, type: "blur" } },
			[{ ...segment, opacity: 0.3 }]
		);
		const copy = await render(
			<PreviewClipBackground
				active
				project={blurred}
				segment={{ ...segment, opacity: 0.3 }}
				time={1}
			/>,
			blurred,
			[video]
		);
		const element = copy.querySelector<HTMLElement>("video");
		expect(Number(element?.style.opacity)).toBeCloseTo(0.3, 5);
		expect(element?.style.filter).toContain("brightness(0.75)");
	});

	test("a crossfade fades the incoming clip's fill in with it", () => {
		const incoming = {
			...segment,
			entryDuration: 1,
			entryTransition: "crossfade" as const,
		};
		expect(clipFillStyle(incoming, 0.5, 16 / 9).opacity).toBeCloseTo(0.5, 5);
		expect(clipFillStyle(incoming, 2, 16 / 9).opacity).toBe(1);
		expect(clipFillStyle(segment, 1, 16 / 9, "blur(2px)").filter).toBe(
			"blur(2px)"
		);
	});

	test("waveform clips and keyed clips get no project blur", async () => {
		const blur = { amount: 0.5, dim: 0.25, type: "blur" as const };
		const wave = {
			...newSegment(tone),
			sourceOut: 2,
			visualization: "waveform" as const,
		};
		const waveProject = projectWith({ background: blur }, [wave]);
		const waveFill = await render(
			<PreviewClipBackground
				active
				project={waveProject}
				segment={wave}
				time={1}
			/>,
			waveProject,
			[tone]
		);
		expect(waveFill.innerHTML).toBe("");
		const masked = {
			...segment,
			masks: [
				{
					height: 0.5,
					id: "m1",
					type: "rectangle" as const,
					width: 0.5,
					x: 0.5,
					y: 0.5,
				},
			],
		} as unknown as Segment;
		const maskedProject = projectWith({ background: blur }, [masked]);
		const maskedFill = await render(
			<PreviewClipBackground
				active
				project={maskedProject}
				segment={masked}
				time={1}
			/>,
			maskedProject,
			[video]
		);
		expect(maskedFill.innerHTML).toBe("");
	});

	test("the copy follows the clip's source time", () => {
		const timed = { ...segment, sourceIn: 2, speed: 2, start: 10 };
		expect(backgroundSourceTime(timed, 9)).toBe(2);
		expect(backgroundSourceTime(timed, 11)).toBe(4);
		expect(backgroundSourceTime(timed, 30)).toBe(4);
	});
});
