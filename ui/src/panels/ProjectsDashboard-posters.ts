import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ProjectSummary } from "../../../shared/project-summary.ts";
import { request, studioResponseSchema } from "../bridge.ts";

const posterSchema = z.object({ data: z.string().max(40_000_000) });

/** Poster cache key: a new revision gets a new poster. */
export const posterKey = (summary: ProjectSummary) =>
	`${summary.id}:${summary.revision}`;

/**
 * Load posters one at a time so a large library never queues more than one
 * timeline frame render on the sidecar. Missing posters resolve to `null`.
 */
export function usePosters(summaries: readonly ProjectSummary[]) {
	const [posters, setPosters] = useState<Record<string, string | null>>({});
	const attempted = useRef(new Set<string>());
	const wanted = summaries.map(posterKey).join(",");
	useEffect(() => {
		let mounted = true;
		const queue = summaries.filter(
			(summary) => !attempted.current.has(posterKey(summary))
		);
		const next = async () => {
			const summary = queue.shift();
			if (!(summary && mounted)) {
				return;
			}
			const key = posterKey(summary);
			attempted.current.add(key);
			let poster: string | null = null;
			try {
				const result = posterSchema.safeParse(
					await request(studioResponseSchema, summary.posterUrl)
				);
				poster = result.success
					? `data:image/png;base64,${result.data.data}`
					: null;
			} catch {
				// No visual content yet, or media is busy: show the placeholder.
				poster = null;
			}
			if (mounted) {
				setPosters((current) => ({ ...current, [key]: poster }));
				await next();
			} else {
				attempted.current.delete(key);
			}
		};
		void next();
		return () => {
			mounted = false;
		};
		// `wanted` captures the identity of every summary in the list.
	}, [wanted]);
	return posters;
}
