/**
 * Real-FFmpeg proof for self-contained project archives. A project with a
 * real video clip graded through an imported `.cube` LUT, a real audio clip
 * and a title set in an imported font (a Lobster copy renamed "Ryufont", a
 * family no installed font has) is archived (package, media, LUT and font),
 * imported into a second, empty node, and one frame of each project is
 * rendered through each node's own LUT resolver and font library: the
 * imported copy must render the same picture from its own files, and its
 * assets must probe as the same kinds and durations. Two controls keep the
 * proof honest: the frame without the LUT and the frame without the font
 * must both differ.
 *
 * Run: `bun src/verify-project-archive.ts`
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customFontIdsIn } from "../../shared/library-refs.ts";
import { newSegment, type Project, type Title } from "../../shared/project.ts";
import { fontLibraryFor } from "./font-library.ts";
import { renameFontFamily } from "./font-rename.ts";
import { bundledFontsDirectory } from "./fonts.ts";
import { lutResolver, lutStoreFor } from "./lut-store.ts";
import { probe, runMedia } from "./media.ts";
import {
	buildProjectArchive,
	importProjectArchive,
} from "./package-archive.ts";
import { buildRender } from "./render.ts";
import { assCaptions } from "./render-ass.ts";
import { StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-archive-"));
const source = new StudioStore(join(directory, "source"));
const target = new StudioStore(join(directory, "target"));
const results: string[] = [];
try {
	const video = join(directory, "clip.mp4");
	const audio = join(directory, "tone.wav");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=25:d=2",
		"-pix_fmt",
		"yuv420p",
		video,
	]);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000:duration=2",
		audio,
	]);
	const register = async (path: string, name: string) => {
		const asset = {
			...(await probe(path)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name,
		};
		await Bun.write(source.mediaPath(asset.id), Bun.file(path));
		source.putAsset(asset);
		return asset;
	};
	const clip = await register(video, "clip.mp4");
	const tone = await register(audio, "tone.wav");
	// A 2-point LUT that inverts every channel: impossible to miss in a frame.
	const lut = await lutStoreFor(source.directory).add(
		"Invert",
		"LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n"
	);
	const bundled = bundledFontsDirectory();
	ensure(bundled, "bundled fonts are missing");
	const font = await fontLibraryFor(source.directory).add(
		"Ryufont.ttf",
		renameFontFamily(
			await readFile(join(bundled, "Lobster-Regular.ttf")),
			"Lobster",
			"Ryufont"
		)
	);
	const title: Title = {
		animation: "fade",
		color: "#ffffff",
		customFont: { family: font.family, id: font.id },
		end: 2,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.2,
		fontWeight: 400,
		id: "00000000-0000-4000-8000-000000000001",
		start: 0,
		text: "Grumpy wizards",
		x: 0.5,
		y: 0.5,
	};
	const graded = newSegment(clip, 0, 0);
	const project = source.save({
		...source.create("Archive proof"),
		height: 180,
		segments: [
			{
				...graded,
				colorGrade: {
					...graded.colorGrade,
					lut: { intensity: 1, lutId: lut.id },
				},
			},
			newSegment(tone, 0, 1),
		],
		titles: [title],
		width: 320,
	});

	const built = await buildProjectArchive(source, project);
	ensure(built.missing.length === 0, "media was left out of the archive");
	ensure(built.package.assets.length === 2, "the archive lacks an asset");
	ensure(
		built.package.luts?.length === 1 && built.missingLuts.length === 0,
		"the archive lacks the LUT"
	);
	ensure(
		built.package.fonts?.length === 1 && built.missingFonts.length === 0,
		"the archive lacks the imported font"
	);
	results.push(
		`archive holds the package, 2 media files, 1 LUT and 1 font (${built.size} bytes)`
	);

	const imported = await importProjectArchive(
		target,
		await Bun.file(built.path).bytes(),
		1024 * 1024 * 1024
	);
	await rm(join(built.path, ".."), { force: true, recursive: true });
	ensure(imported.added.length === 2, "the target did not ingest both files");
	ensure(
		imported.luts.added.join() === lut.id &&
			imported.fonts.added.join() === font.id,
		"the target did not register the LUT and font under their ids"
	);
	results.push(
		"the target re-registered the LUT and the font under their original ids"
	);
	for (const original of [clip, tone]) {
		const copy = target.assets().find((asset) => asset.id === original.id);
		ensure(copy, `${original.name} is not in the target library`);
		ensure(
			copy.kind === original.kind &&
				Math.abs(copy.duration - original.duration) < 0.05,
			`${original.name} probes differently after import`
		);
	}
	results.push("imported media probes as the same kinds and durations");

	async function frame(
		store: StudioStore,
		edit: Project,
		name: string,
		fontsDirectory?: string | null
	) {
		const work = join(directory, name);
		await Bun.write(join(work, "captions.ass"), assCaptions(edit));
		const png = join(work, "frame.png");
		await runMedia(
			[
				...buildRender(
					edit,
					store.assets(),
					(id) => store.mediaPath(id),
					"captions.ass",
					[],
					1,
					{
						fontsDirectory:
							fontsDirectory === undefined
								? await fontLibraryFor(store.directory).renderFontsDirectory(
										customFontIdsIn(edit),
										bundled
									)
								: fontsDirectory,
						lutPath: lutResolver(store.directory),
					}
				),
				png,
			],
			{ cwd: work }
		);
		const raw = join(work, "frame.rgb");
		await runMedia([
			"-y",
			"-i",
			png,
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			raw,
		]);
		return await readFile(raw);
	}
	const before = await frame(source, project, "source");
	const after = await frame(target, imported.project, "target");
	ensure(before.length === 320 * 180 * 3, "source frame has the wrong size");
	ensure(
		before.equals(after),
		"the imported project renders a different frame"
	);
	results.push(
		"the imported project renders the identical graded, titled frame from its own media, LUT and font"
	);
	const differing = (a: Buffer, b: Buffer) => {
		let count = 0;
		for (let index = 0; index < a.length; index++) {
			if (a[index] !== b[index]) {
				count++;
			}
		}
		return count;
	};
	const ungraded = await frame(
		target,
		{
			...imported.project,
			segments: imported.project.segments.map((segment) => ({
				...segment,
				colorGrade: { ...segment.colorGrade, lut: undefined },
			})),
		},
		"target-no-lut"
	);
	const lutDelta = differing(after, ungraded);
	ensure(lutDelta > 50_000, "the LUT made no visible difference");
	const unfonted = await frame(
		target,
		imported.project,
		"target-no-font",
		bundled
	);
	const fontDelta = differing(after, unfonted);
	ensure(fontDelta > 500, "the imported font made no visible difference");
	results.push(
		`controls: without the LUT ${lutDelta} bytes differ, without the font ${fontDelta} bytes differ`
	);

	for (const line of results) {
		console.info(`ok - ${line}`);
	}
} finally {
	source.close();
	target.close();
	await rm(directory, { force: true, recursive: true });
}
