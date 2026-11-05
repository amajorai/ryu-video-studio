import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject, type Title } from "../../../shared/project.ts";

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
const { createTestRuntime } = await import("../editor/test-runtime.ts");
const { OverlayLanes } = await import("./OverlayLanes.tsx");
const { studioMessageOverlays } = await import("../i18n/catalog.ts");

// The shell's overlays (as `main.tsx` installs them) plus the host pack's
// Japanese diamond sentence, so the spliced channel label is what is tested.
const overlays = studioMessageOverlays();
overlays.ja = {
	...overlays.ja,
	"{label} keyframe at {time}, {text}": "{time} の{label}キーフレーム、{text}",
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

// A collapsed titles lane from another file would hide the item.
beforeEach(() => {
	localStorage.clear();
});

const keyframeId = crypto.randomUUID();
const keyed: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 3,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.06,
	id: crypto.randomUUID(),
	keyframes: [
		{ color: "#0000ff", id: keyframeId, property: "color", time: 1, value: 0 },
	],
	start: 1,
	text: "Keyed",
	x: 0.5,
	y: 0.5,
};

async function renderIn(locale: string) {
	const runtime = createTestRuntime(
		{ ...newProject("Lanes"), titles: [keyed] },
		[]
	);
	runtime.zoom = 100;
	runtime.range = { end: 0, start: 0 };
	runtime.refresh();
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
				<EditorProvider value={runtime}>
					<OverlayLanes zoom={100} />
				</EditorProvider>
			</I18nProvider>
		);
	});
	const item = host.querySelector<HTMLElement>(
		`[data-overlay-id="${keyed.id}"]`
	);
	await act(async () => {
		item?.click();
	});
	await act(async () => {
		host
			.querySelector<HTMLElement>(
				`[data-overlay-keyframe-toggle="${keyed.id}"]`
			)
			?.click();
	});
	const diamond = host.querySelector<HTMLElement>(
		`[data-overlay-keyframe-diamond="${keyframeId}"]`
	);
	const read = {
		diamondLabel: diamond?.getAttribute("aria-label") ?? "",
		diamondTitle: diamond?.getAttribute("title") ?? "",
		itemLabel: item?.getAttribute("aria-label") ?? "",
	};
	await act(async () => root.unmount());
	host.remove();
	return read;
}

test("overlay item and keyframe labels splice translated nouns in Japanese", async () => {
	const ja = await renderIn("ja");
	expect(ja.itemLabel).toStartWith("タイトル Keyed ");
	expect(ja.diamondLabel).toContain("文字色キーフレーム");
	expect(ja.diamondLabel).not.toContain("Text color");
	expect(ja.diamondTitle).toStartWith("文字色: #0000ff");
});

test("English overlay labels are unchanged", async () => {
	const en = await renderIn("en");
	expect(en.itemLabel).toBe("Title Keyed 0:01.0 to 0:03.0");
	expect(en.diamondLabel).toStartWith("Text color keyframe at ");
	expect(en.diamondTitle).toStartWith("Text color: #0000ff at ");
});
