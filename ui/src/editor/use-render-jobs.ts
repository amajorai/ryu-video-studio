import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { request } from "../bridge.ts";
import { type Job, jobResponseSchema, message } from "./format.ts";

/** How often the export queue is polled while the editor is visible. */
const POLL_INTERVAL_MS = 1500;
const ACTIVE = new Set(["pending", "running"]);
const FINISHED = new Set(["completed", "failed", "canceled"]);

/**
 * Poll the render queue while the view is visible and announce exports that
 * finish. Responses that predate a newly queued job are discarded so the new
 * job never flickers out of the list.
 */
export function useRenderJobs(
	ready: boolean,
	setStatus: (status: string) => void
) {
	const [jobs, setJobs] = useState<Job[]>([]);
	const renderStates = useRef<Record<string, string>>({});
	const renderRevision = useRef(0);
	useEffect(() => {
		if (!ready) {
			return;
		}
		let mounted = true;
		let pending = false;
		const poll = () => {
			if (!mounted || pending || !isViewVisible()) {
				return;
			}
			pending = true;
			const revision = renderRevision.current;
			void request(z.object({ jobs: z.array(jobResponseSchema) }), "/renders")
				.then((result) => {
					if (!mounted || revision !== renderRevision.current) {
						return;
					}
					setJobs(result.jobs);
					const nextStates: Record<string, string> = {};
					for (const job of result.jobs) {
						const previous = renderStates.current[job.id];
						if (previous && ACTIVE.has(previous) && FINISHED.has(job.status)) {
							setStatus(
								job.status === "completed"
									? "Export completed. Your video is ready to download."
									: (job.error ?? `Export ${job.status}.`)
							);
						}
						nextStates[job.id] = job.status;
					}
					renderStates.current = nextStates;
				})
				.catch((error) => {
					if (mounted && revision === renderRevision.current) {
						setStatus(message(error));
					}
				})
				.finally(() => {
					pending = false;
				});
		};
		const unsubscribe = subscribeViewVisibility(poll);
		poll();
		const timer = setInterval(poll, POLL_INTERVAL_MS);
		return () => {
			mounted = false;
			unsubscribe();
			clearInterval(timer);
		};
	}, [ready, setStatus]);
	const registerJob = useCallback((job: Job) => {
		renderRevision.current += 1;
		renderStates.current[job.id] = job.status;
		setJobs((current) => [job, ...current]);
	}, []);
	return { jobs, registerJob };
}
