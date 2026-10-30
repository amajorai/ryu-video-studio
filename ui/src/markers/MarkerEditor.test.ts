import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { defaultMarkerColor } from "../editor/format.ts";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import {
	createMarkerPreferenceStore,
	PREVIEW_MARKER_LABELS_KEY,
} from "./marker-preferences.ts";

// MarkerEditor pulls in DOM-bound UI modules; load them with a DOM present so
// they are cached in a usable state for component suites in the same run.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const { markerDraftOf, markerPatch } = await import("./MarkerEditor.tsx");

afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
});

const marker = {
	comment: "Old",
	id: crypto.randomUUID(),
	label: "Cue",
	time: 4,
};

describe("markerPatch", () => {
	test("an untouched draft changes nothing", () => {
		expect(markerPatch(marker, markerDraftOf(marker))).toEqual({ patch: {} });
		expect(markerDraftOf(marker).color).toBe(defaultMarkerColor);
		expect(markerDraftOf(marker).status).toBe("open");
	});

	test("only edited fields are sent, and clearing is explicit", () => {
		const draft = {
			...markerDraftOf(marker),
			comment: "",
			duration: "2.5",
			label: " Hook ",
			status: "review" as const,
		};
		expect(markerPatch(marker, draft)).toEqual({
			patch: { comment: "", duration: 2.5, label: "Hook", status: "review" },
		});
		const ranged = { ...marker, duration: 3 };
		expect(
			markerPatch(ranged, { ...markerDraftOf(ranged), duration: "" })
		).toEqual({ patch: { duration: 0 } });
	});

	test("invalid drafts explain what to fix", () => {
		const draft = markerDraftOf(marker);
		expect(markerPatch(marker, { ...draft, label: "  " })).toEqual({
			error: "Give the marker a label.",
		});
		expect(markerPatch(marker, { ...draft, duration: "-1" })).toEqual({
			error: "Duration must be zero or more seconds.",
		});
		expect(markerPatch(marker, { ...draft, duration: "7199" })).toEqual({
			error: "The range would run past the timeline limit.",
		});
	});
});

describe("preview marker label preference", () => {
	function memoryArea(): ViewerStorageArea & { data: Map<string, string> } {
		const data = new Map<string, string>();
		return {
			data,
			getItem: (key) => data.get(key) ?? null,
			removeItem: (key) => {
				data.delete(key);
			},
			setItem: (key, value) => {
				data.set(key, value);
			},
		};
	}

	test("defaults off, persists per viewer, and notifies subscribers", () => {
		const area = memoryArea();
		const store = createMarkerPreferenceStore(area);
		expect(store.get()).toBe(false);
		let notified = 0;
		const stop = store.subscribe(() => {
			notified++;
		});
		store.set(true);
		store.set(true);
		stop();
		expect(notified).toBe(1);
		expect(
			[...area.data.keys()].at(0)?.endsWith(PREVIEW_MARKER_LABELS_KEY)
		).toBe(true);
		expect(createMarkerPreferenceStore(area).get()).toBe(true);
	});

	test("works without storage", () => {
		const throwing: ViewerStorageArea = {
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		const store = createMarkerPreferenceStore(throwing);
		store.set(true);
		expect(store.get()).toBe(true);
		expect(createMarkerPreferenceStore(null).get()).toBe(false);
	});
});
