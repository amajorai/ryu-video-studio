import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Checkbox,
	Input,
	Label,
} from "@ryu/blocks/companion/controls";
import { Slider } from "@ryu/ui/components/slider.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { useContext, useEffect, useEffectEvent, useId, useState } from "react";
import { z } from "zod";
import {
	DEFAULT_FILLERS,
	type FillerHit,
	fillerRanges,
	type TimelineRange,
} from "../../shared/filler-words.ts";
import { type Project, projectDuration } from "../../shared/project.ts";
import type { ResolvedVadParams } from "../../shared/vad.ts";
import { request } from "./bridge.ts";
import { planIsCurrent, planStamp, timelineClock } from "./editing-ui.ts";
import { EditorContext } from "./editor/context.tsx";
import { NumberField } from "./NumberField.tsx";
import type { RouteEditOutcome, TimelineGuide } from "./SplitEditPanel.tsx";
import {
	audibleSourceIds,
	loadSilence,
	type SourceRange,
	setSilenceSettings,
	silencePath,
	type TimelineSilenceSummary,
	timelineSilenceSummary,
	useSilenceSettings,
} from "./silence-vad.ts";

const rangeSchema = z.object({ end: z.number(), start: z.number() });
const fillerPlanSchema = z.object({
	hits: z.array(
		z.object({
			clipId: z.string(),
			end: z.number(),
			kind: z.enum(["filler", "repeat", "stutter"]),
			start: z.number(),
			text: z.string(),
		})
	),
	revision: z.number(),
});
const deadAirPlanSchema = z.object({
	ranges: z.array(rangeSchema),
	removedSeconds: z.number().optional(),
	revision: z.number(),
	vad: z.object({ analyzed: z.number(), skipped: z.number() }).optional(),
});

/** Debounce before slider changes re-query voice activity. */
const LIVE_COUNT_DELAY_MS = 250;

interface LiveVadCount {
	failed: number;
	loading: boolean;
	summary: TimelineSilenceSummary | null;
}

/**
 * Live count of voice-activity pauses on the timeline for the current
 * parameters. Each source is analyzed once by the sidecar; parameter changes
 * only reclassify cached frames.
 */
function useLiveVadCount(
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

/** A labeled slider with its current value, for VAD parameters. */
function ParameterSlider({
	disabled,
	format,
	label,
	max,
	min,
	onChange,
	step,
	value,
}: {
	disabled: boolean;
	format: (value: number) => string;
	label: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	step: number;
	value: number;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<Label htmlFor={id}>{label}</Label>
				<output className="font-mono text-xs" htmlFor={id}>
					{format(value)}
				</output>
			</div>
			<Slider
				aria-label={label}
				disabled={disabled}
				id={id}
				max={max}
				min={min}
				onValueChange={(next) => {
					const number = Array.isArray(next) ? next[0] : next;
					if (typeof number === "number" && Number.isFinite(number)) {
						onChange(number);
					}
				}}
				step={step}
				value={[value]}
			/>
		</div>
	);
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

const hitKey = (hit: Pick<FillerHit, "clipId" | "start">) =>
	`${hit.clipId}:${hit.start}`;
const rangeKey = (range: TimelineRange) => `${range.start}-${range.end}`;
export const rangeSeconds = (ranges: readonly TimelineRange[]) =>
	Number(
		ranges
			.reduce((total, range) => total + (range.end - range.start), 0)
			.toFixed(3)
	);

/** Selected filler hits as merged remove-words ranges, bounded by the timeline. */
export function selectedFillerRanges(
	hits: readonly FillerHit[],
	selected: ReadonlySet<string>,
	timelineEnd: number
): TimelineRange[] {
	return fillerRanges(
		hits.filter((hit) => selected.has(hitKey(hit))),
		{ maxEnd: timelineEnd }
	);
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : "The cleanup plan failed.";
const STALE_PLAN_TEXT =
	"The timeline changed since this plan. Find again before removing anything.";
const kindLabels: Record<FillerHit["kind"], string> = {
	filler: "Filler",
	repeat: "Repeat",
	stutter: "Stutter",
};

export function CleanupPanel({
	busy,
	ensureSaved,
	onError,
	onGuides,
	onRemoveRanges,
	onSeek,
	project,
}: {
	busy: boolean;
	ensureSaved: () => Promise<Project | undefined>;
	onError: (text: string) => void;
	onGuides: (guides: TimelineGuide[]) => void;
	onRemoveRanges: (
		ranges: TimelineRange[],
		description: string,
		planStamp: string
	) => Promise<RouteEditOutcome>;
	onSeek: (time: number) => void;
	project: Project;
}) {
	const [working, setWorking] = useState(false);
	const [fillerWords, setFillerWords] = useState(DEFAULT_FILLERS.join(", "));
	const [hits, setHits] = useState<FillerHit[] | null>(null);
	const [hitsStamp, setHitsStamp] = useState<string | null>(null);
	const [selectedHits, setSelectedHits] = useState<Set<string>>(new Set());
	const silence = useSilenceSettings();
	const { minPause, minSpeech, padding, threshold } = silence.params;
	const setParam = (patch: Partial<ResolvedVadParams>) =>
		setSilenceSettings({ params: patch });
	const liveCount = useLiveVadCount(project, silence.params, silence.vad);
	const [keepPause, setKeepPause] = useState(0.2);
	const [deadAir, setDeadAir] = useState<TimelineRange[] | null>(null);
	const [deadAirStamp, setDeadAirStamp] = useState<string | null>(null);
	const [selectedGaps, setSelectedGaps] = useState<Set<string>>(new Set());
	const timelineEnd = projectDuration(project);
	// Plan ranges are absolute timeline times, valid only while the clips
	// keep the placement they had when the plan was computed.
	const hitsCurrent = planIsCurrent(hitsStamp, project);
	const deadAirCurrent = planIsCurrent(deadAirStamp, project);
	const fillerSelection = hits
		? selectedFillerRanges(hits, selectedHits, timelineEnd)
		: [];
	const gapSelection =
		deadAir?.filter((range) => selectedGaps.has(rangeKey(range))) ?? [];
	const guideRanges = [
		...(hitsCurrent ? fillerSelection : []),
		...(deadAirCurrent ? gapSelection : []),
	];

	const publishGuides = useEffectEvent(() => {
		onGuides(
			guideRanges.map((range, index) => ({
				end: range.end,
				id: `remove-${index}-${rangeKey(range)}`,
				kind: "remove" as const,
				label: `Remove ${timelineClock(range.start)}–${timelineClock(range.end)}`,
				start: range.start,
			}))
		);
	});
	useEffect(() => {
		publishGuides();
	}, [hits, selectedHits, deadAir, selectedGaps, hitsCurrent, deadAirCurrent]);
	const clearGuides = useEffectEvent(() => onGuides([]));
	useEffect(() => () => clearGuides(), []);
	// Another project's plans never apply here.
	useEffect(() => {
		setHits(null);
		setHitsStamp(null);
		setDeadAir(null);
		setDeadAirStamp(null);
	}, [project.id]);

	const planFillers = async () => {
		setWorking(true);
		try {
			const saved = await ensureSaved();
			if (!saved) {
				return;
			}
			const fillers = fillerWords
				.split(",")
				.map((word) => word.trim())
				.filter(Boolean)
				.slice(0, 50);
			const plan = await request(
				fillerPlanSchema,
				`/projects/${saved.id}/filler-plan`,
				"POST",
				fillers.length ? { fillers } : {}
			);
			setHits(plan.hits);
			setHitsStamp(planStamp(saved, plan.revision));
			setSelectedHits(new Set(plan.hits.map(hitKey)));
		} catch (error) {
			onError(errorText(error));
		} finally {
			setWorking(false);
		}
	};
	const planDeadAir = async () => {
		setWorking(true);
		try {
			const saved = await ensureSaved();
			if (!saved) {
				return;
			}
			const plan = await request(
				deadAirPlanSchema,
				`/projects/${saved.id}/dead-air-plan`,
				"POST",
				silence.vad
					? { keepPause, minPause, minSpeech, padding, threshold, vad: true }
					: { keepPause, minPause, padding }
			);
			const ranges = [...plan.ranges].sort((a, b) => a.start - b.start);
			setDeadAir(ranges);
			setDeadAirStamp(planStamp(saved, plan.revision));
			setSelectedGaps(new Set(ranges.map(rangeKey)));
		} catch (error) {
			onError(errorText(error));
		} finally {
			setWorking(false);
		}
	};
	const remove = async (
		ranges: TimelineRange[],
		description: string,
		stamp: string | null,
		replan: () => Promise<void>
	) => {
		if (!ranges.length || stamp === null) {
			return;
		}
		setWorking(true);
		try {
			const outcome = await onRemoveRanges(ranges, description, stamp);
			if (outcome.status === "conflict") {
				setWorking(false);
				await replan();
				return;
			}
			if (outcome.status === "ok") {
				// Removal shifts later times, so both plans are now stale.
				setHits(null);
				setHitsStamp(null);
				setDeadAir(null);
				setDeadAirStamp(null);
			}
		} finally {
			setWorking(false);
		}
	};

	const disabled = busy || working;
	return (
		<RyuAppSection title="Cleanup">
			<p>
				Remove filler words, repeats, and long pauses using the stored
				transcripts of the clips on the timeline. Every range ripples later
				clips, captions, and timed layers.
			</p>
			<RyuAppSection title="Filler words">
				<RyuAppField label="Words to find">
					<Input
						aria-label="Filler words to find"
						disabled={disabled}
						onChange={(event) => setFillerWords(event.target.value)}
						value={fillerWords}
					/>
				</RyuAppField>
				<RyuAppActions>
					<Button disabled={disabled} onClick={() => void planFillers()}>
						Find filler words
					</Button>
					{hits && (
						<Button
							disabled={
								disabled || !hitsCurrent || fillerSelection.length === 0
							}
							onClick={() =>
								void remove(
									fillerSelection,
									"filler word",
									hitsStamp,
									planFillers
								)
							}
							variant="outline"
						>
							{`Remove ${selectedHits.size} · save ${rangeSeconds(fillerSelection)}s`}
						</Button>
					)}
				</RyuAppActions>
				{hits && !hitsCurrent && <small>{STALE_PLAN_TEXT}</small>}
				{hits?.length === 0 && (
					<small>
						No filler words found. Transcribe the timeline's sources first.
					</small>
				)}
				{hits && hits.length > 0 && (
					<Table aria-label="Filler words found">
						<TableHeader>
							<TableRow>
								<TableHead>Remove</TableHead>
								<TableHead>Time</TableHead>
								<TableHead>Word</TableHead>
								<TableHead>Kind</TableHead>
								<TableHead>
									<span className="sr-only">Seek</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{hits.map((hit) => {
								const key = hitKey(hit);
								const label = `“${hit.text}” at ${timelineClock(hit.start)}`;
								return (
									<TableRow key={key}>
										<TableCell>
											<Checkbox
												aria-label={`Remove ${label}`}
												checked={selectedHits.has(key)}
												disabled={disabled}
												onCheckedChange={(checked) =>
													setSelectedHits((current) => {
														const next = new Set(current);
														if (checked) {
															next.add(key);
														} else {
															next.delete(key);
														}
														return next;
													})
												}
											/>
										</TableCell>
										<TableCell className="font-mono">
											{timelineClock(hit.start)}
										</TableCell>
										<TableCell>{hit.text}</TableCell>
										<TableCell>
											<Badge variant="secondary">{kindLabels[hit.kind]}</Badge>
										</TableCell>
										<TableCell>
											<Button
												aria-label={`Seek to ${label}`}
												onClick={() => onSeek(Math.max(0, hit.start - 1))}
												size="sm"
												variant="ghost"
											>
												Seek
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</RyuAppSection>
			<RyuAppSection title="Dead air">
				<ParameterSlider
					disabled={disabled}
					format={(value) => `${value.toFixed(2)}s`}
					label="Shortest pause to remove"
					max={3}
					min={0.1}
					onChange={(value) => setParam({ minPause: value })}
					step={0.05}
					value={minPause}
				/>
				<NumberField
					label="Pause to keep (seconds)"
					max={2}
					min={0}
					onChange={setKeepPause}
					step={0.05}
					value={keepPause}
				/>
				<ParameterSlider
					disabled={disabled}
					format={(value) => `${Math.round(value * 1000)} ms`}
					label="Padding beside speech"
					max={0.5}
					min={0}
					onChange={(value) => setParam({ padding: value })}
					step={0.01}
					value={padding}
				/>
				<div className="flex items-center gap-2">
					<Checkbox
						checked={silence.vad}
						disabled={disabled}
						id="cleanup-vad"
						onCheckedChange={(checked) =>
							setSilenceSettings({ vad: checked === true })
						}
					/>
					<Label htmlFor="cleanup-vad">
						Confirm pauses with voice activity
					</Label>
				</div>
				{silence.vad && (
					<>
						<ParameterSlider
							disabled={disabled}
							format={(value) => `${Math.round(value)} dB`}
							label="Speech threshold above noise floor"
							max={40}
							min={1}
							onChange={(value) => setParam({ threshold: value })}
							step={1}
							value={threshold}
						/>
						<ParameterSlider
							disabled={disabled}
							format={(value) => `${Math.round(value * 1000)} ms`}
							label="Shortest speech"
							max={1}
							min={0}
							onChange={(value) => setParam({ minSpeech: value })}
							step={0.02}
							value={minSpeech}
						/>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={silence.overlay}
								id="cleanup-silence-overlay"
								onCheckedChange={(checked) =>
									setSilenceSettings({ overlay: checked === true })
								}
							/>
							<Label htmlFor="cleanup-silence-overlay">
								Show non-speech on clips
							</Label>
						</div>
						<small aria-live="polite" data-testid="cleanup-vad-count">
							{liveCountText(liveCount)}
						</small>
					</>
				)}
				<RyuAppActions>
					<Button disabled={disabled} onClick={() => void planDeadAir()}>
						Find dead air
					</Button>
					{deadAir && (
						<Button
							disabled={
								disabled || !deadAirCurrent || gapSelection.length === 0
							}
							onClick={() =>
								void remove(gapSelection, "pause", deadAirStamp, planDeadAir)
							}
							variant="outline"
						>
							{`Remove ${gapSelection.length} · save ${rangeSeconds(gapSelection)}s`}
						</Button>
					)}
				</RyuAppActions>
				{deadAir && !deadAirCurrent && <small>{STALE_PLAN_TEXT}</small>}
				{deadAir?.length === 0 && (
					<small>No pauses longer than {minPause}s between words.</small>
				)}
				{deadAir && deadAir.length > 0 && (
					<Table aria-label="Pauses found">
						<TableHeader>
							<TableRow>
								<TableHead>Remove</TableHead>
								<TableHead>From</TableHead>
								<TableHead>Length</TableHead>
								<TableHead>
									<span className="sr-only">Seek</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{deadAir.map((range) => {
								const key = rangeKey(range);
								const label = `pause at ${timelineClock(range.start)}`;
								return (
									<TableRow key={key}>
										<TableCell>
											<Checkbox
												aria-label={`Remove ${label}`}
												checked={selectedGaps.has(key)}
												disabled={disabled}
												onCheckedChange={(checked) =>
													setSelectedGaps((current) => {
														const next = new Set(current);
														if (checked) {
															next.add(key);
														} else {
															next.delete(key);
														}
														return next;
													})
												}
											/>
										</TableCell>
										<TableCell className="font-mono">
											{timelineClock(range.start)}
										</TableCell>
										<TableCell className="font-mono">
											{(range.end - range.start).toFixed(2)}s
										</TableCell>
										<TableCell>
											<Button
												aria-label={`Seek to ${label}`}
												onClick={() => onSeek(Math.max(0, range.start - 1))}
												size="sm"
												variant="ghost"
											>
												Seek
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</RyuAppSection>
		</RyuAppSection>
	);
}
