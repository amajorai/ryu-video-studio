import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
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
	searchTokens,
	selectionBatch,
	sentenceSpans,
	spansFromIndices,
	timelineTokens,
	timelineTranscriptSchema,
	tokenIndexAt,
} from "../../../shared/timeline-transcript.ts";
import { planIsCurrent, planStamp } from "../editing-ui.ts";
import { useEditorProject } from "../editor/context.tsx";
import { removeTimelineRanges } from "../editor/project-actions.ts";
import {
	plural,
	rangesSeconds,
	transcriptTracks,
} from "./TimelineTranscriptPanel-model.ts";
import { PlansSection } from "./TimelineTranscriptPanel-plans-section.tsx";
import {
	type WordEvent,
	type WordEventKind,
	WordList,
} from "./TimelineTranscriptPanel-word-list.tsx";
import type { PanelTab } from "./types.ts";

export {
	rangesSeconds,
	transcriptTracks,
} from "./TimelineTranscriptPanel-model.ts";
export { wordClass } from "./TimelineTranscriptPanel-word-list.tsx";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Transcript), under the per-source transcripts.
 */
export const timelineTranscriptPanelTab: PanelTab | null = null;

const ALL_TRACKS = "all";
const STALE_TEXT =
	"The timeline changed since this transcript was loaded. Refresh before deleting words.";

interface LoadedTranscript {
	/** Plan stamp of the saved timeline the transcript was read from. */
	stamp: string | null;
	transcript: TimelineTranscript;
}

/**
 * The edited timeline's words in timeline order: click to seek, search,
 * select words (Shift-click, Cmd/Ctrl-click, or drag) and delete them with a
 * ripple, plus one-click removal of repeated phrases and retakes.
 */
export function TimelineTranscriptPanel() {
	const tl = useLiteralMessages();
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
								{tl("Track {track}", { track: index + 1 })}
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
								? tl(
										selectionPlan.skipped > 0
											? "Delete {count, plural, one {{countText} word} other {{countText} words}} ({seconds}s, first {ranges} ranges)"
											: "Delete {count, plural, one {{countText} word} other {{countText} words}} ({seconds}s)",
										{
											count: selected.size,
											countText: String(selected.size),
											ranges: String(selection.length),
											seconds: String(rangesSeconds(selection)),
										}
									)
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
					<PlansSection
						disabled={disabled}
						plans={plans}
						remove={remove}
						reveal={reveal}
						seek={seek}
						timelineEnd={timelineEnd}
					/>
				</>
			)}
		</RyuAppSection>
	);
}
