import {
	Link01Icon,
	MoreHorizontalIcon,
	Unlink01Icon,
	ViewIcon,
	ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Input,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { TrackSetting } from "../../../shared/project.ts";
import {
	syncLockedOf,
	trackHiddenOf,
} from "../../../shared/schema/defaults.ts";
import {
	addTrackAt,
	moveTrack,
	removeTrackAt,
	renameTrack,
	setTrackHeight,
	setTrackSetting,
	toggleTrackHidden,
	toggleTrackSyncLock,
} from "../editor/actions/tracks.ts";
import { useEditor } from "../editor/context.tsx";
import { TrackMixerControls } from "./TrackMixerControls.tsx";
import "./TrackHeader.css";

type TrackHeight = NonNullable<TrackSetting["height"]>;

const TRACK_HEIGHTS: readonly { label: string; value: TrackHeight }[] = [
	{ label: "Small", value: "small" },
	{ label: "Medium", value: "medium" },
	{ label: "Large", value: "large" },
];

/**
 * Lane height in pixels for a track's `height` setting (medium when unset).
 * `TrackHeader.css` applies these to the lane row; medium is the default lane.
 */
export const TRACK_HEIGHT_PX: Readonly<Record<TrackHeight, number>> = {
	large: 88,
	medium: 54,
	small: 34,
};

export function trackHeightPx(setting: Pick<TrackSetting, "height">): number {
	return TRACK_HEIGHT_PX[setting.height ?? "medium"];
}

/**
 * Track name, order, visibility, mute, solo, lock, and sync-lock controls,
 * plus a menu for lane height and adding or removing tracks.
 */
export function TrackHeader({
	isBottom,
	isTop,
	setting,
	track,
}: {
	isBottom: boolean;
	isTop: boolean;
	setting: TrackSetting;
	track: number;
}) {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const hidden = trackHiddenOf(setting);
	const syncLocked = syncLockedOf(setting);
	const height = setting.height ?? "medium";
	const clipCount =
		runtime.project?.segments.filter((segment) => segment.track === track)
			.length ?? 0;
	return (
		<div
			className="studio-track-label"
			data-track-height={height}
			data-track-hidden={hidden ? "true" : undefined}
		>
			<Input
				aria-label={tl("Track {number} name", { number: track + 1 })}
				defaultValue={setting.name}
				key={`${track}:${setting.name}`}
				onBlur={(event) => renameTrack(runtime, track, event.target.value)}
				placeholder={tl("Track {number}", { number: track + 1 })}
			/>
			<div className="studio-track-controls">
				<Button
					aria-label={tl("Move {name} down", { name: setting.name })}
					disabled={isBottom}
					onClick={() => moveTrack(runtime, track, -1)}
					size="sm"
					title="Move track down"
					variant="ghost"
				>
					↓
				</Button>
				<Button
					aria-label={tl("Move {name} up", { name: setting.name })}
					disabled={isTop}
					onClick={() => moveTrack(runtime, track, 1)}
					size="sm"
					title="Move track up"
					variant="ghost"
				>
					↑
				</Button>
				<Button
					aria-label={`${hidden ? "Show" : "Hide"} ${setting.name}`}
					aria-pressed={hidden}
					onClick={() => toggleTrackHidden(runtime, track)}
					size="sm"
					title={hidden ? "Show track" : "Hide track (picture and audio)"}
					variant={hidden ? "default" : "ghost"}
				>
					<HugeiconsIcon
						className="size-3.5"
						icon={hidden ? ViewOffIcon : ViewIcon}
					/>
				</Button>
				<Button
					aria-label={`${setting.muted ? "Unmute" : "Mute"} ${setting.name}`}
					aria-pressed={setting.muted}
					onClick={() =>
						setTrackSetting(runtime, track, { muted: !setting.muted })
					}
					size="sm"
					title={setting.muted ? "Unmute track" : "Mute track"}
					variant={setting.muted ? "default" : "ghost"}
				>
					M
				</Button>
				<Button
					aria-label={`${setting.solo ? "Unsolo" : "Solo"} ${setting.name}`}
					aria-pressed={setting.solo}
					onClick={() =>
						setTrackSetting(runtime, track, { solo: !setting.solo })
					}
					size="sm"
					title={setting.solo ? "Unsolo track" : "Solo track"}
					variant={setting.solo ? "default" : "ghost"}
				>
					S
				</Button>
				<Button
					aria-label={`${setting.locked ? "Unlock" : "Lock"} ${setting.name}`}
					aria-pressed={setting.locked}
					onClick={() =>
						setTrackSetting(runtime, track, { locked: !setting.locked })
					}
					size="sm"
					title={setting.locked ? "Unlock track" : "Lock track"}
					variant={setting.locked ? "default" : "ghost"}
				>
					L
				</Button>
				<Button
					aria-label={
						syncLocked
							? tl("Turn off sync lock for {name}", { name: setting.name })
							: tl("Turn on sync lock for {name}", { name: setting.name })
					}
					aria-pressed={syncLocked}
					onClick={() => toggleTrackSyncLock(runtime, track)}
					size="sm"
					title={
						syncLocked
							? "Sync lock on: ripple edits on other tracks shift this track"
							: "Sync lock off: ripple edits on other tracks leave this track in place"
					}
					variant={syncLocked ? "ghost" : "default"}
				>
					<HugeiconsIcon
						className="size-3.5"
						icon={syncLocked ? Link01Icon : Unlink01Icon}
					/>
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={tl("More actions for {name}", {
									name: setting.name,
								})}
								size="sm"
								title="Track options"
								variant="ghost"
							/>
						}
					>
						<HugeiconsIcon className="size-3.5" icon={MoreHorizontalIcon} />
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						{TRACK_HEIGHTS.map((option) => (
							<DropdownMenuItem
								key={option.value}
								onClick={() => setTrackHeight(runtime, track, option.value)}
								selected={height === option.value}
							>
								{height === option.value
									? tl("{size} height ✓", { size: tl(option.label) })
									: tl("{size} height", { size: tl(option.label) })}
							</DropdownMenuItem>
						))}
						<DropdownMenuItem onClick={() => addTrackAt(runtime, track + 1)}>
							Add track above
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => addTrackAt(runtime, track)}>
							Add track below
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={setting.locked}
							onClick={() => removeTrackAt(runtime, track, clipCount > 0)}
							title={
								setting.locked ? "Unlock the track to remove it" : undefined
							}
							variant="destructive"
						>
							{clipCount > 0
								? tl(
										"Remove track and its {clipCount, plural, one {{clipCount} clip} other {{clipCount} clips}}",
										{ clipCount }
									)
								: "Remove track"}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<TrackMixerControls track={track} />
		</div>
	);
}
