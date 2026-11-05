import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import {
	type Asset,
	assetSchema,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import { subtitlesFontsOption } from "./fonts.ts";
import { assCaptions, buildRender } from "./render.ts";

/**
 * Render golden output. The snapshots in `__snapshots__/render-golden.test.ts.snap`
 * were captured from the monolithic `render.ts` before the stage split (W0-B), so
 * any byte change in the FFmpeg argv or the ASS script is a regression unless a
 * feature item intentionally changes a stage and updates the snapshot.
 */
const fixtureDirectory = join(import.meta.dir, "__fixtures__", "render");

const meshInputSchema = z
	.object({
		end: z.number(),
		path: z.string(),
		sequence: z.boolean().optional(),
		start: z.number(),
	})
	.strict();
const fixtureSchema = z
	.object({
		assets: z.array(assetSchema),
		assFile: z.string().optional(),
		frameTimes: z.array(z.number()),
		meshInputs: z.array(meshInputSchema).optional(),
		project: projectSchema,
	})
	.strict();
type RenderFixture = z.infer<typeof fixtureSchema>;

function loadFixtures(): [string, RenderFixture][] {
	return readdirSync(fixtureDirectory)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.map((file) => [
			file.replace(/\.json$/, ""),
			fixtureSchema.parse(
				JSON.parse(readFileSync(join(fixtureDirectory, file), "utf8"))
			),
		]);
}

const mediaPath = (id: string, clipId?: string) =>
	`/media/${id}${clipId ? `#${clipId}` : ""}`;

/**
 * The bundled fonts directory is an absolute, checkout-specific path, so the
 * snapshots record a placeholder in its place.
 */
const fontsOption = subtitlesFontsOption();
const MESH_FRAME_PATTERN = "frame-%06d.png";

function render(
	fixture: RenderFixture,
	project: Project = fixture.project,
	assets: Asset[] = fixture.assets,
	frameTime?: number
) {
	const args = buildRender(
		project,
		assets,
		mediaPath,
		fixture.assFile,
		fixture.meshInputs,
		frameTime
	);
	// Mesh frame patterns are joined with the platform separator; the
	// snapshots record the POSIX form. Only those exact arguments are mapped,
	// so filter-graph escapes are never touched.
	const meshPatterns = new Map(
		(fixture.meshInputs ?? []).map((mesh) => [
			join(mesh.path, MESH_FRAME_PATTERN),
			posix.join(mesh.path, MESH_FRAME_PATTERN),
		])
	);
	const portable = args.map((arg) => meshPatterns.get(arg) ?? arg);
	return fontsOption
		? portable.map((arg) =>
				arg.replaceAll(fontsOption, ":fontsdir=<bundled-fonts>")
			)
		: portable;
}

const fixtures = loadFixtures();

test("the golden suite covers the eight planned render fixtures", () => {
	expect(fixtures.map(([name]) => name)).toEqual([
		"captions-titles",
		"graphics-avatars",
		"keyframes",
		"multi-track",
		"plain",
		"prores",
		"sequence",
		"waveform",
	]);
});

describe.each(fixtures)("render golden: %s", (_name, fixture) => {
	test("export argv is unchanged", () => {
		expect(render(fixture)).toMatchSnapshot();
	});
	test.each(fixture.frameTimes)("frame argv at %ps is unchanged", (time) => {
		expect(
			render(fixture, fixture.project, fixture.assets, time)
		).toMatchSnapshot();
	});
	test("ASS script is unchanged", () => {
		expect(assCaptions(fixture.project)).toMatchSnapshot();
	});
});

describe("render golden: encoder profiles", () => {
	const plain = fixtures.find(([name]) => name === "plain")?.[1];
	const codecs = ["h264", "h265", "prores"] as const;
	const presets = ["review", "social", "master"] as const;
	for (const exportCodec of codecs) {
		for (const exportPreset of presets) {
			test(`${exportCodec} ${exportPreset} encode args are unchanged`, () => {
				if (!plain) {
					throw new Error("The plain render fixture is missing.");
				}
				const args = render(plain, {
					...plain.project,
					exportCodec,
					exportPreset,
				});
				expect(args.slice(args.indexOf("-map"))).toMatchSnapshot();
			});
		}
	}
});
