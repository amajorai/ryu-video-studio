import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

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
const { I18nProvider } = await import("@ryu/i18n/react");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { Timeline } = await import("./Timeline.tsx");

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

async function renderIn(locale: string) {
	const { asset, project } = testProject();
	const runtime = createTestRuntime(project, [asset]);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				manageDocument={false}
			>
				<EditorProvider value={{ ...runtime }}>
					<Timeline />
				</EditorProvider>
			</I18nProvider>
		);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

describe("timeline direction", () => {
	test("the time axis stays LTR while its labels follow an RTL locale", async () => {
		const { host, unmount } = await renderIn("ar");
		expect(
			host.querySelector(".studio-timeline-scroll")?.getAttribute("dir")
		).toBe("ltr");
		const labels = [...host.querySelectorAll(".studio-track-label")];
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) {
			expect(label.getAttribute("dir")).toBe("rtl");
		}
		expect(
			host
				.querySelector("[data-timeline-ruler] > [data-no-scrub]")
				?.getAttribute("dir")
		).toBe("rtl");
		await unmount();
	});

	test("labels stay LTR in an LTR locale", async () => {
		const { host, unmount } = await renderIn("en");
		expect(
			host.querySelector(".studio-timeline-scroll")?.getAttribute("dir")
		).toBe("ltr");
		for (const label of host.querySelectorAll(".studio-track-label")) {
			expect(label.getAttribute("dir")).toBe("ltr");
		}
		await unmount();
	});
});
