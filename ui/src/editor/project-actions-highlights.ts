import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { HighlightCandidate } from "../../../shared/highlights.ts";
import { planIsCurrent } from "../editing-ui.ts";
import {
	createHighlightShort,
	withHighlightMarker,
} from "../HighlightsPanel.tsx";
import { clock, message } from "./format.ts";
import { openFresh, withProject } from "./project-actions-open.ts";
import type { EditorRuntime } from "./runtime.ts";

export function markHighlight(
	runtime: EditorRuntime,
	candidate: HighlightCandidate,
	rank: number,
	stamp: string
) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	if (!planIsCurrent(stamp, project)) {
		runtime.setStatus(
			"The timeline changed since these highlights were found. Find them again before marking one."
		);
		return;
	}
	try {
		runtime.localEdit(
			withHighlightMarker(project, candidate, rank),
			`Highlight ${rank} marked at ${clock(candidate.start)}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

export const makeHighlightShort = (
	runtime: EditorRuntime,
	candidate: HighlightCandidate,
	rank: number,
	stamp: string,
	tl: LiteralMessage = englishMessages
) =>
	runtime.act(async () => {
		const current = runtime.latestProject.current;
		if (!(current && planIsCurrent(stamp, current))) {
			runtime.setStatus(
				"The timeline changed since these highlights were found. Find them again before making a short."
			);
			return;
		}
		const saved = await runtime.ensureSaved();
		if (!saved) {
			return;
		}
		const short = await createHighlightShort(saved, candidate, rank);
		runtime.setProjects((projects) => withProject(projects, short));
		runtime.latestProject.current = short;
		openFresh(runtime, short, { resetRange: false, resetTime: true });
		runtime.setDirty(false);
		runtime.setStatus(
			tl("{title} created as an alternate cut with only highlight {rank}.", {
				rank: String(rank),
				title: short.title,
			})
		);
	});
