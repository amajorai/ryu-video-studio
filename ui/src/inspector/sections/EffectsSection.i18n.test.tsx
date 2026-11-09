// The glow/light-leak group of the "Add effect" menu reads "Light effects":
// a bare "Light" is the brightness adjective in the catalog (de "Hell").
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	newSegment,
	segmentSchema,
} from "../../../../shared/project.ts";

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
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { EffectsSection } = await import("./EffectsSection.tsx");

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
	registerLiteralCatalogLoader(null);
});

// The adjective sense stays in the stub so a bare "Light" key would show.
const GERMAN: Record<string, string> = {
	Light: "Hell",
	"Light effects": "Lichteffekte",
};

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};

async function groupLabels(locale: string): Promise<string[]> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? GERMAN : {}
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<EffectsSection
					isAudio={false}
					onChange={() => undefined}
					segment={segmentSchema.parse(newSegment(video))}
					visualControls
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const labels = [...host.querySelectorAll("optgroup")].map(
		(group) => group.getAttribute("label") ?? ""
	);
	await act(async () => root.unmount());
	host.remove();
	return labels;
}

test("the light effects group renders as effects in German", async () => {
	const labels = await groupLabels("de");
	expect(labels).toContain("Lichteffekte");
	expect(labels).not.toContain("Hell");
});

test("English names the group as light effects", async () => {
	expect(await groupLabels("en")).toContain("Light effects");
});
