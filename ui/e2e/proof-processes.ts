/**
 * Guards for the native Core proof (`verify-core.ts`): where it may keep its
 * data, and which processes it may stop afterwards.
 */
import { homedir, tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";

/**
 * The proof reinstalls Video Studio and rewrites `preferences.db` in its data
 * directory, so it runs only in a temporary or dedicated proof directory,
 * never in a profile someone uses (`~/.ryu`, `~/.ryu-dev`, …).
 */
export function proofDirectory(candidate: string | undefined): string {
	const directory = resolve(candidate || "/tmp/ryu-video-studio-core-proof");
	const temporary = [tmpdir(), "/tmp"].some((parent) =>
		directory.startsWith(`${resolve(parent)}${sep}`)
	);
	const dedicated = basename(directory).includes("proof");
	const profile =
		directory.startsWith(`${resolve(homedir())}${sep}`) &&
		basename(directory).startsWith(".ryu");
	if (profile || !(temporary || dedicated)) {
		throw new Error(
			`Refusing to run the Core proof in ${directory}: use a temporary directory or one whose name contains "proof" (VIDEO_STUDIO_PROOF_DIR or RYU_DIR).`
		);
	}
	return directory;
}

/** Every process below `pid` in `table`, children before grandchildren. */
export function descendantPids(
	pid: number,
	table: readonly { pid: number; ppid: number }[]
): number[] {
	const found: number[] = [];
	const queue = [pid];
	for (
		let parent = queue.shift();
		parent !== undefined;
		parent = queue.shift()
	) {
		for (const entry of table) {
			if (entry.ppid === parent && !found.includes(entry.pid)) {
				found.push(entry.pid);
				queue.push(entry.pid);
			}
		}
	}
	return found;
}

/** The pid and parent pid of every process, from `ps`. */
export function processTable(): { pid: number; ppid: number }[] {
	const listing = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]);
	return new TextDecoder()
		.decode(listing.stdout)
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(
			(fields): fields is [number, number] =>
				fields.length === 2 && fields.every(Number.isSafeInteger)
		)
		.map(([pid, ppid]) => ({ pid, ppid }));
}

/** `value` as a literal in a regular expression (for `pkill -f`). */
export function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
