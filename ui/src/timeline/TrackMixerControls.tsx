import { Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	clampTrackGainDb,
	MAX_TRACK_GAIN_DB,
	MIN_TRACK_GAIN_DB,
} from "../../../shared/decibels.ts";
import { trackSettingFor } from "../../../shared/project.ts";
import { trackMixOf } from "../../../shared/track-mix.ts";
import { setTrackSetting } from "../editor/actions/tracks.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";

/** Balance as shown to people: -100 (left) .. 100 (right). */
export const panToPercent = (pan: number) => Math.round(pan * 100);

/** A typed balance percentage back to the stored -1..1 value. */
export function panFromPercent(percent: number): number {
	if (!Number.isFinite(percent)) {
		return 0;
	}
	return Math.round(Math.min(100, Math.max(-100, percent))) / 100;
}

/** Short balance label: `C`, `L40`, or `R100`. */
export function panLabel(pan: number): string {
	const percent = panToPercent(pan);
	if (percent === 0) {
		return "C";
	}
	return `${percent < 0 ? "L" : "R"}${Math.abs(percent)}`;
}

/**
 * Store a track's gain or pan. Unity values clear the field, so a track
 * returned to 0 dB and centre round-trips like one never mixed.
 */
export function setTrackMix(
	runtime: EditorRuntime,
	track: number,
	patch: { gainDb?: number; pan?: number }
) {
	const project = runtime.project;
	if (!project) {
		return;
	}
	const current = trackMixOf(trackSettingFor(project, track));
	const gainDb =
		patch.gainDb === undefined
			? current.gainDb
			: clampTrackGainDb(patch.gainDb);
	const pan =
		patch.pan === undefined ? current.pan : panFromPercent(patch.pan * 100);
	if (gainDb === current.gainDb && pan === current.pan) {
		return;
	}
	setTrackSetting(runtime, track, {
		gainDb: gainDb === 0 ? undefined : gainDb,
		pan: pan === 0 ? undefined : pan,
	});
}

/** A compact numeric mixer field that commits on blur or Enter. */
export function MixerNumberInput({
	className = "h-7 w-16 px-1 text-xs",
	label,
	max,
	min,
	onCommit,
	step,
	value,
}: {
	className?: string;
	label: string;
	max: number;
	min: number;
	onCommit: (value: number) => void;
	step: number;
	value: number;
}) {
	return (
		<Input
			aria-label={label}
			className={className}
			defaultValue={value}
			key={value}
			max={max}
			min={min}
			onBlur={(event) => {
				const number = Number(event.target.value);
				if (event.target.value.trim() !== "" && Number.isFinite(number)) {
					if (number !== value) {
						onCommit(number);
					}
				} else {
					event.target.value = String(value);
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.currentTarget.blur();
				}
			}}
			step={step}
			title={label}
			type="number"
		/>
	);
}

/** Per-track gain (dB) and balance in the track header, on its own row. */
export function TrackMixerControls({ track }: { track: number }) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const setting = trackSettingFor(runtime.project, track);
	const mix = trackMixOf(setting);
	return (
		<div className="studio-track-mix">
			<span aria-hidden="true">dB</span>
			<MixerNumberInput
				className="h-5 px-1 text-[0.6rem]"
				label={tl("{name} gain (dB)", { name: setting.name })}
				max={MAX_TRACK_GAIN_DB}
				min={MIN_TRACK_GAIN_DB}
				onCommit={(gainDb) => setTrackMix(runtime, track, { gainDb })}
				step={0.5}
				value={mix.gainDb}
			/>
			<span aria-hidden="true">Pan</span>
			<MixerNumberInput
				className="h-5 px-1 text-[0.6rem]"
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
		</div>
	);
}
