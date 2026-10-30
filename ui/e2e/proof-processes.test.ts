import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	descendantPids,
	escapeRegExp,
	processTable,
	proofDirectory,
} from "./proof-processes.ts";

describe("proofDirectory", () => {
	test("accepts temporary and dedicated proof directories", () => {
		expect(proofDirectory(undefined)).toBe("/tmp/ryu-video-studio-core-proof");
		expect(proofDirectory(join(tmpdir(), "run-1"))).toBe(
			join(tmpdir(), "run-1")
		);
		expect(proofDirectory("/srv/ci/video-studio-proof")).toBe(
			"/srv/ci/video-studio-proof"
		);
	});

	test("refuses a developer's Ryu profile and arbitrary directories", () => {
		expect(() => proofDirectory(join(homedir(), ".ryu-dev"))).toThrow(
			"Refusing to run the Core proof"
		);
		expect(() => proofDirectory(join(homedir(), ".ryu"))).toThrow("Refusing");
		expect(() => proofDirectory(join(homedir(), "work"))).toThrow("Refusing");
		expect(() => proofDirectory("/tmp")).toThrow("Refusing");
	});
});

describe("descendantPids", () => {
	test("walks only the given process's tree", () => {
		const table = [
			{ pid: 10, ppid: 1 },
			{ pid: 11, ppid: 10 },
			{ pid: 12, ppid: 11 },
			{ pid: 13, ppid: 10 },
			// Another Core's sidecar from the same checkout.
			{ pid: 20, ppid: 1 },
			{ pid: 21, ppid: 20 },
		];
		expect(descendantPids(10, table)).toEqual([11, 13, 12]);
		expect(descendantPids(99, table)).toEqual([]);
	});

	test("reads this process from the live table", () => {
		const table = processTable();
		expect(table.some((entry) => entry.pid === process.pid)).toBe(true);
	});
});

test("escapeRegExp makes a path a literal pattern", () => {
	const path = "/tmp/run (1)+[a]/x.y";
	expect(new RegExp(`^${escapeRegExp(path)}$`).test(path)).toBe(true);
	expect(new RegExp(`^${escapeRegExp("/tmp/a.b")}`).test("/tmp/aXb")).toBe(
		false
	);
});
