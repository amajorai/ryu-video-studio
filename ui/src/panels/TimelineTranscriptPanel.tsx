import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	type KeyboardEvent,
	type MouseEvent,
	memo,
	useCallback,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	TimelineRange,
	TimelineTranscript,
} from "../../../shared/filler-words.ts";
import { type Project, projectDuration } from "../../../shared/project.ts";
import {
	findRepeatedPhrases,
	indicesBetween,
	planBatch,
	planRanges,
	searchTokens,
	selectionBatch,
	sentenceSpans,
	spansFromIndices,
	type TokenSpan,
	type TranscriptRemovalPlan,
	type TranscriptToken,
	timelineTokens,
	timelineTranscriptSchema,
	tokenIndexAt,
} from "../../../shared/timeline-transcript.ts";
import { planIsCurrent, planStamp, timelineClock } from "../editing-ui.ts";
import { useEditorProject } from "../editor/context.tsx";
import { removeTimelineRanges } from "../editor/project-actions.ts";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Transcript), under the per-source transcripts.
 */
export const timelineTranscriptPanelTab: PanelTab | null = null;

const ALL_TRACKS = "all";
const STALE_TEXT =
	"The timeline changed since this transcript was loaded. Refresh before deleting words.";
const KIND_LABELS: Record<TranscriptRemovalPlan["kind"], string> = {
	repeat: "Repeat",
	retake: "Retake",
};

interface LoadedTranscript {
	/** Plan stamp of the saved timeline the transcript was read from. */
	stamp: string | null;
	transcript: TimelineTranscript;
}

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** Seconds a set of ranges removes, rounded to milliseconds. */
export const rangesSeconds = (ranges: readonly TimelineRange[]) =>
	Math.round(
		ranges.reduce((total, range) => total + range.end - range.start, 0) * 1000
	) / 1000;

/** Track indices that hold clips, for the track filter. */
export const transcriptTracks = (project: Project) =>
	[...new Set(project.segments.map((segment) => segment.track))].sort(
		(a, b) => a - b
	);

/** Tailwind classes for one word chip from its state. */
export function wordClass(state: {
	active: boolean;
	currentHit: boolean;
	hit: boolean;
	selected: boolean;
	unit: TranscriptToken["unit"];
}): string {
	const classes = [
		"rounded px-0.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	];
	if (state.unit === "cue") {
		classes.push("italic");
	}
	if (state.selected) {
		classes.push("bg-destructive/20 text-destructive line-through");
	} else if (state.active) {
		classes.push("bg-primary text-primary-foreground");
	} else if (state.hit) {
		classes.push("bg-accent text-accent-foreground underline");
	}
	if (state.currentHit) {
		classes.push("ring-2 ring-primary");
	}
	return classes.join(" ");
}

type WordEventKind = "click" | "down" | "enter" | "key";
type WordEvent =
	| KeyboardEvent<HTMLButtonElement>
	| MouseEvent<HTMLButtonElement>;

const WordList = memo(function WordList({
	active,
	currentHit,
	hits,
	onWord,
	selected,
	sentences,
	tokens,
}: {
	active: number;
	currentHit: TokenSpan | undefined;
	hits: ReadonlySet<number>;
	onWord: (kind: WordEventKind, index: number, event: WordEvent) => void;
	selected: ReadonlySet<number>;
	sentences: readonly TokenSpan[];
	tokens: readonly TranscriptToken[];
}) {
	return (
		<div className="flex flex-col gap-2">
			{sentences.map((sentence) => (
				<p className="leading-relaxed" key={sentence.first}>
					<span className="mr-1 text-muted-foreground text-xs tabular-nums">
						{timelineClock(tokens[sentence.first]?.start ?? 0)}
					</span>
					{tokens.slice(sentence.first, sentence.last + 1).map((token) => (
						<span key={token.index}>
							<button
								aria-label={`${token.text.trim()} at ${timelineClock(token.start)}`}
								aria-pressed={selected.has(token.index)}
								className={wordClass({
									active: token.index === active,
									currentHit: Boolean(
										currentHit &&
											token.index >= currentHit.first &&
											token.index <= currentHit.last
									),
									hit: hits.has(token.index),
									selected: selected.has(token.index),
									unit: token.unit,
								})}
								data-token-index={token.index}
								onClick={(event) => onWord("click", token.index, event)}
								onKeyDown={(event) => onWord("key", token.index, event)}
								onPointerDown={(event) => onWord("down", token.index, event)}
								onPointerEnter={(event) => onWord("enter", token.index, event)}
								type="button"
							>
								{token.text.trim()}
							</button>{" "}
						</span>
					))}
				</p>
			))}
		</div>
	);
});

function PlanRow({
	disabled,
	onRemove,
	onSeek,
	plan,
}: {
	disabled: boolean;
	onRemove: () => void;
	onSeek: () => void;
	plan: TranscriptRemovalPlan;
}) {
	return (
		<div className="studio-scene" data-plan-id={plan.id}>
			<div className="flex items-center gap-2">
				<Badge variant="outline">{KIND_LABELS[plan.kind]}</Badge>
				<small className="text-muted-foreground tabular-nums">
					{timelineClock(plan.range.start)}–{timelineClock(plan.range.end)}
				</small>
			</div>
			<p>
				<s>{plan.text}</s>
			</p>
			<small className="text-muted-foreground">Keeps “{plan.keeps}”</small>
			<RyuAppActions>
				<Button onClick={onSeek} size="sm" variant="ghost">
					Go to
				</Button>
				<Button
					disabled={disabled}
					onClick={onRemove}
					size="sm"
					variant="outline"
				>
					Remove
				</Button>
			</RyuAppActions>
		</div>
	);
}

/**
 * The edited timeline's words in timeline order: click to seek, search,
 * select words (Shift-click, Cmd/Ctrl-click, or drag) and delete them with a
 * ripple, plus one-click removal of repeated phrases and retakes.
 */
export function TimelineTranscriptPanel() {
	const runtime = useEditorProject();
	const { busy, dirty, playing, project, time } = runtime;
	const [track, setTrack] = useState<string>(ALL_TRACKS);
	const [loaded, setLoaded] = useState<LoadedTranscript | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [hitCursor, setHitCursor] = useState(0);
	const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
	const [working, setWorking] = useState(false);
	const anchor = useRef<number | null>(null);
	/** Origin of a pointer drag across words. */
	const drag = useRef<number | null>(null);
	/** A drag selected words, so the click that ends it must not seek. */
	const dragged = useRef(false);
	const list = useRef<HTMLDivElement>(null);
	const requestId = useRef(0);

	const tokens = useMemo(
		() => (loaded ? timelineTokens(loaded.transcript) : []),
		[loaded]
	);
	const sentences = useMemo(() => sentenceSpans(tokens), [tokens]);
	const plans = useMemo(() => findRepeatedPhrases(tokens), [tokens]);
	const hits = useMemo(() => searchTokens(tokens, query), [tokens, query]);
	const hitSet = useMemo(
		() =>
			new Set(hits.flatMap((span) => indicesBetween(span.first, span.last))),
		[hits]
	);
	const current = loaded !== null && planIsCurrent(loaded.stamp, project);
	const active = current ? tokenIndexAt(tokens, time) : -1;
	const currentHit = hits.length ? hits[hitCursor % hits.length] : undefined;
	const timelineEnd = projectDuration(project);
	const selectionPlan = useMemo(
		() => selectionBatch(tokens, spansFromIndices(selected), timelineEnd),
		[tokens, selected, timelineEnd]
	);
	const selection = selectionPlan.ranges;
	const disabled = busy || working || !current;

	const load = async (target: Project) => {
		requestId.current += 1;
		const id = requestId.current;
		setLoading(true);
		try {
			const filter = track === ALL_TRACKS ? "" : `?track=${track}`;
			const transcript = timelineTranscriptSchema.parse(
				await runtime.api(`/projects/${target.id}/transcript${filter}`)
			);
			if (id === requestId.current) {
				setLoaded({
					stamp: planStamp(target, transcript.revision),
					transcript,
				});
				setError(null);
			}
		} catch (cause) {
			if (id === requestId.current) {
				setError(
					cause instanceof Error
						? cause.message
						: "The timeline transcript could not be loaded."
				);
			}
		} finally {
			if (id === requestId.current) {
				setLoading(false);
			}
		}
	};
	const refresh = async () => {
		const saved = await runtime.ensureSaved();
		if (saved) {
			await load(saved);
		}
	};
	// Reload whenever a saved revision lands (including after a removal); unsaved
	// edits keep the old words, marked stale, until autosave or Refresh.
	const loadSaved = useEffectEvent(() => {
		if (!dirty) {
			void load(project);
		}
	});
	useEffect(() => {
		loadSaved();
	}, [project.id, project.revision, dirty, track]);
	// Token indices belong to one load.
	useEffect(() => {
		setSelected(new Set());
		anchor.current = null;
	}, [loaded]);

	const reveal = (index: number) => {
		list.current
			?.querySelector(`[data-token-index="${index}"]`)
			?.scrollIntoView?.({ block: "nearest" });
	};
	const followPlayback = useEffectEvent(() => {
		if (playing && active >= 0) {
			reveal(active);
		}
	});
	useEffect(() => {
		followPlayback();
	}, [active]);

	const seek = (seconds: number) => {
		runtime.setTime(Math.max(0, Math.min(timelineEnd, seconds)));
	};
	const remove = async (
		ranges: TimelineRange[],
		description: string,
		remainder = ""
	) => {
		if (!(current && loaded?.stamp)) {
			runtime.setStatus(STALE_TEXT);
			return;
		}
		if (ranges.length === 0) {
			runtime.setStatus(
				"The selected words are too short to remove (under 40 ms)."
			);
			return;
		}
		setWorking(true);
		try {
			const outcome = await removeTimelineRanges(
				runtime,
				ranges,
				description,
				loaded.stamp
			);
			if (outcome.status === "ok") {
				setSelected(new Set());
				if (remainder) {
					runtime.setStatus(remainder);
				}
			} else if (outcome.status === "conflict") {
				await refresh();
			}
		} finally {
			setWorking(false);
		}
	};
	const deleteSelection = () => {
		if (selected.size > 0) {
			void remove(
				selection,
				"transcript",
				selectionPlan.skipped > 0
					? `Removed the first ${plural(selection.length, "range")}; ${selectionPlan.skipped} more selected ranges did not fit in one edit. Select them again to remove them.`
					: ""
			);
		}
	};
	const goToHit = (step: number) => {
		if (hits.length === 0) {
			return;
		}
		const next = (hitCursor + step + hits.length) % hits.length;
		setHitCursor(next);
		const hit = hits[next];
		if (hit) {
			seek(tokens[hit.first]?.start ?? 0);
			reveal(hit.first);
		}
	};

	const handlers = useRef<
		(kind: WordEventKind, index: number, event: WordEvent) => void
	>(() => undefined);
	handlers.current = (kind, index, event) => {
		const token = tokens[index];
		if (!token) {
			return;
		}
		if ("key" in event) {
			if (event.key === "Delete" || event.key === "Backspace") {
				// The editor's global Delete removes clips; here it removes words.
				event.preventDefault();
				event.stopPropagation();
				deleteSelection();
			} else if (event.key === "Escape" && selected.size > 0) {
				event.stopPropagation();
				setSelected(new Set());
			}
			return;
		}
		if (kind === "down") {
			// WebKit does not focus a clicked button, so Delete would otherwise reach
			// the editor's global shortcut and remove the selected clip.
			event.currentTarget.focus({ preventScroll: true });
			const modified = event.shiftKey || event.metaKey || event.ctrlKey;
			drag.current = modified || event.button !== 0 ? null : index;
			dragged.current = false;
			return;
		}
		if (kind === "enter") {
			const origin = drag.current;
			if (origin !== null && (event.buttons & 1) === 1) {
				dragged.current = true;
				anchor.current = origin;
				setSelected(new Set(indicesBetween(origin, index)));
			}
			return;
		}
		// A click (pointer or keyboard activation).
		event.currentTarget.focus({ preventScroll: true });
		drag.current = null;
		if (dragged.current) {
			dragged.current = false;
			return;
		}
		if (event.shiftKey && anchor.current !== null) {
			setSelected(
				(previous) =>
					new Set([
						...previous,
						...indicesBetween(anchor.current ?? index, index),
					])
			);
			return;
		}
		if (event.metaKey || event.ctrlKey) {
			anchor.current = index;
			setSelected((previous) => {
				const next = new Set(previous);
				if (!next.delete(index)) {
					next.add(index);
				}
				return next;
			});
			return;
		}
		anchor.current = index;
		setSelected(new Set());
		seek(token.start);
	};
	const onWord = useCallback(
		(kind: WordEventKind, index: number, event: WordEvent) =>
			handlers.current(kind, index, event),
		[]
	);
	useEffect(() => {
		const release = () => {
			drag.current = null;
		};
		window.addEventListener("pointerup", release);
		return () => window.removeEventListener("pointerup", release);
	}, []);

	const tracks = transcriptTracks(project);
	const allPlans = planBatch(plans, timelineEnd);
	const allPlanRanges = allPlans.ranges;
	const partial = allPlans.covered < plans.length;
	return (
		<RyuAppSection title="Timeline transcript">
			<p>
				Words from the transcribed clips on the timeline, in playback order.
				Click a word to jump to it. Shift-click, Cmd/Ctrl-click, or drag to
				select words, then press Delete to cut them; later clips, captions, and
				timed layers on every track ripple left.
			</p>
			<div className="flex flex-wrap items-end gap-2">
				<RyuAppField label="Tracks">
					<NativeSelect
						aria-label="Transcript tracks"
						onChange={(event) => setTrack(event.target.value)}
						value={track}
					>
						<NativeSelectOption value={ALL_TRACKS}>
							All tracks
						</NativeSelectOption>
						{tracks.map((index) => (
							<NativeSelectOption key={index} value={String(index)}>
								Track {index + 1}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
				<Button
					disabled={busy || loading}
					onClick={() => void refresh()}
					size="sm"
					variant="outline"
				>
					{loading ? "Loading…" : "Refresh"}
				</Button>
			</div>
			{error && <p className="text-destructive">{error}</p>}
			{loaded && !current && (
				<p className="text-muted-foreground" role="status">
					{STALE_TEXT}
				</p>
			)}
			{loaded && tokens.length === 0 && (
				<p className="text-muted-foreground">
					No transcribed words on the timeline yet. Transcribe the source clips
					or import their captions first.
				</p>
			)}
			{tokens.length > 0 && (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<Input
							aria-label="Search the timeline transcript"
							className="min-w-40 flex-1"
							onChange={(event) => {
								setQuery(event.target.value);
								setHitCursor(0);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									goToHit(event.shiftKey ? -1 : 1);
								}
							}}
							placeholder="Search words"
							value={query}
						/>
						<small className="text-muted-foreground tabular-nums">
							{query.trim()
								? `${hits.length ? (hitCursor % hits.length) + 1 : 0} of ${hits.length}`
								: plural(tokens.length, "word")}
						</small>
						<Button
							aria-label="Previous match"
							disabled={hits.length === 0}
							onClick={() => goToHit(-1)}
							size="sm"
							variant="ghost"
						>
							Previous
						</Button>
						<Button
							aria-label="Next match"
							disabled={hits.length === 0}
							onClick={() => goToHit(1)}
							size="sm"
							variant="ghost"
						>
							Next
						</Button>
					</div>
					<div
						className="max-h-80 overflow-y-auto rounded-md border p-2"
						data-testid="timeline-transcript-words"
						ref={list}
					>
						<WordList
							active={active}
							currentHit={query.trim() ? currentHit : undefined}
							hits={hitSet}
							onWord={onWord}
							selected={selected}
							sentences={sentences}
							tokens={tokens}
						/>
					</div>
					<RyuAppActions>
						<Button
							disabled={disabled || selection.length === 0}
							onClick={deleteSelection}
							size="sm"
							variant="destructive"
						>
							{selected.size > 0
								? `Delete ${plural(selected.size, "word")} (${rangesSeconds(selection)}s${selectionPlan.skipped > 0 ? `, first ${selection.length} ranges` : ""})`
								: "Delete selected words"}
						</Button>
						{selected.size > 0 && (
							<Button
								onClick={() => setSelected(new Set())}
								size="sm"
								variant="ghost"
							>
								Clear selection
							</Button>
						)}
					</RyuAppActions>
					<RyuAppSection title="Repeated phrases and retakes">
						{plans.length === 0 ? (
							<p className="text-muted-foreground">
								No repeated phrases or restarted sentences found.
							</p>
						) : (
							<>
								<p>
									Each suggestion removes the earlier take and keeps the later
									one.
								</p>
								<RyuAppActions>
									<Button
										disabled={disabled || allPlanRanges.length === 0}
										onClick={() =>
											void remove(
												allPlanRanges,
												"repeated-phrase",
												partial
													? `Removed ${plural(allPlans.covered, "suggestion")}; ${plans.length - allPlans.covered} more remain. Run Remove again to continue.`
													: ""
											)
										}
										size="sm"
									>
										{partial
											? `Remove first ${allPlans.covered} of ${plural(plans.length, "suggestion")}`
											: `Remove all ${plural(plans.length, "suggestion")}`}{" "}
										({rangesSeconds(allPlanRanges)}s)
									</Button>
								</RyuAppActions>
								{plans.map((plan) => (
									<PlanRow
										disabled={disabled}
										key={plan.id}
										onRemove={() =>
											void remove(
												planRanges([plan], timelineEnd),
												plan.kind === "retake" ? "retake" : "repeated-phrase"
											)
										}
										onSeek={() => {
											seek(plan.range.start);
											reveal(plan.first);
										}}
										plan={plan}
									/>
								))}
							</>
						)}
					</RyuAppSection>
				</>
			)}
		</RyuAppSection>
	);
}
