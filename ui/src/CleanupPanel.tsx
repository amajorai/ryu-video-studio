import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Input, Label } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useEffectEvent, useState } from "react";
import {
	DEFAULT_FILLERS,
	type FillerHit,
	type TimelineRange,
} from "../../shared/filler-words.ts";
import { type Project, projectDuration } from "../../shared/project.ts";
import type { ResolvedVadParams } from "../../shared/vad.ts";
import { request } from "./bridge.ts";
import { liveCountText, useLiveVadCount } from "./CleanupPanel-live-count.ts";
import { ParameterSlider } from "./CleanupPanel-parameter-slider.tsx";
import {
	deadAirPlanSchema,
	errorText,
	fillerPlanSchema,
	hitKey,
	rangeKey,
	rangeSeconds,
	STALE_PLAN_TEXT,
	selectedFillerRanges,
} from "./CleanupPanel-plan.ts";
import { FillerHitsTable, PausesTable } from "./CleanupPanel-tables.tsx";
import { planIsCurrent, planStamp, timelineClock } from "./editing-ui.ts";
import { NumberField } from "./NumberField.tsx";
import type { RouteEditOutcome, TimelineGuide } from "./SplitEditPanel.tsx";
import { setSilenceSettings, useSilenceSettings } from "./silence-vad.ts";

export { liveCountText } from "./CleanupPanel-live-count.ts";
export { rangeSeconds, selectedFillerRanges } from "./CleanupPanel-plan.ts";

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
	const tl = useLiteralMessages();
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
							{tl("Remove {size} · save {seconds}s", {
								seconds: String(rangeSeconds(fillerSelection)),
								size: String(selectedHits.size),
							})}
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
					<FillerHitsTable
						disabled={disabled}
						hits={hits}
						onSeek={onSeek}
						selectedHits={selectedHits}
						setSelectedHits={setSelectedHits}
					/>
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
							{tl("Remove {length} · save {seconds}s", {
								length: String(gapSelection.length),
								seconds: String(rangeSeconds(gapSelection)),
							})}
						</Button>
					)}
				</RyuAppActions>
				{deadAir && !deadAirCurrent && <small>{STALE_PLAN_TEXT}</small>}
				{deadAir?.length === 0 && (
					<small>
						{tl("No pauses longer than {minPause}s between words.", {
							minPause: String(minPause),
						})}
					</small>
				)}
				{deadAir && deadAir.length > 0 && (
					<PausesTable
						deadAir={deadAir}
						disabled={disabled}
						onSeek={onSeek}
						selectedGaps={selectedGaps}
						setSelectedGaps={setSelectedGaps}
					/>
				)}
			</RyuAppSection>
		</RyuAppSection>
	);
}
