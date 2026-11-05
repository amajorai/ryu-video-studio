// Background soundtrack jobs: the retained job table, its pruning, and the
// failure a cancelled or failed render records. Rendering lives in
// `soundtrack.ts`.
import type { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import {
	type SoundtrackJob,
	soundtrackRequestSchema,
} from "../../shared/soundtrack.ts";
import {
	assertSynthesisSlot,
	generateSoundtrack,
	SoundtrackBusyError,
} from "./soundtrack.ts";
import type { StudioStore } from "./store.ts";

type SoundtrackInput = z.input<typeof soundtrackRequestSchema>;

const MAX_RETAINED_JOBS = 16;
const JOB_RETENTION_MS = 60 * 60 * 1000;
const jobs = new Map<string, SoundtrackJob & { finishedAt?: number }>();

const publicJob = ({
	finishedAt: _finishedAt,
	...job
}: SoundtrackJob & { finishedAt?: number }): SoundtrackJob => job;

function pruneJobs(now: number) {
	const finished = [...jobs.values()]
		.filter((job) => job.finishedAt !== undefined)
		.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	for (const job of finished) {
		const expired = now - (job.finishedAt ?? now) > JOB_RETENTION_MS;
		if (expired || jobs.size > MAX_RETAINED_JOBS) {
			jobs.delete(job.id);
		}
	}
}

const jobFailure = (
	error: unknown,
	aborted: boolean
): NonNullable<SoundtrackJob["error"]> => {
	if (error instanceof SoundtrackBusyError) {
		return { code: "SOUNDTRACK_BUSY", message: error.message };
	}
	if (aborted) {
		return {
			code: "CANCELLED",
			message: "The soundtrack was cancelled because Video Studio stopped.",
		};
	}
	return {
		code: "SOUNDTRACK_FAILED",
		message:
			error instanceof Error && error.message
				? error.message
				: "Soundtrack generation failed.",
	};
};

/**
 * Start rendering a soundtrack in the background and return its job. Claims
 * a synthesis slot synchronously, so a full budget throws
 * `SoundtrackBusyError` before any job is recorded. `signal` must not be tied
 * to the HTTP request, which ends when the 202 response is sent.
 */
export function startSoundtrackJob(
	store: StudioStore,
	input: SoundtrackInput,
	options: {
		/**
		 * Runs with the saved asset before the job is marked done (for example
		 * to place it on a timeline); a throw marks the job failed with its
		 * message while the asset stays in the library.
		 */
		finish?: (asset: Asset) => Promise<void> | void;
		signal?: AbortSignal;
		now?: () => number;
	} = {}
): SoundtrackJob {
	const now = options.now ?? Date.now;
	const request = soundtrackRequestSchema.parse(input);
	options.signal?.throwIfAborted();
	assertSynthesisSlot();
	pruneJobs(now());
	const id = crypto.randomUUID();
	const job: SoundtrackJob & { finishedAt?: number } = {
		id,
		status: "running",
		createdAt: new Date(now()).toISOString(),
	};
	jobs.set(id, job);
	// `generateSoundtrack` claims the slot before its first await.
	generateSoundtrack(store, request, { signal: options.signal })
		.then(async (asset) => {
			await options.finish?.(asset);
			return asset;
		})
		.then(
			(asset) => {
				jobs.set(id, {
					...job,
					asset,
					finishedAt: now(),
					status: "done",
				});
			},
			(error: unknown) => {
				jobs.set(id, {
					...job,
					error: jobFailure(error, options.signal?.aborted === true),
					finishedAt: now(),
					status: "failed",
				});
			}
		);
	return publicJob(job);
}

/** A background soundtrack job, if it is still retained. */
export function soundtrackJob(id: string): SoundtrackJob | undefined {
	const job = jobs.get(id);
	return job ? publicJob(job) : undefined;
}
