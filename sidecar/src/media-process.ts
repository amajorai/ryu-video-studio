/**
 * FFmpeg process details that differ between FFmpeg releases and platforms:
 * the option that reads a filter graph from a file, and stopping a run that
 * a package-manager shim started on Windows.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/** The filter-script option render programs are written with. */
export const LEGACY_FILTER_SCRIPT_OPTION = "-filter_complex_script";
/**
 * The FFmpeg 7+ spelling: a `/` prefix loads any option's value from a file.
 * FFmpeg 9 removed `-filter_complex_script`, and FFmpeg 6 (still the
 * Debian and Ubuntu LTS package) knows only the old name.
 */
export const FILTER_SCRIPT_OPTION = "-/filter_complex";

export type FilterScriptOption =
	| typeof FILTER_SCRIPT_OPTION
	| typeof LEGACY_FILTER_SCRIPT_OPTION;

const PROBE_TIMEOUT_MS = 15_000;

/**
 * The option a build accepts, from the stderr of
 * `ffmpeg -hide_banner -filter_complex_script` (no value). A build that
 * still has the option complains about the missing argument; one that
 * dropped it reports an unrecognized option. Anything else keeps the old
 * name, so the render reports the real failure.
 */
export function filterScriptOptionFromProbe(
	stderr: string
): FilterScriptOption {
	return /Unrecognized option '?filter_complex_script'?/i.test(stderr)
		? FILTER_SCRIPT_OPTION
		: LEGACY_FILTER_SCRIPT_OPTION;
}

let override: FilterScriptOption | undefined;
const probes = new Map<string, Promise<FilterScriptOption>>();

/** Force the filter-script option (tests). `undefined` restores probing. */
export function setFilterScriptOption(option: FilterScriptOption | undefined) {
	override = option;
}

function probeFilterScriptOption(binary: string): Promise<FilterScriptOption> {
	return new Promise((resolve) => {
		let stderr = "";
		const settle = (option: FilterScriptOption) => {
			clearTimeout(timer);
			resolve(option);
		};
		const child = spawn(binary, ["-hide_banner", LEGACY_FILTER_SCRIPT_OPTION], {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
		child.stderr?.on("data", (bytes: Buffer) => {
			stderr = (stderr + bytes.toString()).slice(-4000);
		});
		child.once("error", () => {
			// No binary yet: probe again on the next scripted run.
			probes.delete(binary);
			settle(LEGACY_FILTER_SCRIPT_OPTION);
		});
		child.once("close", () => settle(filterScriptOptionFromProbe(stderr)));
	});
}

/**
 * `args` with each `-filter_complex_script` spelled the way `binary`
 * accepts it. The build is probed once per binary, and only for argv that
 * reads a graph from a file.
 */
export async function filterScriptArgs(
	binary: string,
	args: readonly string[]
): Promise<string[]> {
	if (!args.includes(LEGACY_FILTER_SCRIPT_OPTION)) {
		return [...args];
	}
	let option = override;
	if (!option) {
		let probe = probes.get(binary);
		if (!probe) {
			probe = probeFilterScriptOption(binary);
			probes.set(binary, probe);
		}
		option = await probe;
	}
	return args.map((arg) =>
		arg === LEGACY_FILTER_SCRIPT_OPTION ? option : arg
	);
}

const stopping = new WeakSet<ChildProcess>();

/**
 * Stop a media process and everything it started. On Windows the `ffmpeg`
 * on PATH is often a package-manager shim (Chocolatey, Scoop) that runs the
 * real `ffmpeg.exe` as its own child: killing only the shim leaves the
 * encoder running and holding the output pipes, so the run never closes
 * until the encode ends. `taskkill /t` ends the whole tree first, then the
 * direct kill covers a tree that is already gone. Repeated calls for one
 * process do nothing.
 */
export function killMediaProcess(
	child: ChildProcess,
	platform: NodeJS.Platform = process.platform
): void {
	if (stopping.has(child)) {
		return;
	}
	stopping.add(child);
	const kill = () => child.kill("SIGKILL");
	if (platform !== "win32" || child.pid === undefined) {
		kill();
		return;
	}
	const system = process.env.SystemRoot;
	const taskkill = system
		? join(system, "System32", "taskkill.exe")
		: "taskkill.exe";
	try {
		const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.once("error", kill);
		killer.once("close", kill);
	} catch {
		kill();
	}
}
