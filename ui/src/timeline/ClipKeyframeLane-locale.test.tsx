import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newSegment, type Project } from "../../../shared/project.ts";

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
const { I18nProvider } = await import("@ryu/i18n/react");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { selectClips } = await import("../editor/actions/select.ts");
const { Timeline } = await import("./Timeline.tsx");
const { KEYFRAME_LANES_ATTRIBUTE } = await import("./ClipKeyframeLane.tsx");
const { studioMessageOverlays } = await import("../i18n/catalog.ts");

// The shell's overlays plus the host pack's diamond sentences, so the spliced
// property name and the locale decimal are what is tested.
const overlays = studioMessageOverlays();
overlays.de = {
	...overlays.de,
	Opacity: "Deckkraft",
	"{label} keyframe at {time}, {text}": "{label}-Keyframe bei {time}, {text}",
	"{label}: {text} at {time}": "{label}: {text} bei {time}",
};
overlays.ja = {
	...overlays.ja,
	Opacity: "不透明度",
	"{label} keyframe at {time}, {text}": "{time} の{label}キーフレーム、{text}",
	"{label}: {text} at {time}": "{label}: {time} の {text}",
};

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

async function renderIn(locale: string) {
	const asset = testVideo("lanes.mp4", 20);
	const clip = {
		...newSegment(asset, 0, 0),
		keyframes: [
			{
				id: crypto.randomUUID(),
				property: "opacity" as const,
				time: 1,
				value: 0.5,
			},
		],
		sourceOut: 4,
	};
	const project: Project = { ...testProject().project, segments: [clip] };
	const runtime = createTestRuntime(project, [asset]);
	runtime.zoom = 70;
	runtime.time = 10;
	selectClips(runtime, [clip.id]);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				manageDocument={false}
				overlays={overlays}
			>
				<EditorProvider value={{ ...runtime }}>
					<Timeline />
				</EditorProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		host
			.querySelector<HTMLElement>(
				`[${KEYFRAME_LANES_ATTRIBUTE}="${clip.id}"] [data-keyframe-toggle]`
			)
			?.click();
	});
	const diamond = host.querySelector<HTMLElement>(
		'[data-keyframe-lane="opacity"] [data-keyframe-diamond]'
	);
	const read = {
		label: diamond?.getAttribute("aria-label") ?? "",
		title: diamond?.getAttribute("title") ?? "",
	};
	await act(async () => root.unmount());
	host.remove();
	return read;
}

test("clip keyframe diamonds splice the translated property name in Japanese", async () => {
	const ja = await renderIn("ja");
	expect(ja.label).toContain("不透明度キーフレーム");
	expect(ja.label).not.toContain("Opacity");
	expect(ja.title).toStartWith("不透明度: ");
	expect(ja.title).not.toContain(" at ");
});

test("clip keyframe values use the locale decimal separator", async () => {
	const de = await renderIn("de");
	expect(de.label).toStartWith("Deckkraft-Keyframe bei ");
	expect(de.label).toEndWith(", 0,50");
	expect(de.title).toStartWith("Deckkraft: 0,50 bei ");
});

test("English clip keyframe labels are unchanged", async () => {
	const en = await renderIn("en");
	expect(en.label).toStartWith("Opacity keyframe at ");
	expect(en.label).toEndWith(", 0.50");
	expect(en.title).toStartWith("Opacity: 0.50 at ");
});
