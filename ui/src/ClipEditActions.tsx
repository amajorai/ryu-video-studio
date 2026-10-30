import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Badge, Button } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useRichLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import { cutForClip, formatSplitOffset, timelineClock } from "./editing-ui.ts";
import { NumberField } from "./NumberField.tsx";

export interface SplitEditSettings {
	/** Crossfade seconds across the audio edit point (0–0.5). */
	crossfade: number;
	/** Unsigned J/L offset in seconds (0–4). */
	offset: number;
}

export const DEFAULT_SPLIT_EDIT_SETTINGS: SplitEditSettings = {
	crossfade: 0.08,
	offset: 0.5,
};

type FreezeMode = "insert" | "hold-end";

/**
 * Inspector actions for one clip: manual J/L split edits at the clip's cut,
 * freeze frame and reverse (detach/recover audio lives in `DetachSection`). Edits are reported to the editor, which
 * owns history, saving and revision checks.
 */
export function ClipEditActions({
	assets,
	busy,
	onFreezeFrame,
	onReverse,
	onSettingsChange,
	onSplitEdit,
	project,
	segment,
	settings,
	time,
}: {
	assets: readonly Asset[];
	busy: boolean;
	onFreezeFrame: (input: { duration: number; mode: FreezeMode }) => void;
	onReverse: () => void;
	onSettingsChange: (settings: SplitEditSettings) => void;
	onSplitEdit: (kind: "j" | "l" | "none") => void;
	project: Project;
	segment: Segment;
	settings: SplitEditSettings;
	time: number;
}) {
	const tlRich = useRichLiteralMessages();
	const [freezeDuration, setFreezeDuration] = useState(2);
	const [freezeMode, setFreezeMode] = useState<FreezeMode>("insert");
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	const cut = cutForClip(project, assets, segment.id, time);
	const end = segment.start + segmentDuration(segment);
	const playheadInClip = time > segment.start + 0.04 && time < end - 0.04;
	const isVideo = asset?.kind === "video";
	const reversible =
		(asset?.kind === "video" || asset?.kind === "audio") &&
		!segment.multicamGroupId;
	const frame = 1 / Math.max(1, project.fps);
	return (
		<>
			{reversible && (
				<RyuAppActions>
					<Button
						disabled={busy}
						onClick={onReverse}
						size="sm"
						title={
							asset?.derivation === "reverse"
								? "Play this clip forwards again."
								: "Play this clip backwards. Linked partners reverse with it."
						}
						variant="outline"
					>
						{asset?.derivation === "reverse" ? "Restore forward" : "Reverse"}
					</Button>
				</RyuAppActions>
			)}
			{cut && (
				<fieldset className="studio-clip-group" disabled={busy}>
					<legend>Split edit</legend>
					<small>
						{tlRich(
							"Cut at {time} · {straight, select, yes {straight cut} other {<badge>{offset}</badge>}}{continuous, select, yes { · same take continues, so a split edit is inaudible.} other {}}",
							{
								continuous: cut.continuousSource ? "yes" : "no",
								offset: formatSplitOffset({
									kind: cut.currentOffset < 0 ? "J" : "L",
									offset: cut.currentOffset,
								}),
								straight: cut.currentOffset === 0 ? "yes" : "no",
								time: timelineClock(cut.time),
							},
							{ badge: (chunks) => <Badge variant="secondary">{chunks}</Badge> }
						)}
					</small>
					<RyuAppActions>
						<Button
							onClick={() => onSplitEdit("j")}
							size="sm"
							title="Incoming audio starts before the picture cut (Alt+J)."
							variant="outline"
						>
							J-cut
						</Button>
						<Button
							onClick={() => onSplitEdit("l")}
							size="sm"
							title="Outgoing audio continues past the picture cut (Alt+L)."
							variant="outline"
						>
							L-cut
						</Button>
						<Button
							disabled={cut.currentOffset === 0}
							onClick={() => onSplitEdit("none")}
							size="sm"
							variant="ghost"
						>
							Straight cut
						</Button>
					</RyuAppActions>
					<NumberField
						label="Split offset (seconds)"
						max={4}
						min={0}
						onChange={(offset) => onSettingsChange({ ...settings, offset })}
						step={frame}
						value={settings.offset}
					/>
					<NumberField
						label="Audio crossfade (seconds)"
						max={0.5}
						min={0}
						onChange={(crossfade) =>
							onSettingsChange({ ...settings, crossfade })
						}
						step={0.01}
						value={settings.crossfade}
					/>
					<small>
						Offsets are limited to the source media available on each side.
					</small>
				</fieldset>
			)}
			{isVideo && (
				<fieldset className="studio-clip-group" disabled={busy}>
					<legend>Freeze frame</legend>
					<NumberField
						label="Freeze duration (seconds)"
						max={30}
						min={0.1}
						onChange={setFreezeDuration}
						value={freezeDuration}
					/>
					<RyuAppField label="Freeze placement">
						<NativeSelect
							aria-label="Freeze placement"
							onChange={(event) =>
								setFreezeMode(
									event.target.value === "hold-end" ? "hold-end" : "insert"
								)
							}
							value={freezeMode}
						>
							<NativeSelectOption value="insert">
								Insert at playhead
							</NativeSelectOption>
							<NativeSelectOption value="hold-end">
								Hold the last frame
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppActions>
						<Button
							disabled={freezeMode === "insert" && !playheadInClip}
							onClick={() =>
								onFreezeFrame({ duration: freezeDuration, mode: freezeMode })
							}
							size="sm"
							title={
								freezeMode === "insert" && !playheadInClip
									? "Move the playhead inside this clip first."
									: "Hold the source frame and ripple later layers."
							}
							variant="outline"
						>
							{freezeMode === "insert"
								? "Freeze frame at playhead"
								: "Freeze last frame"}
						</Button>
					</RyuAppActions>
				</fieldset>
			)}
		</>
	);
}
