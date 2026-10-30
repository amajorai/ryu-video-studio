import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listSystemFonts,
	MAX_SYSTEM_FONTS,
	parseFcListFamilies,
	resetSystemFonts,
} from "./system-fonts.ts";

const previous = process.env.RYU_VIDEO_STUDIO_FC_LIST;
afterEach(() => {
	resetSystemFonts();
	if (previous === undefined) {
		Reflect.deleteProperty(process.env, "RYU_VIDEO_STUDIO_FC_LIST");
	} else {
		process.env.RYU_VIDEO_STUDIO_FC_LIST = previous;
	}
});

test("fc-list families keep the primary name, sorted and unique", () => {
	expect(
		parseFcListFamilies(
			[
				"Inter Display,Inter Display Thin",
				"Inter",
				"DejaVu Sans Mono",
				"Inter,Inter Medium",
				"carlito",
				'Bad"Name',
				".LastResort",
				"",
			].join("\n")
		)
	).toEqual(["carlito", "DejaVu Sans Mono", "Inter", "Inter Display"]);
});

test("the list is capped", () => {
	const lines = Array.from(
		{ length: MAX_SYSTEM_FONTS + 5 },
		(_, index) => `Family ${String(index).padStart(5, "0")}`
	);
	expect(parseFcListFamilies(lines.join("\n"))).toHaveLength(MAX_SYSTEM_FONTS);
});

test("a node without fc-list reports the list unavailable", async () => {
	process.env.RYU_VIDEO_STUDIO_FC_LIST = "/nonexistent/fc-list";
	expect(await listSystemFonts()).toEqual({ available: false, fonts: [] });
});

test("reads families from the fc-list binary", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-fc-list-"));
	try {
		// Windows runs a batch file where POSIX runs a shell script; its
		// CRLF output must parse the same.
		const windows = process.platform === "win32";
		const script = join(directory, windows ? "fc-list.cmd" : "fc-list");
		await writeFile(
			script,
			windows
				? "@echo off\r\necho Noto Sans,Noto Sans Light\r\necho Carlito\r\n"
				: "#!/bin/sh\nprintf 'Noto Sans,Noto Sans Light\\nCarlito\\n'\n"
		);
		await chmod(script, 0o755);
		process.env.RYU_VIDEO_STUDIO_FC_LIST = script;
		expect(await listSystemFonts()).toEqual({
			available: true,
			fonts: ["Carlito", "Noto Sans"],
		});
	} finally {
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
