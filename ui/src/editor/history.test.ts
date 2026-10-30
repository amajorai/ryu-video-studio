import { describe, expect, test } from "bun:test";
import { newProject, type Project } from "../../../shared/project.ts";
import {
	currentHistoryIndex,
	emptyHistory,
	HISTORY_LIMIT,
	HISTORY_ORIGIN_LABEL,
	HISTORY_TRIMMED_ORIGIN_LABEL,
	type HistoryState,
	historySteps,
	jumpHistory,
	mapHistory,
	recordHistory,
	redoHistory,
	undoHistory,
} from "./history.ts";

/** Four states (titles s0…s3) built by three labelled edits at t=1,2,3. */
function threeEdits(): { current: Project; history: HistoryState } {
	const base = { ...newProject("s0"), revision: 4 };
	let history = emptyHistory();
	let current = base;
	for (const index of [1, 2, 3]) {
		history = recordHistory(history, current, `Edit ${index}`, index);
		current = { ...current, title: `s${index}` };
	}
	return { current, history };
}

describe("history steps", () => {
	test("lists the origin, applied edits, and the current state", () => {
		const { history } = threeEdits();
		expect(historySteps(history)).toEqual([
			{ at: null, index: 0, label: HISTORY_ORIGIN_LABEL, state: "applied" },
			{ at: 1, index: 1, label: "Edit 1", state: "applied" },
			{ at: 2, index: 2, label: "Edit 2", state: "applied" },
			{ at: 3, index: 3, label: "Edit 3", state: "current" },
		]);
		expect(currentHistoryIndex(history)).toBe(3);
		expect(historySteps(emptyHistory())).toEqual([
			{ at: null, index: 0, label: HISTORY_ORIGIN_LABEL, state: "current" },
		]);
	});

	test("keeps the opened label at exactly the limit, since nothing was dropped", () => {
		let history = emptyHistory();
		const project = newProject();
		for (let index = 0; index < HISTORY_LIMIT; index++) {
			history = recordHistory(history, project, `Edit ${index}`, index);
		}
		expect(history.past).toHaveLength(HISTORY_LIMIT);
		expect(history.trimmed).toBeUndefined();
		expect(historySteps(history)[0]?.label).toBe(HISTORY_ORIGIN_LABEL);
		expect(historySteps(history)).toHaveLength(HISTORY_LIMIT + 1);
	});

	test("names the origin differently once the limit dropped a step", () => {
		let history = emptyHistory();
		const project = newProject();
		for (let index = 0; index <= HISTORY_LIMIT; index++) {
			history = recordHistory(history, project, `Edit ${index}`, index);
		}
		expect(history.past).toHaveLength(HISTORY_LIMIT);
		expect(history.past[0]?.label).toBe("Edit 1");
		expect(history.trimmed).toBe(true);
		expect(historySteps(history)[0]?.label).toBe(HISTORY_TRIMMED_ORIGIN_LABEL);
		expect(historySteps(history)).toHaveLength(HISTORY_LIMIT + 1);
	});

	test("undo, redo, jump, and later edits keep the trimmed origin label", () => {
		let history = emptyHistory();
		let current = newProject("t");
		for (let index = 0; index <= HISTORY_LIMIT; index++) {
			history = recordHistory(history, current, `Edit ${index}`, index);
			current = { ...current, title: `t${index}` };
		}
		expect(mapHistory(history, (project) => project).trimmed).toBe(true);
		const undone = undoHistory(history, current);
		expect(undone?.state.trimmed).toBe(true);
		const redone = redoHistory(
			undone?.state ?? history,
			undone?.project ?? current
		);
		expect(redone?.state.trimmed).toBe(true);
		const jumped = jumpHistory(history, current, 0);
		expect(jumped?.state.trimmed).toBe(true);
		expect(historySteps(jumped?.state ?? history)[0]?.label).toBe(
			HISTORY_TRIMMED_ORIGIN_LABEL
		);
		const edited = recordHistory(
			jumped?.state ?? history,
			jumped?.project ?? current,
			"After jump",
			500
		);
		expect(edited.past).toHaveLength(1);
		expect(historySteps(edited)[0]?.label).toBe(HISTORY_TRIMMED_ORIGIN_LABEL);
	});

	test("undo keeps each edit's label and time on the redo branch", () => {
		const { current, history } = threeEdits();
		const undone = undoHistory(history, current);
		expect(undone?.state.future).toEqual([
			{ at: 3, label: "Edit 3", project: current },
		]);
		const steps = historySteps(undone?.state ?? history);
		expect(steps.at(-1)).toEqual({
			at: 3,
			index: 3,
			label: "Edit 3",
			state: "undone",
		});
		expect(steps[2]?.state).toBe("current");
		const redone = redoHistory(
			undone?.state ?? history,
			undone?.project ?? current
		);
		expect(redone?.state.past.at(-1)).toMatchObject({ at: 3, label: "Edit 3" });
	});
});

describe("jumpHistory", () => {
	test("jumps back several steps at once and keeps the redo branch", () => {
		const { current, history } = threeEdits();
		const saved = { ...current, revision: 9 };
		const back = jumpHistory(history, saved, 1);
		expect(back?.project.title).toBe("s1");
		expect(back?.project.revision).toBe(9);
		expect(back?.state.past.map((entry) => entry.label)).toEqual(["Edit 1"]);
		expect(back?.state.future.map((entry) => entry.label)).toEqual([
			"Edit 2",
			"Edit 3",
		]);
		const origin = jumpHistory(history, saved, 0);
		expect(origin?.project.title).toBe("s0");
		expect(origin?.state.past).toEqual([]);
	});

	test("jumps forward along the kept branch to the newest state", () => {
		const { current, history } = threeEdits();
		const back = jumpHistory(history, current, 0);
		if (!back) {
			throw new Error("expected a jump");
		}
		const forward = jumpHistory(back.state, back.project, 3);
		expect(forward?.project.title).toBe("s3");
		expect(forward?.state.future).toEqual([]);
		expect(historySteps(forward?.state ?? history)).toEqual(
			historySteps(history)
		);
	});

	test("a new edit after a jump discards the redo branch", () => {
		const { current, history } = threeEdits();
		const back = jumpHistory(history, current, 1);
		if (!back) {
			throw new Error("expected a jump");
		}
		const branched = recordHistory(back.state, back.project, "Branch", 10);
		expect(branched.future).toEqual([]);
		expect(historySteps(branched).map((step) => step.label)).toEqual([
			HISTORY_ORIGIN_LABEL,
			"Edit 1",
			"Branch",
		]);
	});

	test("refuses the current index and out-of-range or fractional indexes", () => {
		const { current, history } = threeEdits();
		expect(jumpHistory(history, current, 3)).toBeNull();
		expect(jumpHistory(history, current, 4)).toBeNull();
		expect(jumpHistory(history, current, -1)).toBeNull();
		expect(jumpHistory(history, current, 1.5)).toBeNull();
	});

	test("keeps the current decisions through a multi-step jump", () => {
		const { current, history } = threeEdits();
		const decisions: Project["decisions"] = [
			{
				category: "edit",
				createdAt: new Date(0).toISOString(),
				decision: "Kept",
				id: crypto.randomUUID(),
				optionsConsidered: [],
				rationale: "",
				subject: "Cut",
			},
		];
		const back = jumpHistory(history, { ...current, decisions }, 0);
		expect(back?.project.decisions).toEqual(decisions);
	});
});
