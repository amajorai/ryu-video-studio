import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { detachClipAudio } from "../../../../shared/detach-audio.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	updateTrackSetting,
} from "../../../../shared/project.ts";

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
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"../../editor/test-runtime.ts"
);
const { DetachSection } = await import("./DetachSection.tsx");

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

function extractedAudio(video: Asset): Asset {
	return {
		...testVideo("camera audio", video.duration),
		derivation: "audio",
		derivedFromAssetId: video.id,
		height: 0,
		kind: "audio",
		width: 0,
	};
}

function fixture() {
	const video = testVideo("camera.mp4", 10);
	const audio = extractedAudio(video);
	const clip = newSegment(video, 0, 0);
	const project: Project = { ...newProject("Detach"), segments: [clip] };
	const detached = detachClipAudio(
		project,
		[video, audio],
		{ clipIds: [clip.id], revision: project.revision },
		() => audio
	);
	const audioClip = detached.segments.find(
		(segment) => segment.assetId === audio.id
	);
	if (!audioClip) {
		throw new Error("Detach did not create an audio clip.");
	}
	return { assets: [video, audio], audioClip, clip, detached, project };
}

async function render(project: Project, assets: Asset[], segment: Segment) {
	const runtime = createTestRuntime(project, assets);
	const routed: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		routed.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<DetachSection
					isAudio={false}
					onChange={() => undefined}
					segment={segment}
					visualControls
				/>
			</EditorProvider>
		);
	});
	const button = host.querySelector("button");
	const unmount = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return { button, routed, unmount };
}

describe("DetachSection", () => {
	test("offers Detach for a camera clip and routes detach-audio", async () => {
		const { assets, clip, project } = fixture();
		const view = await render(project, assets, clip);
		expect(view.button?.textContent).toBe("Detach audio");
		await act(async () => {
			view.button?.click();
		});
		expect(view.routed).toEqual([["detach-audio", { clipIds: [clip.id] }]]);
		await view.unmount();
	});

	test("offers Recover for either member of a detached pair", async () => {
		const { assets, audioClip, clip, detached } = fixture();
		const camera = detached.segments.find((segment) => segment.id === clip.id);
		if (!camera) {
			throw new Error("Camera clip missing.");
		}
		for (const segment of [camera, audioClip]) {
			const view = await render(detached, assets, segment);
			expect(view.button?.textContent).toBe("Recover audio");
			await act(async () => {
				view.button?.click();
			});
			expect(view.routed).toEqual([
				["reattach-audio", { clipIds: [segment.id] }],
			]);
			await view.unmount();
		}
	});

	test("disables Recover with a reason when the partner track is locked", async () => {
		const { assets, audioClip, clip, detached } = fixture();
		const locked = updateTrackSetting(detached, audioClip.track, {
			locked: true,
		});
		const camera = locked.segments.find((segment) => segment.id === clip.id);
		if (!camera) {
			throw new Error("Camera clip missing.");
		}
		const view = await render(locked, assets, camera);
		expect(view.button?.textContent).toBe("Recover audio");
		expect(view.button?.disabled).toBe(true);
		expect(view.button?.title).toBe(
			`Unlock track ${audioClip.track + 1} to recover its audio.`
		);
		await act(async () => {
			view.button?.click();
		});
		expect(view.routed).toEqual([]);
		await view.unmount();
	});

	test("renders nothing for media without camera audio", async () => {
		const silent = { ...testVideo("silent.mp4"), hasAudio: false };
		const clip = newSegment(silent);
		const view = await render(
			{ ...newProject("Silent"), segments: [clip] },
			[silent],
			clip
		);
		expect(view.button).toBeNull();
		await view.unmount();
	});
});
