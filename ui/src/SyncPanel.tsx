import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Switch } from "@ryu/blocks/companion/controls";
import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useContext, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { Asset, Project } from "../../shared/project.ts";
import {
	MAX_CORRECTABLE_DRIFT,
	type SyncDrift,
	syncRequestSchema,
} from "../../shared/sync.ts";
import { request } from "./bridge.ts";
import { EditorContext } from "./editor/context.tsx";
import { message } from "./editor/format.ts";

const alignmentModeSchema = syncRequestSchema.shape.mode
	.unwrap()
	.extract(["auto", "manual", "timecode"]);

const driftSchema = z.object({
	driftPercent: z.number().optional(),
	endErrorFrames: z.number().optional(),
	reason: z.string().optional(),
	spanSeconds: z.number().optional(),
	speed: z.number().optional(),
	status: z.enum([
		"corrected",
		"negligible",
		"too-large",
		"disabled",
		"too-short",
		"unmeasured",
	]),
});

/** The dry-run sync response the drift readout shows. */
export const driftMeasurementSchema = z.object({
	matches: z.array(
		z.object({
			clipId: z.string(),
			confidence: z.number(),
			drift: driftSchema.optional(),
		})
	),
	warnings: z.array(z.string()).default([]),
});
export type DriftMeasurement = z.infer<typeof driftMeasurementSchema>;

const signedPercent = (value: number) =>
	`${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;

/** One line describing a measured drift and what sync does with it. */
export function driftSummary(
	drift: SyncDrift | undefined,
	tl: LiteralMessage = (source, values) => formatMessage(source, values, "en")
): string {
	if (!drift) {
		return "Drift is measured for audio correlation only.";
	}
	const measured =
		drift.driftPercent === undefined
			? ""
			: `${signedPercent(drift.driftPercent)} over ${drift.spanSeconds?.toFixed(0) ?? "?"} s`;
	switch (drift.status) {
		case "corrected":
			return tl("{measured} · corrected with speed {speed}", {
				measured,
				speed: drift.speed?.toFixed(4) ?? "?",
			});
		case "negligible":
			return tl("{measured} · under half a frame, no correction needed", {
				measured,
			});
		case "too-large":
			return tl(
				"{measured} · beyond ±{maxPercent}%, not corrected ({endErrorFrames} frames apart at the end)",
				{
					endErrorFrames: String(drift.endErrorFrames ?? "?"),
					maxPercent: String(MAX_CORRECTABLE_DRIFT * 100),
					measured,
				}
			);
		case "disabled":
			return tl(
				"{measured} · correction off ({endErrorFrames} frames apart at the end)",
				{ endErrorFrames: String(drift.endErrorFrames ?? "?"), measured }
			);
		default:
			return drift.reason ?? "Drift could not be measured.";
	}
}

type SyncMode = "auto" | "manual" | "timecode";

export function SyncPanel({
	assets,
	busy,
	onSync,
	project,
}: {
	assets: Asset[];
	busy: boolean;
	onSync: (input: {
		driftCorrection?: boolean;
		offsetSeconds?: number;
		mode: SyncMode;
		referenceClipId: string;
		targetClipIds: string[];
	}) => void;
	project: Project;
}) {
	const tl = useLiteralMessages();
	const syncClips = useMemo(
		() =>
			project.segments.filter((segment) => {
				const asset = assets.find(
					(candidate) => candidate.id === segment.assetId
				);
				return asset?.kind !== "image" && Boolean(asset?.hasAudio);
			}),
		[assets, project.segments]
	);
	const timecodeClips = useMemo(
		() =>
			syncClips.filter((clip) => {
				const asset = assets.find((candidate) => candidate.id === clip.assetId);
				return Boolean(asset?.timecodeStart);
			}),
		[assets, syncClips]
	);
	const [referenceClipId, setReferenceClipId] = useState(
		syncClips[0]?.id ?? ""
	);
	const [targetClipIds, setTargetClipIds] = useState<string[]>([]);
	const [mode, setMode] = useState<SyncMode>("auto");
	const [offsetSeconds, setOffsetSeconds] = useState(0);
	const [driftCorrection, setDriftCorrection] = useState(true);
	const [measurement, setMeasurement] = useState<DriftMeasurement | null>(null);
	const [measureError, setMeasureError] = useState("");
	const runtime = useContext(EditorContext);
	const selectionKey = `${referenceClipId}|${targetClipIds.join(",")}|${project.revision}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new selection or revision invalidates the readout.
	useEffect(() => {
		setMeasurement(null);
		setMeasureError("");
	}, [selectionKey]);
	const selectedTimecodeReady =
		timecodeClips.some((clip) => clip.id === referenceClipId) &&
		targetClipIds.length > 0 &&
		targetClipIds.every((id) => timecodeClips.some((clip) => clip.id === id));
	useEffect(() => {
		setReferenceClipId((current) =>
			syncClips.some((clip) => clip.id === current)
				? current
				: (syncClips[0]?.id ?? "")
		);
		setTargetClipIds((current) => {
			const next = current.filter((id) =>
				syncClips.some((clip) => clip.id === id)
			);
			return next.length === current.length &&
				next.every((id, index) => id === current[index])
				? current
				: next;
		});
	}, [project.id, project.revision, syncClips]);
	useEffect(() => {
		if (mode === "timecode" && !selectedTimecodeReady) {
			setMode("auto");
		}
	}, [mode, selectedTimecodeReady]);
	const measureDrift = () => {
		if (!runtime) {
			return;
		}
		setMeasureError("");
		void runtime.act(async () => {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			try {
				setMeasurement(
					await request(
						driftMeasurementSchema,
						`/projects/${saved.id}/sync`,
						"POST",
						{
							driftCorrection,
							dryRun: true,
							mode,
							referenceClipId,
							revision: saved.revision,
							targetClipIds,
						}
					)
				);
			} catch (error) {
				setMeasurement(null);
				setMeasureError(message(error));
			}
		});
	};
	const clipLabel = (clip: Project["segments"][number]) => {
		const asset = assets.find((candidate) => candidate.id === clip.assetId);
		return tl("{media} · Track {track} · {start}s", {
			media: asset?.name ?? tl("Media"),
			start: clip.start.toFixed(2),
			track: clip.track + 1,
		});
	};
	return (
		<RyuAppSection title="Sync clips">
			<p>
				Align camera, recorder, and external microphone clips on the timeline.
				Audio correlation uses completed local source analysis; embedded
				timecode is available when both sources provide it. Use a manual offset
				when the sources do not share enough sound.
			</p>
			{syncClips.length < 2 ? (
				<small>
					Add two audio-bearing video or audio clips to the timeline first.
				</small>
			) : (
				<>
					<RyuAppField label="Reference clip">
						<NativeSelect
							aria-label="Sync reference clip"
							disabled={busy}
							onChange={(event) => {
								const next = event.target.value;
								setReferenceClipId(next);
								setTargetClipIds((current) =>
									current.filter((id) => id !== next)
								);
							}}
							value={referenceClipId}
						>
							{syncClips.map((clip) => (
								<NativeSelectOption key={clip.id} value={clip.id}>
									{clipLabel(clip)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Target clips">
						{syncClips
							.filter((clip) => clip.id !== referenceClipId)
							.map((clip) => {
								const selected = targetClipIds.includes(clip.id);
								return (
									<Button
										aria-pressed={selected}
										disabled={busy}
										key={clip.id}
										onClick={() =>
											setTargetClipIds((current) =>
												selected
													? current.filter((id) => id !== clip.id)
													: [...current, clip.id]
											)
										}
										size="sm"
										variant="outline"
									>
										{clipLabel(clip)}
									</Button>
								);
							})}
					</RyuAppField>
					<RyuAppField label="Alignment method">
						<NativeSelect
							aria-label="Sync alignment method"
							disabled={busy}
							onChange={(event) =>
								setMode(alignmentModeSchema.parse(event.target.value))
							}
							value={mode}
						>
							<NativeSelectOption value="auto">
								Audio correlation
							</NativeSelectOption>
							<NativeSelectOption
								disabled={!selectedTimecodeReady}
								value="timecode"
							>
								Embedded timecode
							</NativeSelectOption>
							<NativeSelectOption value="manual">
								Manual offset
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					{mode === "auto" && (
						<RyuAppField label="Correct clock drift">
							<Switch
								aria-label="Correct clock drift"
								checked={driftCorrection}
								disabled={busy}
								onCheckedChange={setDriftCorrection}
							/>
							<small>
								{tl(
									"Compares the start and end of the shared audio. Drift up to ±{percent}% is corrected by a tiny speed change; larger drift is reported instead.",
									{ percent: String(MAX_CORRECTABLE_DRIFT * 100) }
								)}
							</small>
						</RyuAppField>
					)}
					{mode === "manual" && (
						<RyuAppField label="Shift target clips by seconds">
							<Input
								aria-label="Sync manual offset"
								disabled={busy}
								max={600}
								min={-600}
								onChange={(event) =>
									setOffsetSeconds(Number(event.target.value))
								}
								step={0.01}
								type="number"
								value={offsetSeconds}
							/>
						</RyuAppField>
					)}
					<small>
						{targetClipIds.length
							? tl(
									"{count, plural, one {{clips} target clip} other {{clips} target clips}} selected.",
									{
										clips: String(targetClipIds.length),
										count: targetClipIds.length,
									}
								)
							: "Select one or more target clips."}
					</small>
					{mode === "timecode" && (
						<small>
							Uses embedded source timecode and frame rates from the selected
							media.
						</small>
					)}
					<RyuAppActions>
						<Button
							disabled={busy || !referenceClipId || targetClipIds.length === 0}
							onClick={() => {
								const input: Parameters<typeof onSync>[0] = {
									mode,
									referenceClipId,
									targetClipIds,
								};
								if (mode === "manual") {
									input.offsetSeconds = offsetSeconds;
								}
								if (mode === "auto") {
									input.driftCorrection = driftCorrection;
								}
								onSync(input);
							}}
						>
							Align selected clips
						</Button>
						{mode === "auto" && runtime && (
							<Button
								disabled={
									busy || !referenceClipId || targetClipIds.length === 0
								}
								onClick={measureDrift}
								variant="outline"
							>
								Measure drift
							</Button>
						)}
					</RyuAppActions>
					{measureError && <small role="alert">{measureError}</small>}
					{measurement && (
						<ul aria-label="Measured clock drift">
							{measurement.matches.map((match) => {
								const clip = syncClips.find(
									(candidate) => candidate.id === match.clipId
								);
								return (
									<li key={match.clipId}>
										<small>
											{clip ? clipLabel(clip) : "Clip"}:{" "}
											{driftSummary(match.drift, tl)}
										</small>
									</li>
								);
							})}
						</ul>
					)}
				</>
			)}
		</RyuAppSection>
	);
}
