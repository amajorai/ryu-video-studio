import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { z } from "zod";
import {
	type AssetBeatsResponse,
	assetBeatsResponseSchema,
	beatsResponseCovers,
	isDetectedBeats,
} from "../../shared/analysis.ts";
import {
	type BeatCutsInput,
	musicClipBeats,
	snapCutsToBeats,
} from "../../shared/beat-cuts.ts";
import {
	type Asset,
	type Project,
	trackSettingFor,
} from "../../shared/project.ts";
import { request } from "./bridge.ts";
import { NumberField } from "./NumberField.tsx";

type Mode = "snap-edits" | "fill-sequence";
const modeSchema = z.enum(["snap-edits", "fill-sequence"]);

/** The grid choices offered in the panel, as beat-cuts `snap`/`every` pairs. */
const GRID_CHOICES = {
	beat: { every: 1, label: "Every beat", snap: "beat" },
	"every-2": { every: 2, label: "Every 2 beats", snap: "every-n" },
	"every-4": { every: 4, label: "Every 4 beats", snap: "every-n" },
	downbeat: { every: 1, label: "Bar starts (downbeats)", snap: "downbeat" },
} as const satisfies Record<
	string,
	Required<Pick<BeatCutsInput, "every" | "snap">> & { label: string }
>;
type GridChoice = keyof typeof GRID_CHOICES;
const gridChoiceSchema = z.enum(["beat", "every-2", "every-4", "downbeat"]);

/** One-line description of the beats a cut used, for the edit history. */
function beatSourceSummary(beats: AssetBeatsResponse): string {
	return isDetectedBeats(beats)
		? `${beats.bpm} BPM`
		: "beats estimated from loudness";
}

/** The beats route path for the span of its source a music clip plays. */
export function musicBeatsPath(segment: {
	assetId: string;
	sourceIn: number;
	sourceOut: number;
}): string {
	const query = new URLSearchParams({
		from: String(segment.sourceIn),
		to: String(segment.sourceOut),
	});
	return `/assets/${segment.assetId}/beats?${query}`;
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : "Cutting to the beat failed.";

export function BeatCutPanel({
	assets,
	busy,
	onEdit,
	onError,
	project,
	selectedIds,
}: {
	assets: readonly Asset[];
	busy: boolean;
	/**
	 * Apply an edit to the latest timeline, not the one captured when the
	 * request started, so edits made while the analysis loads are kept.
	 */
	onEdit: (
		update: (current: Project) => Project,
		describe: () => string
	) => void;
	onError: (text: string) => void;
	project: Project;
	selectedIds: readonly string[];
}) {
	const tl = useLiteralMessages();
	const kindOf = (assetId: string) =>
		assets.find((asset) => asset.id === assetId)?.kind;
	const musicClips = project.segments.filter(
		(segment) => kindOf(segment.assetId) === "audio"
	);
	const visualTracks = [
		...new Set(
			project.segments
				.filter((segment) => {
					const kind = kindOf(segment.assetId);
					return kind === "video" || kind === "image";
				})
				.map((segment) => segment.track)
		),
	].sort((a, b) => a - b);
	const [musicId, setMusicId] = useState("");
	const [trackChoice, setTrackChoice] = useState<number | null>(null);
	const [grid, setGrid] = useState<GridChoice>("beat");
	const [detected, setDetected] = useState<{
		assetId: string;
		beats: AssetBeatsResponse;
	} | null>(null);
	const [mode, setMode] = useState<Mode>("snap-edits");
	const [tolerance, setTolerance] = useState(0.25);
	const [working, setWorking] = useState(false);
	const music =
		musicClips.find((segment) => segment.id === musicId) ?? musicClips[0];
	const track =
		trackChoice !== null && visualTracks.includes(trackChoice)
			? trackChoice
			: visualTracks[0];
	const selectedOnTrack = selectedIds.filter((id) =>
		project.segments.some(
			(segment) => segment.id === id && segment.track === track
		)
	);

	const cut = async () => {
		if (!music || track === undefined) {
			return;
		}
		setWorking(true);
		try {
			const sourceBeats = await request(
				assetBeatsResponseSchema,
				musicBeatsPath(music)
			).catch((error: unknown) => {
				throw new Error(
					`Analyze the music in the Media library before cutting to its beat. ${errorText(error)}`
				);
			});
			setDetected({ assetId: music.assetId, beats: sourceBeats });
			const choice = GRID_CHOICES[grid];
			let beatCount = 0;
			onEdit(
				(current) => {
					const latestMusic = current.segments.find(
						(segment) => segment.id === music.id
					);
					if (!latestMusic) {
						throw new Error("The music clip is no longer on the timeline.");
					}
					const sourceDuration =
						assets.find((asset) => asset.id === latestMusic.assetId)
							?.duration ?? Number.POSITIVE_INFINITY;
					if (
						latestMusic.assetId !== music.assetId ||
						!beatsResponseCovers(
							sourceBeats,
							latestMusic.sourceIn,
							latestMusic.sourceOut,
							sourceDuration
						)
					) {
						throw new Error(
							"The music clip was trimmed while its beats were detected. Cut to beat again."
						);
					}
					const { beats, downbeats } = musicClipBeats(latestMusic, {
						detected: isDetectedBeats(sourceBeats),
						downbeats: isDetectedBeats(sourceBeats)
							? sourceBeats.downbeats
							: undefined,
						times: sourceBeats.times,
					});
					if (beats.length < 2) {
						throw new Error(
							"The music clip has too few detectable beats on the timeline."
						);
					}
					beatCount = beats.length;
					const clipIds = selectedOnTrack.filter((id) =>
						current.segments.some(
							(segment) => segment.id === id && segment.track === track
						)
					);
					return snapCutsToBeats(current, assets, {
						beats,
						clipIds: clipIds.length ? clipIds.slice(0, 64) : undefined,
						downbeats,
						every: choice.every,
						mode,
						snap: choice.snap,
						revision: current.revision,
						tolerance,
						track,
					});
				},
				() =>
					mode === "snap-edits"
						? `Edit points on track ${track + 1} snapped to ${choice.label.toLowerCase()} of ${beatCount} beats (${beatSourceSummary(sourceBeats)}).`
						: `Clips laid out on ${choice.label.toLowerCase()} on track ${track + 1} (${beatSourceSummary(sourceBeats)}).`
			);
		} catch (error) {
			onError(errorText(error));
		} finally {
			setWorking(false);
		}
	};

	const disabled = busy || working;
	const shownBeats =
		detected && detected.assetId === music?.assetId ? detected.beats : null;
	return (
		<RyuAppSection title="Cut to beat">
			<p>
				Use the tempo, beats and bar starts detected in an analyzed music clip
				to snap existing edit points, or to lay clips one per beat or bar.
			</p>
			{musicClips.length === 0 || visualTracks.length === 0 ? (
				<small>
					Add a music clip and video or image clips to the timeline first.
				</small>
			) : (
				<>
					<RyuAppField label="Music clip">
						<NativeSelect
							aria-label="Beat music clip"
							disabled={disabled}
							onChange={(event) => setMusicId(event.target.value)}
							value={music?.id ?? ""}
						>
							{musicClips.map((segment) => (
								<NativeSelectOption key={segment.id} value={segment.id}>
									{assets.find((asset) => asset.id === segment.assetId)?.name ??
										"Audio"}{" "}
									· {segment.start.toFixed(2)}s
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Track to cut">
						<NativeSelect
							aria-label="Beat cut track"
							disabled={disabled}
							onChange={(event) => setTrackChoice(Number(event.target.value))}
							value={track}
						>
							{visualTracks.map((value) => (
								<NativeSelectOption
									disabled={trackSettingFor(project, value).locked}
									key={value}
									value={value}
								>
									{trackSettingFor(project, value).name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Beat cut mode">
						<NativeSelect
							aria-label="Beat cut mode"
							disabled={disabled}
							onChange={(event) =>
								setMode(modeSchema.parse(event.target.value))
							}
							value={mode}
						>
							<NativeSelectOption value="snap-edits">
								Snap existing edits to the nearest beat
							</NativeSelectOption>
							<NativeSelectOption value="fill-sequence">
								Lay clips one per beat
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Cut on">
						<NativeSelect
							aria-label="Cut on"
							disabled={disabled}
							onChange={(event) =>
								setGrid(gridChoiceSchema.parse(event.target.value))
							}
							value={grid}
						>
							{gridChoiceSchema.options.map((value) => (
								<NativeSelectOption key={value} value={value}>
									{GRID_CHOICES[value].label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					{shownBeats && (
						<small aria-live="polite">
							{isDetectedBeats(shownBeats)
								? tl(
										"Detected {bpm} BPM: {beatCount} beats, {barCount} bar starts.",
										{
											barCount: String(shownBeats.downbeats.length),
											beatCount: String(shownBeats.beats.length),
											bpm: String(shownBeats.bpm),
										}
									)
								: tl(
										grid === "downbeat"
											? "No steady tempo detected; using {beatCount} beats estimated from loudness and every fourth one as a bar start."
											: "No steady tempo detected; using {beatCount} beats estimated from loudness.",
										{ beatCount: String(shownBeats.times.length) }
									)}
						</small>
					)}
					{mode === "snap-edits" && (
						<NumberField
							label="Snap tolerance (seconds)"
							max={2}
							min={0}
							onChange={setTolerance}
							step={0.05}
							value={tolerance}
						/>
					)}
					<small>
						{selectedOnTrack.length
							? tl(
									"Uses the {count, plural, one {{countText} selected clip} other {{countText} selected clips}} on this track.",
									{
										count: selectedOnTrack.length,
										countText: String(selectedOnTrack.length),
									}
								)
							: "Uses every clip on this track. Shift-click clips to choose some."}
					</small>
					<RyuAppActions>
						<Button
							disabled={disabled || track === undefined || !music}
							onClick={() => void cut()}
						>
							Cut to beat
						</Button>
					</RyuAppActions>
				</>
			)}
		</RyuAppSection>
	);
}
