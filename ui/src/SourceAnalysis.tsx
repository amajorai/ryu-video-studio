import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import { useEffect, useRef, useState } from "react";
import {
	analysisSchema,
	estimateBeatTimes,
	loudnessPeakTimes,
	type MediaAnalysis,
	silenceRanges,
} from "../../shared/analysis.ts";
import type { Asset } from "../../shared/project.ts";
import { request } from "./bridge.ts";

export function SourceAnalysis({
	asset,
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
	onError: (text: string) => void;
	onRemoveSilence: (ranges: readonly [number, number][]) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [analysis, setAnalysis] = useState<MediaAnalysis | null>(null);
	const [working, setWorking] = useState(false);
	const [analysisRun, setAnalysisRun] = useState(0);
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
			void request<{ analysis: unknown }>(`/assets/${asset.id}/analysis`)
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
				await request(`/assets/${asset.id}/analyze`, "POST")
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
	const peak = Math.max(0.001, ...(analysis?.waveform ?? []));
	const boundaries = analysis ? [0, ...analysis.sceneCuts, asset.duration] : [];
	const loudnessMarkers = analysis
		? loudnessPeakTimes(analysis.waveform, asset.duration)
		: [];
	const beatMarkers = analysis
		? estimateBeatTimes(analysis.waveform, asset.duration)
		: [];
	const silentRanges = analysis
		? silenceRanges(analysis.waveform, asset.duration)
		: [];
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
									<p>{analysis.sceneCuts.length} detected scene changes</p>
									{boundaries.slice(0, -1).map((start, index) => {
										const end = boundaries[index + 1] ?? asset.duration;
										return (
											<Button
												key={start}
												onClick={() => onRange(start, end)}
												size="sm"
												variant="outline"
											>
												Add {start.toFixed(1)}–{end.toFixed(1)}s
											</Button>
										);
									})}
								</>
							)}
							{asset.kind === "audio" && <p>Audio analysis ready.</p>}
							{loudnessMarkers.length > 0 && (
								<>
									<small>
										{loudnessMarkers.length} pronounced loudness peak
										{loudnessMarkers.length === 1 ? "" : "s"} measured in this
										source.
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
							{beatMarkers.length > 1 && (
								<>
									<small>
										{beatMarkers.length} estimated beat onset
										{beatMarkers.length === 1 ? "" : "s"} inferred from this
										source's loudness envelope. Verify timing before publishing.
									</small>
									<Button
										onClick={() => onBeatMarkers(beatMarkers)}
										size="sm"
										variant="outline"
									>
										Add estimated beat markers
									</Button>
								</>
							)}
						</>
					)}
				</>
			)}
			{asset.kind === "audio" && silentRanges.length > 0 && (
				<>
					<small>
						{silentRanges.length} silent source range
						{silentRanges.length === 1 ? "" : "s"} detected. Remove them from
						the timeline after reviewing the cut.
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
