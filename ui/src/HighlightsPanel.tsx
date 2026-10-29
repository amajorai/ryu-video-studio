import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useEffectEvent, useState } from "react";
import { z } from "zod";
import {
	type HighlightCandidate,
	highlightToRanges,
} from "../../shared/highlights.ts";
import {
	type Project,
	projectDuration,
	projectSchema,
} from "../../shared/project.ts";
import { request } from "./bridge.ts";
import {
	planIsCurrent,
	planStamp,
	projectEditResponse,
	timelineClock,
} from "./editing-ui.ts";
import { NumberField } from "./NumberField.tsx";
import type { TimelineGuide } from "./SplitEditPanel.tsx";

const candidatesSchema = z.object({
	candidates: z.array(
		z.object({
			end: z.number(),
			reasons: z.array(z.string()),
			score: z.number(),
			start: z.number(),
			title: z.string(),
		})
	),
	revision: z.number(),
});

/** Comma-separated keywords, trimmed and bounded like the highlights request. */
export function parseKeywords(text: string): string[] {
	return [
		...new Set(
			text
				.split(",")
				.map((word) => word.trim().slice(0, 40))
				.filter(Boolean)
		),
	].slice(0, 20);
}

/**
 * Make a short from a highlight: duplicate the saved project as an alternate
 * cut, then ripple-delete everything outside the highlight window.
 */
export async function createHighlightShort(
	source: Project,
	candidate: Pick<HighlightCandidate, "end" | "start" | "title">,
	rank: number
): Promise<Project> {
	const duplicate = projectSchema.parse(
		await request(z.json(), `/projects/${source.id}/duplicate`, "POST", {
			title: `${source.title} · short ${rank}`.slice(0, 200),
		})
	);
	const ranges = highlightToRanges(candidate, projectDuration(duplicate));
	if (!ranges.length) {
		return duplicate;
	}
	return projectEditResponse(
		await request(z.json(), `/projects/${duplicate.id}/remove-words`, "POST", {
			ranges,
			revision: duplicate.revision,
		})
	).project;
}

/** Add a ranged review marker spanning a highlight. */
export function withHighlightMarker(
	project: Project,
	candidate: Pick<HighlightCandidate, "end" | "start" | "title">,
	rank: number
): Project {
	const time = Number(candidate.start.toFixed(3));
	if (project.markers.some((marker) => marker.time === time)) {
		throw new Error("A marker already starts at this highlight.");
	}
	if (project.markers.length >= 500) {
		throw new Error("This project already has the 500-marker limit.");
	}
	return {
		...project,
		markers: [
			...project.markers,
			{
				color: "#22c55e",
				comment: candidate.title.slice(0, 2000),
				duration: Number((candidate.end - candidate.start).toFixed(3)),
				id: crypto.randomUUID(),
				label: `Highlight ${rank}`,
				time,
			},
		].sort((a, b) => a.time - b.time),
	};
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : "Finding highlights failed.";

export function HighlightsPanel({
	busy,
	ensureSaved,
	onError,
	onGuides,
	onMakeShort,
	onMark,
	onSeek,
	project,
}: {
	busy: boolean;
	ensureSaved: () => Promise<Project | undefined>;
	onError: (text: string) => void;
	onGuides: (guides: TimelineGuide[]) => void;
	onMakeShort: (
		candidate: HighlightCandidate,
		rank: number,
		planStamp: string
	) => void;
	onMark: (
		candidate: HighlightCandidate,
		rank: number,
		planStamp: string
	) => void;
	onSeek: (time: number) => void;
	project: Project;
}) {
	const tl = useLiteralMessages();
	const [count, setCount] = useState(5);
	const [minimum, setMinimum] = useState(15);
	const [maximum, setMaximum] = useState(60);
	const [keywords, setKeywords] = useState("");
	const [candidates, setCandidates] = useState<HighlightCandidate[] | null>(
		null
	);
	const [candidatesStamp, setCandidatesStamp] = useState<string | null>(null);
	const [working, setWorking] = useState(false);
	// Candidate windows are absolute timeline times for one revision.
	const current = planIsCurrent(candidatesStamp, project);

	const publishGuides = useEffectEvent(() => {
		onGuides(
			(current ? (candidates ?? []) : []).map((candidate, index) => ({
				end: candidate.end,
				id: `highlight-${index}`,
				kind: "highlight" as const,
				label: `Highlight ${index + 1}: ${candidate.title}`,
				start: candidate.start,
			}))
		);
	});
	useEffect(() => {
		publishGuides();
	}, [candidates, current]);
	const clearGuides = useEffectEvent(() => onGuides([]));
	useEffect(() => () => clearGuides(), []);
	useEffect(() => {
		setCandidates(null);
		setCandidatesStamp(null);
	}, [project.id]);

	const find = async () => {
		setWorking(true);
		try {
			const saved = await ensureSaved();
			if (!saved) {
				return;
			}
			const words = parseKeywords(keywords);
			const result = await request(
				candidatesSchema,
				`/projects/${saved.id}/highlights`,
				"POST",
				{
					count,
					...(words.length ? { keywords: words } : {}),
					target: { max: Math.max(minimum, maximum), min: minimum },
				}
			);
			setCandidates(result.candidates);
			setCandidatesStamp(planStamp(saved, result.revision));
		} catch (error) {
			onError(errorText(error));
		} finally {
			setWorking(false);
		}
	};

	const disabled = busy || working;
	return (
		<RyuAppSection title="Highlights">
			<p>
				Rank moments for short clips from transcript sentences, loudness, scene
				cuts, and your keywords. Mark a highlight on the timeline, or make it
				into a short as a separate alternate cut. To get reframed, captioned
				vertical projects for several highlights at once, use Vertical shorts
				below AutoCut in this tab.
			</p>
			<NumberField
				label="Highlights to find"
				max={10}
				min={1}
				onChange={(value) => setCount(Math.round(value))}
				step={1}
				value={count}
			/>
			<NumberField
				label="Shortest highlight (seconds)"
				max={600}
				min={1}
				onChange={setMinimum}
				step={1}
				value={minimum}
			/>
			<NumberField
				label="Longest highlight (seconds)"
				max={600}
				min={1}
				onChange={setMaximum}
				step={1}
				value={maximum}
			/>
			<RyuAppField label="Keywords">
				<Input
					aria-label="Highlight keywords"
					disabled={disabled}
					onChange={(event) => setKeywords(event.target.value)}
					placeholder="launch, demo, price"
					value={keywords}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button disabled={disabled} onClick={() => void find()}>
					{candidates ? "Find again" : "Find highlights"}
				</Button>
			</RyuAppActions>
			{candidates && candidates.length > 0 && !current && (
				<small>
					The timeline changed since these highlights were found. Find them
					again before marking or making a short.
				</small>
			)}
			{candidates?.length === 0 && (
				<small>
					No highlights fit those lengths. Transcribe or analyze the sources, or
					widen the range.
				</small>
			)}
			{candidates && candidates.length > 0 && (
				<ol aria-label="Ranked highlights" className="studio-highlight-list">
					{candidates.map((candidate, index) => {
						const rank = index + 1;
						return (
							<li key={`${candidate.start}-${candidate.end}`}>
								<strong>
									{rank}. {candidate.title}
								</strong>
								<small className="font-mono">
									{tl("{start}–{end} · {seconds}s · score {score}", {
										end: timelineClock(candidate.end),
										score: candidate.score.toFixed(2),
										seconds: (candidate.end - candidate.start).toFixed(1),
										start: timelineClock(candidate.start),
									})}
								</small>
								{candidate.reasons.length > 0 && (
									<span className="studio-highlight-reasons">
										{candidate.reasons.map((reason) => (
											<Badge key={reason} variant="secondary">
												{reason}
											</Badge>
										))}
									</span>
								)}
								<RyuAppActions>
									<Button
										aria-label={tl("Seek to highlight {rank}", {
											rank: String(rank),
										})}
										onClick={() => onSeek(candidate.start)}
										size="sm"
										variant="ghost"
									>
										Seek
									</Button>
									<Button
										aria-label={tl("Mark highlight {rank} on the timeline", {
											rank: String(rank),
										})}
										disabled={disabled || !current}
										onClick={() =>
											candidatesStamp !== null &&
											onMark(candidate, rank, candidatesStamp)
										}
										size="sm"
										variant="outline"
									>
										Mark
									</Button>
									<Button
										aria-label={tl("Make a short from highlight {rank}", {
											rank: String(rank),
										})}
										disabled={disabled || !current}
										onClick={() =>
											candidatesStamp !== null &&
											onMakeShort(candidate, rank, candidatesStamp)
										}
										size="sm"
										variant="outline"
									>
										Make short
									</Button>
								</RyuAppActions>
							</li>
						);
					})}
				</ol>
			)}
		</RyuAppSection>
	);
}
