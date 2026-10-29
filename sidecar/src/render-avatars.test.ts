import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Avatar, Project } from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { avatarFilters } from "./render-avatars.ts";

const fixturePath = join(
	import.meta.dir,
	"__fixtures__",
	"render",
	"graphics-avatars.json"
);

async function fixtureProject(): Promise<Project> {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
		project: Project;
	};
	return fixture.project;
}

function withAnimation(
	project: Project,
	animation: Avatar["animation"]
): Project {
	return {
		...project,
		avatars: project.avatars.map((avatar) => ({
			...avatar,
			animation,
			entryDuration: avatar.entryDuration ?? 0.5,
		})),
	};
}

describe("avatar render filters", () => {
	test("no slide direction emits a sign before a parenthesis", async () => {
		const project = await fixtureProject();
		for (const animation of [
			"none",
			"idle",
			"slide-left",
			"slide-right",
		] as const) {
			const { filters } = avatarFilters(
				withAnimation(project, animation),
				"0:v"
			);
			expect(filters.length).toBeGreaterThan(0);
			for (const filter of filters) {
				expect(filter).not.toMatch(/[+\-*/]-\(/);
			}
		}
	});

	test("slide-left moves left and slide-right moves right of the rest position", async () => {
		const project = await fixtureProject();
		const xOf = (animation: Avatar["animation"]) =>
			avatarFilters(withAnimation(project, animation), "0:v").filters[1];
		expect(xOf("slide-left")).toContain("-((1-(");
		expect(xOf("slide-right")).toContain("+((1-(");
	});

	test("FFmpeg accepts a slide-left avatar graph", async () => {
		const project = withAnimation(await fixtureProject(), "slide-left");
		const { filters, last } = avatarFilters(project, "0:v");
		await runMedia([
			"-hide_banner",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=320x180:d=2:r=10",
			"-filter_complex",
			filters.join(";"),
			"-map",
			`[${last}]`,
			"-f",
			"null",
			"-",
		]);
	});

	test("exports animate the rig: the mouth opens and the slide entry moves", async () => {
		const fixture = await fixtureProject();
		const template = fixture.avatars[1];
		if (!template) {
			throw new Error("fixture avatar missing");
		}
		const avatar: Avatar = {
			...template,
			animation: "slide-left",
			end: 2,
			entryDuration: 1,
			height: 0.8,
			rigKeyframes: [
				{
					id: "00000000-0000-4000-8000-000000000021",
					property: "mouth",
					time: 0,
					value: 0,
				},
				{
					id: "00000000-0000-4000-8000-000000000022",
					property: "mouth",
					time: 1,
					value: 1,
				},
			],
			start: 0,
			width: 0.3,
			x: 0.3,
			y: 0.1,
		};
		const project: Project = { ...fixture, avatars: [avatar] };
		const width = 320;
		const height = 180;
		const directory = await mkdtemp(join(tmpdir(), "ryu-avatar-motion-"));
		const frameAt = async (time: number) => {
			const { filters, last } = avatarFilters(project, "base", {
				height,
				width,
			});
			const output = join(directory, `frame-${time}.gray`);
			await runMedia([
				"-hide_banner",
				"-v",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				`color=c=white:s=${width}x${height}:r=30:d=2`,
				"-filter_complex",
				`[0:v]null[base];${filters.join(";")};[${last}]format=gray[out]`,
				"-map",
				"[out]",
				"-ss",
				String(time),
				"-frames:v",
				"1",
				"-f",
				"rawvideo",
				output,
			]);
			return new Uint8Array(await Bun.file(output).arrayBuffer());
		};
		try {
			const early = await frameAt(0.1);
			const late = await frameAt(1.5);
			// Mouth band: the rows the mouth spans, across the head width at
			// either slide offset; nothing else dark is drawn there.
			const mouthTop = Math.round((avatar.y + avatar.height * 0.33) * height);
			const mouthRows = Math.round(avatar.height * 0.035 * height);
			const mouthPixels = (frame: Uint8Array) => {
				let count = 0;
				for (let row = mouthTop + 1; row < mouthTop + mouthRows - 1; row++) {
					for (let column = 0; column < width; column++) {
						if ((frame[row * width + column] ?? 255) < 50) {
							count++;
						}
					}
				}
				return count;
			};
			// Openness 0.1 draws 0.052 of the avatar width; openness 1 (held
			// after 1 s) draws 0.16, about three times as many pixels.
			expect(mouthPixels(late)).toBeGreaterThan(mouthPixels(early) * 2.2);
			expect(mouthPixels(early)).toBeGreaterThan(0);
			// The slide-left entry starts 0.08 of the canvas to the left.
			const leftEdge = (frame: Uint8Array) => {
				const row = Math.round((avatar.y + avatar.height * 0.6) * height);
				for (let column = 0; column < width; column++) {
					if ((frame[row * width + column] ?? 255) < 200) {
						return column;
					}
				}
				return width;
			};
			const shift = leftEdge(late) - leftEdge(early);
			expect(shift).toBeGreaterThan(0.08 * 0.9 * 0.8 * width);
			expect(shift).toBeLessThan(0.08 * width + 2);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
