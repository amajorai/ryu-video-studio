import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import {
	changeMulticamAngles,
	createMulticamGroup,
	expandMulticamSwitches,
	type MulticamChangeEntry,
} from "../../shared/multicam.ts";
import { type Asset, newProject } from "../../shared/project.ts";

GlobalRegistrator.register();
// React must load after happy-dom so its input-event support check sees a DOM.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { MULTICAM_LAYOUTS, MulticamPanel, programSummary, switcherEntry } =
	await import("./MulticamPanel.tsx");
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

const mounted: { container: HTMLElement; root: Root }[] = [];
afterEach(() => {
	for (const { container, root } of mounted.splice(0)) {
		act(() => root.unmount());
		container.remove();
	}
});

function media(name: string, kind: "audio" | "video"): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 6,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

function session() {
	const assets = [
		media("Wide", "video"),
		media("Close", "video"),
		media("Host", "audio"),
		media("Guest", "audio"),
	];
	const [wide, close, host, guest] = assets as [Asset, Asset, Asset, Asset];
	const project = newProject("Panel multicam");
	const created = createMulticamGroup(project, assets, {
		action: "create",
		masterAssetId: host.id,
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: host.id, kind: "mic", label: "Host" },
			{ assetId: guest.id, kind: "mic", label: "Guest" },
		],
		revision: project.revision,
	});
	return { assets, created };
}

const form = {
	angle: "Close",
	end: 3,
	fit: "fill" as const,
	kind: "angle" as const,
	layout: "side-by-side" as const,
	layoutAngles: [] as string[],
	mic: "Guest",
	start: 1,
};

test("the switcher form describes angle, mic, and layout entries", () => {
	expect(switcherEntry(form)).toEqual({ angle: "Close", end: 3, start: 1 });
	expect(switcherEntry({ ...form, kind: "mic" })).toEqual({
		audio: "Guest",
		end: 3,
		start: 1,
	});
	expect(switcherEntry({ ...form, kind: "layout" })).toBeNull();
	expect(
		switcherEntry({ ...form, kind: "layout", layoutAngles: ["Close", "Wide"] })
	).toEqual({
		end: 3,
		layout: { angles: ["Close", "Wide"], fit: "fill", layout: "side-by-side" },
		start: 1,
	});
	expect(switcherEntry({ ...form, end: 1 })).toBeNull();
	expect(MULTICAM_LAYOUTS).toContain("picture-in-picture");
	expect(MULTICAM_LAYOUTS).not.toContain("single");
});

test("the program summary lists picture and mic per range", () => {
	const { assets, created } = session();
	const changed = changeMulticamAngles(created.project, assets, {
		action: "change",
		entries: [
			{ audio: "Guest", end: 4, start: 2 },
			{
				end: 4,
				layout: { angles: ["Wide", "Close"], fit: "fit", layout: "stacked" },
				start: 3,
			},
		],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(programSummary(expandMulticamSwitches(changed.group))).toEqual([
		"0.00–2.00s · Wide · mic Host",
		"2.00–3.00s · Wide · mic Guest",
		"3.00–4.00s · Stacked: Wide, Close · mic Guest",
		"4.00–6.00s · Wide · mic Host",
	]);
});

test("the panel switches the program microphone over a range", async () => {
	const { assets, created } = session();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	const changes: [string, MulticamChangeEntry[]][] = [];
	await act(async () => {
		root.render(
			<MulticamPanel
				assets={assets}
				busy={false}
				onChange={(groupId, entries) => changes.push([groupId, entries])}
				onCreate={() => undefined}
				onUngroup={() => undefined}
				project={created.project}
			/>
		);
	});
	const select = (label: string, value: string) =>
		act(async () => {
			const element = container.querySelector<HTMLSelectElement>(
				`select[aria-label="${label}"]`
			);
			if (!element) {
				throw new Error(`Missing ${label}.`);
			}
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		});
	await select("Multicam switch type", "mic");
	await select("Multicam switch microphone", "Guest");
	await act(async () => {
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === "Switch microphone over range")
			?.click();
	});
	expect(changes).toEqual([
		[created.group.id, [{ audio: "Guest", end: 1, start: 0 }]],
	]);
	expect(container.textContent).toContain("press 1-9 to cut to an angle");
	expect(
		container.querySelector('[aria-label="Multicam program ranges"]')
			?.textContent
	).toContain("0.00–6.00s · Wide · mic Host");
});

test("a server commit of the same session keeps the switcher's slot order", async () => {
	const { assets, created } = session();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	const changes: [string, MulticamChangeEntry[]][] = [];
	const render = (project: typeof created.project) =>
		act(async () => {
			root.render(
				<MulticamPanel
					assets={assets}
					busy={false}
					onChange={(groupId, entries) => changes.push([groupId, entries])}
					onCreate={() => undefined}
					onUngroup={() => undefined}
					project={project}
				/>
			);
		});
	const click = (text: string, selector = "button") =>
		act(async () => {
			[...container.querySelectorAll<HTMLButtonElement>(selector)]
				.findLast((button) => button.textContent === text)
				?.click();
		});
	await render(created.project);
	await act(async () => {
		const element = container.querySelector<HTMLSelectElement>(
			'select[aria-label="Multicam switch type"]'
		);
		if (!element) {
			throw new Error("Missing switch type.");
		}
		element.value = "layout";
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
	// The switcher's slot buttons come after the create form's angle pickers.
	await click("Close", "button[aria-pressed]");
	await click("Wide", "button[aria-pressed]");
	await click("Show layout over range");
	const [first] = changes;
	expect(first?.[1][0]?.layout?.angles).toEqual(["Close", "Wide"]);
	// The server returns a freshly parsed project: every group is a new object.
	const committed = changeMulticamAngles(created.project, assets, {
		action: "change",
		entries: first?.[1] ?? [],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	await render(structuredClone(committed.project));
	await click("Show layout over range");
	expect(changes).toHaveLength(2);
	expect(changes[1]).toEqual(first);
});
