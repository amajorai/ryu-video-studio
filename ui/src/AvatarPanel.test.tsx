import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import {
	type Asset,
	type Avatar,
	newSegment,
	type Project,
} from "../../shared/project.ts";

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
const { EditorProvider } = await import("./editor/context.tsx");
const { createTestRuntime, testProject, testVideo } = await import(
	"./editor/test-runtime.ts"
);
const { AvatarPanel, lipSyncSummary } = await import("./AvatarPanel.tsx");

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

type Runtime = ReturnType<typeof createTestRuntime>;

function avatar(extra: Partial<Avatar> = {}): Avatar {
	return {
		accent: "#f97316",
		animation: "idle",
		depth: 0.45,
		end: 4,
		entryDuration: 0.35,
		height: 0.64,
		id: crypto.randomUUID(),
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		start: 0,
		width: 0.28,
		x: 0.62,
		y: 0.2,
		...extra,
	};
}

function captureRouteEdits(runtime: Runtime) {
	const edits: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		edits.push([action, body]);
		return Promise.resolve({ status: "ok", extras: {} });
	};
	return edits;
}

async function render(node: ReactNode, runtime?: Runtime) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			runtime ? <EditorProvider value={runtime}>{node}</EditorProvider> : node
		);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

const lipSyncButton = (element: HTMLElement) =>
	[...element.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === "Lip-sync mouth to audio"
	);

function setValue(
	element: HTMLInputElement | HTMLSelectElement,
	value: string
) {
	const prototype =
		element instanceof HTMLSelectElement
			? HTMLSelectElement.prototype
			: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
		element,
		value
	);
	element.dispatchEvent(
		new Event(element instanceof HTMLSelectElement ? "change" : "input", {
			bubbles: true,
		})
	);
}

describe("AvatarPanel lip-sync", () => {
	test("runs the route for the overlapping clip with the chosen settings", async () => {
		const { asset, first, project } = testProject();
		const character = avatar();
		const withAvatar: Project = { ...project, avatars: [character] };
		const runtime = createTestRuntime(withAvatar, [asset]);
		const edits = captureRouteEdits(runtime);
		const view = await render(
			<AvatarPanel avatars={[character]} onChange={() => undefined} time={0} />,
			runtime
		);
		const source = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Avatar 1 lip-sync audio"]'
		);
		expect(source?.value).toBe(`segment:${first.id}`);
		// The clip at 10 s does not overlap the 0-4 s avatar.
		expect(source?.options).toHaveLength(2);
		const sensitivity = view.element.querySelector<HTMLInputElement>(
			'[aria-label="Avatar 1 lip-sync sensitivity"]'
		);
		await act(async () => {
			if (sensitivity) {
				setValue(sensitivity, "0.8");
			}
		});
		await act(async () => {
			lipSyncButton(view.element)?.click();
		});
		expect(edits).toEqual([
			[
				"avatars/lip-sync",
				{
					avatarId: character.id,
					envelope: "audio",
					segmentId: first.id,
					sensitivity: 0.8,
					smoothing: 0.4,
				},
			],
		]);
		await act(async () => {
			if (source) {
				setValue(source, `asset:${asset.id}`);
			}
		});
		const loudness = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Avatar 1 lip-sync loudness"]'
		);
		await act(async () => {
			if (loudness) {
				setValue(loudness, "analysis");
			}
		});
		await act(async () => {
			lipSyncButton(view.element)?.click();
		});
		expect(edits.at(-1)).toEqual([
			"avatars/lip-sync",
			{
				assetId: asset.id,
				avatarId: character.id,
				envelope: "analysis",
				sensitivity: 0.8,
				smoothing: 0.4,
			},
		]);
		await view.unmount();
	});

	test("skips muted clips and reports existing mouth keyframes", async () => {
		const voice: Asset = { ...testVideo("voice.wav", 6), kind: "audio" };
		const muted = { ...newSegment(voice, 0), muted: true };
		const heard = newSegment(voice, 1, 1);
		const character = avatar({
			rigKeyframes: [
				{ id: crypto.randomUUID(), property: "mouth", time: 0, value: 0 },
				{ id: crypto.randomUUID(), property: "mouth", time: 1, value: 0.6 },
				{ id: crypto.randomUUID(), property: "head", time: 1, value: 4 },
			],
		});
		const project: Project = {
			...testProject().project,
			avatars: [character],
			segments: [muted, heard],
		};
		const runtime = createTestRuntime(project, [voice]);
		const view = await render(
			<AvatarPanel avatars={[character]} onChange={() => undefined} time={0} />,
			runtime
		);
		const source = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Avatar 1 lip-sync audio"]'
		);
		expect(source?.value).toBe(`segment:${heard.id}`);
		expect(Array.from(source?.options ?? [], (option) => option.value)).toEqual(
			[`segment:${heard.id}`, `asset:${voice.id}`]
		);
		expect(view.element.textContent).toContain("2 mouth keyframes");
		await view.unmount();
	});

	test("is disabled without audio and hidden without an editor", async () => {
		const character = avatar();
		const project: Project = {
			...testProject().project,
			avatars: [character],
			segments: [],
		};
		const runtime = createTestRuntime(project, []);
		const view = await render(
			<AvatarPanel avatars={[character]} onChange={() => undefined} time={0} />,
			runtime
		);
		expect(lipSyncButton(view.element)?.disabled).toBe(true);
		expect(view.element.textContent).toContain("No audible media");
		await view.unmount();
		const bare = await render(
			<AvatarPanel avatars={[character]} onChange={() => undefined} time={0} />
		);
		expect(lipSyncButton(bare.element)).toBeUndefined();
		expect(bare.element.textContent).toContain("Avatar 1");
		await bare.unmount();
	});

	test("summarizes the route result", () => {
		expect(lipSyncSummary({ keyframes: 42, voicedRatio: 0.613 })).toBe(
			"Lip-synced the avatar: 42 mouth keyframes, mouth open 61% of the time."
		);
		expect(lipSyncSummary({})).toBe(
			"Lip-synced the avatar: 0 mouth keyframes, mouth open 0% of the time."
		);
	});
});
