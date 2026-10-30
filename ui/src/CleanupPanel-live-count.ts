import { useContext, useEffect, useEffectEvent, useState } from "react";
import type { Project } from "../../shared/project.ts";
import type { ResolvedVadParams } from "../../shared/vad.ts";
import { EditorContext } from "./editor/context.tsx";
import {
	audibleSourceIds,
	loadSilence,
	type SourceRange,
	silencePath,
	type TimelineSilenceSummary,
	timelineSilenceSummary,
} from "./silence-vad.ts";

/** Debounce before slider changes re-query voice activity. */
const LIVE_COUNT_DELAY_MS = 250;

export interface LiveVadCount {
	failed: number;
	loading: boolean;
	summary: TimelineSilenceSummary | null;
}

/**
 * Live count of voice-activity pauses on the timeline for the current
 * parameters. Each source is analyzed once by the sidecar; parameter changes
 * only reclassify cached frames.
 */
export function useLiveVadCount(
	project: Project,
	params: ResolvedVadParams,
	enabled: boolean
): LiveVadCount {
	const runtime = useContext(EditorContext);
	const ids = enabled ? audibleSourceIds(project, runtime?.assets) : [];
	const key = ids.map((id) => silencePath(id, params)).join("|");
	const [result, setResult] = useState<{
		failed: number;
		key: string;
		ranges: Map<string, SourceRange[]>;
	} | null>(null);
	const load = useEffectEvent(async (requestKey: string) => {
		const outcomes = await Promise.allSettled(
			ids.map(
				async (id) => [id, await loadSilence(silencePath(id, params))] as const
			)
		);
		const ranges = new Map<string, SourceRange[]>();
		let failed = 0;
		for (const outcome of outcomes) {
			if (outcome.status === "fulfilled") {
				ranges.set(...outcome.value);
			} else {
				failed += 1;
			}
		}
		return { failed, key: requestKey, ranges };
	});
	useEffect(() => {
		if (!key) {
			return;
		}
		let active = true;
		const timer = setTimeout(() => {
			void load(key).then((next) => {
				if (active) {
					setResult(next);
				}
			});
		}, LIVE_COUNT_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [key]);
	if (!key) {
		return { failed: 0, loading: false, summary: null };
	}
	if (result?.key !== key) {
		return { failed: 0, loading: true, summary: null };
	}
	return {
		failed: result.failed,
		loading: false,
		summary: timelineSilenceSummary(project, result.ranges),
	};
}

/** Human summary of the live VAD count. */
export function liveCountText(count: LiveVadCount): string {
	if (count.loading) {
		return "Listening for speech…";
	}
	if (!count.summary) {
		return "Add clips with audio to detect pauses.";
	}
	const { count: pauses, seconds } = count.summary;
	const skipped = count.failed
		? ` · ${count.failed} source${count.failed === 1 ? "" : "s"} unavailable`
		: "";
	return `${pauses} non-speech span${pauses === 1 ? "" : "s"} · ${seconds}s${skipped}`;
}
