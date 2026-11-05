import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StudioStore } from "./store.ts";

/**
 * Work files that color mattes and Lottie imports (G60) leave in
 * `media/` only when the sidecar stops mid-operation: `.lottie-<uuid>/`
 * frame directories and `.matte-<uuid>.png` temporaries. Frame sessions live
 * in memory, so after a restart nothing can resume them, and the store's
 * quota does not count dot-directories. The first matte or Lottie call after
 * the store opens removes them; every writer awaits this sweep before it
 * creates a work file, so the sweep never races a live one.
 */

const leftoverPattern = /^\.(?:lottie-[0-9a-f-]{36}|matte-[0-9a-f-]{36}\.png)$/;

const sweeps = new WeakMap<StudioStore, Promise<string[]>>();

/** True for a matte or Lottie work file name. */
export function isMediaLeftover(name: string): boolean {
	return leftoverPattern.test(name);
}

async function sweep(store: StudioStore): Promise<string[]> {
	const media = join(store.directory, "media");
	let names: string[];
	try {
		names = await readdir(media);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const name of names.filter(isMediaLeftover)) {
		try {
			await rm(join(media, name), { recursive: true, force: true });
			removed.push(name);
		} catch {
			// A file that cannot be removed now is retried after the next start.
		}
	}
	return removed;
}

/**
 * Remove leftover work files once per opened store. Resolves to the names
 * removed by the sweep (the same list for every caller).
 */
export function sweepMediaLeftovers(store: StudioStore): Promise<string[]> {
	let pending = sweeps.get(store);
	if (!pending) {
		pending = sweep(store);
		sweeps.set(store, pending);
	}
	return pending;
}
