import { afterEach, describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import { buildRenderProgram } from "./render.ts";
import {
	MAX_ARG_BYTES,
	renderArgvLimits,
	setRenderArgvLimits,
} from "./render-program.ts";

/** CreateProcess refuses a longer command line (ENAMETOOLONG). */
const WINDOWS_COMMAND_LINE = 32_767;
/** Per-input options (whitelists, `-ss`, `-t`, `-i`) of one clip input. */
const INPUT_OPTIONS = 180;
/** The longest classic Windows path. */
const MAX_PATH = 260;

const SOURCE: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 4000,
	hasAudio: true,
	height: 360,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "source.mp4",
	width: 640,
};

/** `count` back-to-back half-second clips. */
function timeline(count: number): Project {
	return {
		...newProject("Argv limits"),
		height: 180,
		segments: Array.from({ length: count }, (_, index) => ({
			...newSegment(SOURCE, index * 0.5),
			id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			sourceIn: 0,
			sourceOut: 0.5,
		})),
		width: 320,
	};
}

/** Command-line length as Windows builds it: each argument quoted, spaced. */
function windowsCommandLine(args: readonly string[]): number {
	return ["ffmpeg.exe", ...args].reduce(
		(total, arg) => total + arg.length + 3,
		0
	);
}

test("Linux keeps its argv limits", () => {
	expect(renderArgvLimits("linux")).toEqual({
		audioGroupClips: 100,
		chunkMaxSegments: 150,
		chunkMinSegments: 120,
		inlineGraphBytes: 64 * 1024,
	});
	expect(renderArgvLimits("darwin")).toEqual(renderArgvLimits("linux"));
});

test("a Windows run with full-length paths fits one command line", () => {
	const limits = renderArgvLimits("win32");
	const clips = Math.max(
		limits.audioGroupClips,
		limits.chunkMaxSegments,
		limits.chunkMinSegments
	);
	expect(
		clips * (INPUT_OPTIONS + MAX_PATH) + limits.inlineGraphBytes
	).toBeLessThan(WINDOWS_COMMAND_LINE);
});

describe("every step of a long export fits the platform's argv", () => {
	afterEach(() => setRenderArgvLimits());
	// A media folder deep in a Windows profile.
	const deep = `C:\\Users\\${"a".repeat(40)}\\AppData\\Local\\ryu\\plugin-data\\video-studio\\media`;
	const media = (id: string) => `${deep}\\${id}.mp4`;
	const steps = (count: number) =>
		buildRenderProgram(timeline(count), [SOURCE], media, undefined, [], {
			output: "export.mp4",
		}).steps;

	test.each(["win32", "linux"] as const)("%s", (platform) => {
		setRenderArgvLimits(platform);
		const limits = renderArgvLimits(platform);
		// Just under the chunk threshold renders in one pass.
		expect(steps(limits.chunkMinSegments).map((step) => step.kind)).toEqual([
			"single",
		]);
		for (const count of [limits.chunkMinSegments, 600]) {
			const program = steps(count);
			if (count > limits.chunkMinSegments) {
				expect(program.length).toBeGreaterThan(3);
			}
			for (const step of program) {
				const longest = Math.max(
					...step.args.map((arg) => Buffer.byteLength(arg))
				);
				expect(longest).toBeLessThan(MAX_ARG_BYTES);
				if (platform === "win32") {
					expect(windowsCommandLine(step.args)).toBeLessThan(
						WINDOWS_COMMAND_LINE
					);
				}
			}
		}
	});
});
