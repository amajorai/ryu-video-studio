/**
 * Real proof that a downloaded (bare binary) sidecar still has its bundled
 * title fonts and RNNoise model. The asset resolution code is compiled with
 * `bun build --compile`, the binary alone is copied into an empty directory
 * (no `assets/` next to it, as Core's downloader installs it) and run there:
 *
 * 1. it extracts every bundled font and the model to a private directory,
 *    byte-identical to `sidecar/assets`;
 * 2. libass resolves Anton and Source Code Pro Bold from the extracted fonts
 *    through `fontsdir` (FFmpeg debug log);
 * 3. FFmpeg's `arnndn` loads the extracted model and denoises a real signal.
 *
 * Run: `bun src/verify-embedded-assets.ts`
 */
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProject } from "../../shared/project.ts";
import { BUNDLED_FONT_FILES } from "../../shared/text-style.ts";
import { subtitlesFontsOption } from "./fonts.ts";
import { mediaBinary, runMedia } from "./media.ts";
import { assCaptions } from "./render-ass.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const source = join(import.meta.dir, "..", "assets");
const directory = await mkdtemp(join(tmpdir(), "ryu-verify-embedded-"));
try {
	const build = join(directory, "build");
	const install = join(directory, "install");
	const scratch = join(directory, "tmp");
	await mkdir(install);
	await mkdir(scratch, { mode: 0o700 });
	const compile = Bun.spawn(
		[
			process.execPath,
			"build",
			join(import.meta.dir, "embedded-assets-probe.ts"),
			"--compile",
			"--outfile",
			join(build, "probe"),
		],
		{ stderr: "pipe", stdout: "pipe" }
	);
	ensure(
		(await compile.exited) === 0,
		await new Response(compile.stderr).text()
	);
	const binary = join(install, "probe");
	await copyFile(join(build, "probe"), binary);
	await rm(build, { force: true, recursive: true });
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		TMPDIR: scratch,
	};
	const run = Bun.spawn([binary], {
		cwd: install,
		env,
		stderr: "pipe",
		stdout: "pipe",
	});
	const output = await new Response(run.stdout).text();
	ensure((await run.exited) === 0, await new Response(run.stderr).text());
	const found = JSON.parse(output) as {
		fonts: string | null;
		model: string | null;
	};
	ensure(found.fonts, "the bare binary found no bundled fonts");
	ensure(found.model, "the bare binary found no RNNoise model");
	ensure(
		found.fonts.startsWith(scratch) && found.model.startsWith(scratch),
		`assets were not extracted to the private temp directory: ${output}`
	);
	const fontsDirectory: string = found.fonts;
	for (const file of BUNDLED_FONT_FILES) {
		const extracted: Buffer = await readFile(join(fontsDirectory, file));
		const original: Buffer = await readFile(join(source, "fonts", file));
		ensure(extracted.equals(original), `${file} differs after extraction`);
	}
	const model = await readFile(found.model);
	ensure(
		model.equals(
			await readFile(join(source, "rnnoise", "somnolent-hogwash.rnnn"))
		),
		"the extracted RNNoise model differs"
	);
	process.stdout.write(
		`PASS: a bare compiled binary extracted ${BUNDLED_FONT_FILES.length} fonts and the RNNoise model intact.\n`
	);

	const script = join(directory, "titles.ass");
	await Bun.write(
		script,
		assCaptions({
			...newProject("Embedded fonts"),
			height: 360,
			titles: [
				{
					animation: "fade",
					color: "#ffffff",
					end: 1,
					fadeIn: 0,
					fadeOut: 0,
					fontFamily: "anton",
					fontSize: 0.1,
					id: crypto.randomUUID(),
					start: 0,
					text: "Anton",
					x: 0.5,
					y: 0.3,
				},
				{
					animation: "fade",
					color: "#ffffff",
					end: 1,
					fadeIn: 0,
					fadeOut: 0,
					fontFamily: "source-code-pro",
					fontSize: 0.1,
					fontWeight: 700,
					id: crypto.randomUUID(),
					start: 0,
					text: "Mono",
					x: 0.5,
					y: 0.7,
				},
			],
			width: 640,
		})
	);
	const subtitles = Bun.spawn(
		[
			mediaBinary("ffmpeg"),
			"-hide_banner",
			"-loglevel",
			"debug",
			"-f",
			"lavfi",
			"-i",
			"color=black:s=640x360:d=1",
			"-vf",
			`subtitles=filename=${script}${subtitlesFontsOption(found.fonts)}`,
			"-frames:v",
			"1",
			"-f",
			"null",
			"-",
		],
		{ stderr: "pipe", stdout: "ignore" }
	);
	const log = await new Response(subtitles.stderr).text();
	ensure((await subtitles.exited) === 0, log.slice(-2000));
	const selections = log
		.split("\n")
		.filter((line) => line.includes("fontselect"));
	for (const face of ["Anton-Regular", "SourceCodePro-Bold"]) {
		ensure(
			selections.some((line) => line.includes(`-> ${face}`)),
			`${face} did not resolve from the extracted fonts:\n${selections.join("\n")}`
		);
	}
	process.stdout.write(
		"PASS: libass resolves Anton and Source Code Pro Bold from the extracted fonts.\n"
	);

	const noisy = join(directory, "noisy.wav");
	const cleaned = join(directory, "cleaned.wav");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=300:sample_rate=48000:duration=2",
		"-f",
		"lavfi",
		"-i",
		"anoisesrc=color=white:amplitude=0.2:sample_rate=48000:duration=2",
		"-filter_complex",
		"[0][1]amix=inputs=2:normalize=0",
		noisy,
	]);
	const escaped = found.model.replace(/[\\':]/g, (char) => `\\${char}`);
	await runMedia(["-y", "-i", noisy, "-af", `arnndn=m='${escaped}'`, cleaned]);
	const rms = async (path: string) => {
		const pcm = join(directory, "probe.pcm");
		await runMedia(["-y", "-i", path, "-f", "s16le", "-ac", "1", pcm]);
		const samples = new Int16Array((await readFile(pcm)).buffer.slice(0));
		let sum = 0;
		for (const sample of samples) {
			sum += sample * sample;
		}
		return Math.sqrt(sum / Math.max(1, samples.length));
	};
	const before = await rms(noisy);
	const after = await rms(cleaned);
	ensure(
		after < before * 0.8,
		`arnndn with the extracted model did not reduce noise (${before.toFixed(0)} -> ${after.toFixed(0)})`
	);
	process.stdout.write(
		`PASS: arnndn loads the extracted model and lowers white-noise RMS ${before.toFixed(0)} -> ${after.toFixed(0)}.\n`
	);
} finally {
	await rm(directory, { force: true, recursive: true });
}
