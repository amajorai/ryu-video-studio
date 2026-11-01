import { describe, expect, test } from "bun:test";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import {
	readTourSeen,
	TOUR_STEPS,
	type TourState,
	tourReducer,
	writeTourSeen,
} from "./tour-state.ts";

describe("tour steps", () => {
	test("six steps with unique ids covering every panel and the layout controls", () => {
		expect(TOUR_STEPS).toHaveLength(6);
		expect(new Set(TOUR_STEPS.map((step) => step.id)).size).toBe(6);
		const targets = new Set(TOUR_STEPS.map((step) => step.target));
		for (const target of [
			"library",
			"stage",
			"timeline",
			"inspector",
			"layout",
		]) {
			expect(targets.has(target as never)).toBe(true);
		}
	});

	test("next walks every step in order and finishes after the last", () => {
		let state: TourState = tourReducer({ step: null }, { type: "start" });
		const visited: string[] = [];
		while (state.step !== null) {
			visited.push(TOUR_STEPS[state.step]?.id ?? "?");
			state = tourReducer(state, { type: "next" });
		}
		expect(visited).toEqual(TOUR_STEPS.map((step) => step.id));
	});

	test("back stops at the first step; dismiss closes from any step", () => {
		expect(tourReducer({ step: 0 }, { type: "back" })).toEqual({ step: 0 });
		expect(tourReducer({ step: 3 }, { type: "back" })).toEqual({ step: 2 });
		expect(tourReducer({ step: 3 }, { type: "dismiss" })).toEqual({
			step: null,
		});
		const closed: TourState = { step: null };
		expect(tourReducer(closed, { type: "next" })).toBe(closed);
		expect(tourReducer(closed, { type: "back" })).toBe(closed);
		expect(tourReducer(closed, { type: "start" }, [])).toEqual({ step: null });
	});
});

describe("tour seen state", () => {
	test("is stored per viewer and tolerates blocked storage", () => {
		const data = new Map<string, string>();
		const area: ViewerStorageArea = {
			getItem: (key) => data.get(key) ?? null,
			removeItem: (key) => {
				data.delete(key);
			},
			setItem: (key, value) => {
				data.set(key, value);
			},
		};
		expect(readTourSeen(area)).toBe(false);
		expect(writeTourSeen(area)).toBe(true);
		expect(readTourSeen(area)).toBe(true);
		const blocked: ViewerStorageArea = {
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => undefined,
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readTourSeen(blocked)).toBe(false);
		expect(writeTourSeen(blocked)).toBe(false);
		expect(readTourSeen(null)).toBe(false);
	});
});
