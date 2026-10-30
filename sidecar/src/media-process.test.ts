import { afterEach, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMedia } from "./media.ts";
import {
	FILTER_SCRIPT_OPTION,
	filterScriptArgs,
	filterScriptOptionFromProbe,
	killMediaProcess,
	LEGACY_FILTER_SCRIPT_OPTION,
	setFilterScriptOption,
} from "./media-process.ts";

afterEach(() => setFilterScriptOption(undefined));

test("the probe keeps the old option unless the build dropped it", () => {
	// FFmpeg 9 (Homebrew, Chocolatey).
	expect(
		filterScriptOptionFromProbe(
			"Unrecognized option 'filter_complex_script'.\nError splitting the argument list: Option not found\n"
		)
	).toBe(FILTER_SCRIPT_OPTION);
	// FFmpeg 6 to 8 still take the old option.
	expect(
		filterScriptOptionFromProbe(
			"Missing argument for option 'filter_complex_script'.\nError splitting the argument list: Invalid argument\n"
		)
	).toBe(LEGACY_FILTER_SCRIPT_OPTION);
	expect(filterScriptOptionFromProbe("")).toBe(LEGACY_FILTER_SCRIPT_OPTION);
});

test("only the graph-script option is respelled", async () => {
	setFilterScriptOption(FILTER_SCRIPT_OPTION);
	expect(
		await filterScriptArgs("ffmpeg", [
			"-i",
			"in.mp4",
			LEGACY_FILTER_SCRIPT_OPTION,
			"chunk-0000.graph",
			"-map",
			"[v]",
		])
	).toEqual([
		"-i",
		"in.mp4",
		FILTER_SCRIPT_OPTION,
		"chunk-0000.graph",
		"-map",
		"[v]",
	]);
	const inline = ["-filter_complex", "[0:v]null[v]"];
	expect(await filterScriptArgs("ffmpeg", inline)).toEqual(inline);
	setFilterScriptOption(LEGACY_FILTER_SCRIPT_OPTION);
	expect(
		await filterScriptArgs("ffmpeg", [LEGACY_FILTER_SCRIPT_OPTION, "x.graph"])
	).toEqual([LEGACY_FILTER_SCRIPT_OPTION, "x.graph"]);
});

test("a graph script runs on the installed FFmpeg, whichever option it takes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-filter-script-"));
	try {
		await writeFile(join(directory, "step.graph"), "[0:v]null[v]");
		await runMedia(
			[
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=s=16x16:r=5:d=0.4",
				LEGACY_FILTER_SCRIPT_OPTION,
				"step.graph",
				"-map",
				"[v]",
				"-f",
				"null",
				"-",
			],
			{ cwd: directory }
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("a media process is stopped once however often it is aborted", () => {
	let kills = 0;
	const child = new ChildProcess();
	child.kill = () => {
		kills++;
		return true;
	};
	killMediaProcess(child, "linux");
	killMediaProcess(child, "linux");
	expect(kills).toBe(1);
});
