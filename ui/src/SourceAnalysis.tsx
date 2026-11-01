import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	type AssetBeatsResponse,
	analysisSchema,
	assetBeatsResponseSchema,
	isDetectedBeats,
	loudnessPeakTimes,
	type MediaAnalysis,
	silenceRanges,
	sourceBeats,
} from "../../shared/analysis.ts";
import type { Asset } from "../../shared/project.ts";
import { request, studioResponseSchema } from "./bridge.ts";

/** Markers a project can hold, matching the sidecar's schema bound. */
const MARKER_LIMIT = 500;

export function SourceAnalysis({
	asset,
	onBarMarkers,
	onBeatMarkers,
	onMarkers,
	onRemoveSilence,
	onRange,
	onError,
}: {
	asset: Asset;
	onRange: (start: number, end: number) => void;
	onMarkers: (times: number[]) => void;
	onBeatMarkers: (times: number[]) => void;
	/**
	 * Mark bar starts. Until the host wires a bar-specific action, bar starts
	 * go through `onBeatMarkers`.
	 */
	onBarMarkers?: (times: number[]) => void;
	onError: (text: string) => void;
	onRemoveSilence: (ranges: readonly [number, number][]) => void;
}) {
	const tl = useLiteralMessages();
	const [expanded, setExpanded] = useState(false);
	const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
	const [working, setWorking] = useState(false);
	const [analysisRun, setAnalysisRun] = useState(0);
	const [requested, setRequested] = useState<{
		analysisCreatedAt: string;
		beats: AssetBeatsResponse;
	} | null>(null);
	const [detecting, setDetecting] = useState(false);
	const startGeneration = useRef(0);
	useEffect(
		() => () => {
			startGeneration.current += 1;
		},
		[asset.id]
	);
	useEffect(() => {
		if (!expanded || working) {
			return;
		}
		let mounted = true;
		let pending = false;
		let finished = false;
		let timer: ReturnType<typeof setInterval> | null = null;
		const poll = () => {
			if (!mounted || pending || finished || !isViewVisible()) {
				return;
			}
			pending = true;
			const generation = startGeneration.current;
			void request(
				z.object({ analysis: z.json() }),
				`/assets/${asset.id}/analysis`
			)
				.then((result) => {
					if (mounted && generation === startGeneration.current) {
						const next = result.analysis
							? analysisSchema.parse(result.analysis)
							: null;
						setAnalysis(next);
						if (
							timer &&
							next &&
							["completed", "failed", "canceled"].includes(next.status)
						) {
							finished = true;
							clearInterval(timer);
							timer = null;
						}
					}
				})
				.catch((error) => {
					if (mounted && generation === startGeneration.current) {
						onError(
							error instanceof Error
								? error.message
								: "Analysis could not be loaded."
						);
					}
				})
				.finally(() => {
					pending = false;
				});
		};
		const unsubscribe = subscribeViewVisibility(poll);
		poll();
		timer = setInterval(poll, 1500);
		return () => {
			mounted = false;
			unsubscribe();
			if (timer) {
				clearInterval(timer);
			}
		};
	}, [expanded, working, analysisRun, asset.id, onError]);
	const start = async () => {
		const generation = ++startGeneration.current;
		setExpanded(true);
		setWorking(true);
		setAnalysisRun((run) => run + 1);
		try {
			const next = analysisSchema.parse(
				await request(
					studioResponseSchema,
					`/assets/${asset.id}/analyze`,
					"POST"
				)
			);
			if (generation === startGeneration.current) {
				setAnalysis(next);
			}
		} catch (error) {
			if (generation === startGeneration.current) {
				onError(error instanceof Error ? error.message : "Analysis failed.");
			}
		} finally {
			if (generation === startGeneration.current) {
				setWorking(false);
			}
		}
	};
	const detectBeats = async () => {
		if (!analysis) {
			return;
		}
		const generation = startGeneration.current;
		const analysisCreatedAt = analysis.createdAt;
		setDetecting(true);
		try {
			const beats = await request(
				assetBeatsResponseSchema,
				`/assets/${asset.id}/beats`
			);
			if (generation === startGeneration.current) {
				setRequested({ analysisCreatedAt, beats });
			}
		} catch (error) {
			if (generation === startGeneration.current) {
				onError(
					error instanceof Error ? error.message : "Beat detection failed."
				);
			}
		} finally {
			setDetecting(false);
		}
	};
	const peak = Math.max(0.001, ...(analysis?.waveform ?? []));
	const boundaries = analysis ? [0, ...analysis.sceneCuts, asset.duration] : [];
	const loudnessMarkers = analysis
		? loudnessPeakTimes(analysis.waveform, asset.duration)
		: [];
	// A detection requested for this analysis run, else the cached one, else
	// the loudness estimate (which the beats route also falls back to).
	const requestedBeats =
		requested && requested.analysisCreatedAt === analysis?.createdAt
			? requested.beats
			: null;
	const beats = analysis ? beatSummary(analysis, requestedBeats) : null;
	const silentRanges = analysis
		? silenceRanges(analysis.waveform, asset.duration)
		: [];
	const silentCountText = String(silentRanges.length);
	return (
		<div className="studio-source-analysis">
			<RyuAppActions>
				<Button
					disabled={working || analysis?.status === "running"}
					onClick={() => void start()}
					size="sm"
					variant="ghost"
				>
					Analyze source
				</Button>
				<Button
					onClick={() => setExpanded(!expanded)}
					size="sm"
					variant="ghost"
				>
					{expanded ? "Hide analysis" : "View analysis"}
				</Button>
			</RyuAppActions>
			{expanded && (
				<>
					{analysis?.status === "running" && (
						<>
							<p>Analyzing scenes and audio…</p>
							<Button
								onClick={() =>
									void request(
										studioResponseSchema,
										`/assets/${asset.id}/cancel-analysis`,
										"POST"
									).catch((error) =>
										onError(
											error instanceof Error ? error.message : "Cancel failed."
										)
									)
								}
								size="sm"
								variant="outline"
							>
								Cancel analysis
							</Button>
						</>
					)}
					{analysis?.error && <p>{analysis.error}</p>}
					{!analysis && <p>No source analysis yet.</p>}
					{analysis?.status === "completed" && (
						<>
							{analysis.waveform.length > 0 && (
								<svg
									aria-label="Audio envelope, normalized"
									height="48"
									preserveAspectRatio="none"
									role="img"
									viewBox={`0 0 ${analysis.waveform.length} 48`}
									width="100%"
								>
									<title>Audio envelope, normalized</title>
									{analysis.waveform.map((level, index) => (
										<rect
											fill="currentColor"
											height={Math.max(1, (level / peak) * 44)}
											key={`${index}:${level}`}
											width="0.8"
											x={index}
											y={24 - Math.max(1, (level / peak) * 44) / 2}
										/>
									))}
								</svg>
							)}
							{asset.kind === "video" && (
								<>
									<p>
										{tl("{count} detected scene changes", {
											count: String(analysis.sceneCuts.length),
										})}
									</p>
									{boundaries.slice(0, -1).map((start, index) => {
										const end = boundaries[index + 1] ?? asset.duration;
										return (
											<Button
												key={start}
												onClick={() => onRange(start, end)}
												size="sm"
												variant="outline"
											>
												{tl("Add {start}–{end}s", {
													end: end.toFixed(1),
													start: start.toFixed(1),
												})}
											</Button>
										);
									})}
								</>
							)}
							{asset.kind === "audio" && <p>Audio analysis ready.</p>}
							{loudnessMarkers.length > 0 && (
								<>
									<small>
										{tl(
											"{count, plural, one {# pronounced loudness peak} other {# pronounced loudness peaks}} measured in this source.",
											{ count: loudnessMarkers.length }
										)}
									</small>
									<Button
										onClick={() => onMarkers(loudnessMarkers)}
										size="sm"
										variant="outline"
									>
										Add loudness markers
									</Button>
								</>
							)}
							{asset.hasAudio && beats && (
								<BeatSummary
									beats={beats}
									detecting={detecting}
									duration={asset.duration}
									onBarMarkers={onBarMarkers ?? onBeatMarkers}
									onBeatMarkers={onBeatMarkers}
									onDetect={() => void detectBeats()}
								/>
							)}
						</>
					)}
				</>
			)}
			{asset.kind === "audio" && silentRanges.length > 0 && (
				<>
					<small>
						{tl(
							"{count, plural, one {{countText} silent source range} other {{countText} silent source ranges}} detected. Remove them from the timeline after reviewing the cut.",
							{ count: silentRanges.length, countText: silentCountText }
						)}
					</small>
					<Button
						onClick={() => onRemoveSilence(silentRanges)}
						size="sm"
						variant="outline"
					>
						Remove detected silence
					</Button>
				</>
			)}
		</div>
	);
}

interface BeatSummaryData {
	/** Source window the detection analyzed, in seconds. */
	analyzed?: { from: number; to: number };
	bpm?: number;
	confidence?: number;
	detected: boolean;
	downbeats: number[];
	times: number[];
}

/** What the analysis panel shows for beats: detection when known, else the estimate. */
export function beatSummary(
	analysis: MediaAnalysis,
	requested: AssetBeatsResponse | null
): BeatSummaryData {
	if (requested && isDetectedBeats(requested)) {
		const from = requested.analyzedFrom ?? 0;
		return {
			analyzed: { from, to: from + requested.analyzedDuration },
			bpm: requested.bpm,
			confidence: requested.confidence,
			detected: true,
			downbeats: requested.downbeats,
			times: requested.beats,
		};
	}
	if (requested) {
		return { detected: false, downbeats: [], times: requested.times };
	}
	const cached = sourceBeats(analysis);
	const from = analysis.beats?.analyzedFrom ?? 0;
	return {
		analyzed: analysis.beats
			? { from, to: from + analysis.beats.analyzedDuration }
			: undefined,
		bpm: cached.bpm,
		confidence: analysis.beats?.confidence,
		detected: cached.detected,
		downbeats: cached.downbeats ?? [],
		times: cached.times,
	};
}

const minutes = (seconds: number) => {
	const whole = Math.max(0, Math.round(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * What the panel says about a beat set and the marker limit: how far into the
 * source detection reached, and, past the limit, where marking would stop.
 */
export function beatMarkerNotes(
	beats: Pick<BeatSummaryData, "analyzed" | "detected" | "downbeats" | "times">,
	duration: number
): string[] {
	const notes: string[] = [];
	const { analyzed } = beats;
	if (
		beats.detected &&
		analyzed &&
		(analyzed.from > 0.5 || analyzed.to < duration - 0.5)
	) {
		notes.push(
			`Detection covers ${minutes(analyzed.from)}–${minutes(analyzed.to)} of this source.`
		);
	}
	if (beats.times.length > MARKER_LIMIT) {
		const last = beats.times[MARKER_LIMIT - 1] ?? 0;
		notes.push(
			`A project holds at most ${MARKER_LIMIT} markers, so beat markers would stop near ${minutes(last)}${beats.downbeats.length ? `; bar markers (${beats.downbeats.length}) cover more of the track` : ""}.`
		);
	}
	return notes;
}

function BeatSummary({
	beats,
	detecting,
	duration,
	onBarMarkers,
	onBeatMarkers,
	onDetect,
}: {
	beats: BeatSummaryData;
	detecting: boolean;
	duration: number;
	onBarMarkers: (times: number[]) => void;
	onBeatMarkers: (times: number[]) => void;
	onDetect: () => void;
}) {
	const tl = useLiteralMessages();
	const count = beats.times.length;
	const bars = beats.downbeats.length;
	const notes = beatMarkerNotes(beats, duration);
	return (
		<>
			<small aria-live="polite">
				{beats.detected && beats.bpm !== undefined
					? tl(
							beats.confidence === undefined
								? "Detected {bpm} BPM: {beatCount, plural, one {{beatCountText} beat} other {{beatCountText} beats}} and {barCount, plural, one {{barCountText} bar start} other {{barCountText} bar starts}}. Verify timing before publishing."
								: "Detected {bpm} BPM: {beatCount, plural, one {{beatCountText} beat} other {{beatCountText} beats}} and {barCount, plural, one {{barCountText} bar start} other {{barCountText} bar starts}}, {confidence}% pulse confidence. Verify timing before publishing.",
							{
								barCount: bars,
								barCountText: String(bars),
								beatCount: count,
								beatCountText: String(count),
								bpm: String(beats.bpm),
								confidence: String(Math.round((beats.confidence ?? 0) * 100)),
							}
						)
					: tl(
							"{count, plural, one {{countText} estimated beat onset} other {{countText} estimated beat onsets}} inferred from this source's loudness envelope. Detect beats for tempo and bar starts.",
							{ count, countText: String(count) }
						)}
			</small>
			{notes.map((note) => (
				<small key={note}>{note}</small>
			))}
			<RyuAppActions>
				{!beats.detected && (
					<Button
						disabled={detecting}
						onClick={onDetect}
						size="sm"
						variant="outline"
					>
						{detecting ? "Detecting beats…" : "Detect beats"}
					</Button>
				)}
				{count > 1 && (
					<Button
						onClick={() => onBeatMarkers(beats.times)}
						size="sm"
						variant="outline"
					>
						{beats.detected
							? tl(
									"Add {count, plural, one {# beat marker} other {# beat markers}}",
									{ count: Math.min(count, MARKER_LIMIT) }
								)
							: "Add estimated beat markers"}
					</Button>
				)}
				{bars > 0 && (
					<Button
						onClick={() => onBarMarkers(beats.downbeats)}
						size="sm"
						variant="outline"
					>
						{tl(
							"Add {count, plural, one {# bar marker} other {# bar markers}}",
							{
								count: Math.min(bars, MARKER_LIMIT),
							}
						)}
					</Button>
				)}
			</RyuAppActions>
		</>
	);
}
