import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Switch } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import {
	formatDb,
	MAX_TRACK_GAIN_DB,
	MIN_TRACK_GAIN_DB,
} from "../../../shared/decibels.ts";
import { isTrackAudible, trackSettingFor } from "../../../shared/project.ts";
import { trackHidden } from "../../../shared/sync-lock.ts";
import { trackOrderFor } from "../../../shared/track-edits.ts";
import { isUnityTrackMix, trackMixOf } from "../../../shared/track-mix.ts";
import { MasterMeter } from "../audio/MasterMeter.tsx";
import {
	audioScrubEnabled,
	setAudioScrubEnabled,
} from "../audio-preview/scrub.ts";
import { useEditorProject } from "../editor/context.tsx";
import {
	MixerNumberInput,
	panLabel,
	panToPercent,
	setTrackMix,
} from "../timeline/TrackMixerControls.tsx";
import type { PanelTab } from "./types.ts";

/** The mixer has its own library tab. */
export const mixerPanelTab: PanelTab | null = {
	label: "Mixer",
	value: "mixer",
};

/** Track mixer with gain, pan, the master meter, and the scrubbing toggle. */
export function MixerPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { busy, project } = runtime;
	const [scrubbing, setScrubbing] = useState(audioScrubEnabled);
	const tracks = trackOrderFor(project).toReversed();
	return (
		<RyuAppSection title="Mixer">
			<RyuAppField label="Master output">
				<MasterMeter />
			</RyuAppField>
			{tracks.map((track) => {
				const setting = trackSettingFor(project, track);
				const mix = trackMixOf(setting);
				const audible =
					isTrackAudible(project, track) && !trackHidden(project, track);
				return (
					<RyuAppField
						key={track}
						label={`${setting.name}${audible ? "" : " (silent)"}`}
					>
						<div className="flex flex-wrap items-center gap-2 text-xs">
							<span aria-hidden="true" className="text-muted-foreground">
								Gain dB
							</span>
							<MixerNumberInput
								className="h-7 w-16 px-1 text-xs"
								label={tl("{name} gain (dB)", { name: setting.name })}
								max={MAX_TRACK_GAIN_DB}
								min={MIN_TRACK_GAIN_DB}
								onCommit={(gainDb) => setTrackMix(runtime, track, { gainDb })}
								step={0.5}
								value={mix.gainDb}
							/>
							<span aria-hidden="true" className="text-muted-foreground">
								Pan
							</span>
							<MixerNumberInput
								className="h-7 w-16 px-1 text-xs"
								label={tl("{name} pan (-100 left to 100 right)", {
									name: setting.name,
								})}
								max={100}
								min={-100}
								onCommit={(percent) =>
									setTrackMix(runtime, track, { pan: percent / 100 })
								}
								step={5}
								value={panToPercent(mix.pan)}
							/>
							<span className="text-muted-foreground tabular-nums">
								{formatDb(mix.gainDb)} · {panLabel(mix.pan)}
							</span>
							<Button
								disabled={busy || isUnityTrackMix(mix)}
								onClick={() =>
									setTrackMix(runtime, track, { gainDb: 0, pan: 0 })
								}
								size="sm"
								variant="ghost"
							>
								Reset
							</Button>
						</div>
					</RyuAppField>
				);
			})}
			<RyuAppField label="Play audio while scrubbing">
				<Switch
					aria-label="Play audio while scrubbing"
					checked={scrubbing}
					onCheckedChange={(checked) => {
						setScrubbing(checked);
						setAudioScrubEnabled(checked);
					}}
				/>
				<small>
					Plays short snippets of each clip under the playhead while the preview
					is paused and the playhead moves. Saved for this browser only.
				</small>
			</RyuAppField>
		</RyuAppSection>
	);
}
