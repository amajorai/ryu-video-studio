import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef, useState } from "react";
import {
	displayDb,
	formatDb,
	gainToDb,
	meterBallistics,
	meterFraction,
	SILENCE_DB,
} from "../../../shared/decibels.ts";
import { previewMasterMeter } from "../audio-preview/graph.ts";

/** Meter refresh rate. */
const METER_FPS = 30;
const CHANNEL_NAMES = ["Left", "Right"] as const;
/** Lowest level drawn on the bar scale. */
const METER_FLOOR_DB = -60;

export interface MasterMeterLevels {
	clipped: boolean[];
	peakDb: number[];
	rmsDb: number[];
}

const silentLevels = (): MasterMeterLevels => ({
	clipped: CHANNEL_NAMES.map(() => false),
	peakDb: CHANNEL_NAMES.map(() => SILENCE_DB),
	rmsDb: CHANNEL_NAMES.map(() => SILENCE_DB),
});

/**
 * Fold a raw meter reading into the displayed levels: instant attack, a
 * steady release, and the meter's latched clip flags.
 */
export function nextMeterLevels(
	previous: MasterMeterLevels,
	reading: {
		clipped: readonly boolean[];
		peak: readonly number[];
		rms: readonly number[];
	},
	elapsedSeconds: number
): MasterMeterLevels {
	return {
		clipped: CHANNEL_NAMES.map((_, channel) =>
			Boolean(reading.clipped[channel])
		),
		peakDb: CHANNEL_NAMES.map((_, channel) =>
			meterBallistics(
				previous.peakDb[channel] ?? SILENCE_DB,
				gainToDb(reading.peak[channel] ?? 0),
				elapsedSeconds
			)
		),
		rmsDb: CHANNEL_NAMES.map((_, channel) =>
			meterBallistics(
				previous.rmsDb[channel] ?? SILENCE_DB,
				gainToDb(reading.rms[channel] ?? 0),
				elapsedSeconds
			)
		),
	};
}

/**
 * Master peak/RMS meter for the preview output. The bar shows RMS with a
 * peak tick; the clip light latches above -0.1 dBFS and resets on click.
 */
export function MasterMeter() {
	const tl = useLiteralMessages();
	const [levels, setLevels] = useState(silentLevels);
	const last = useRef<number | null>(null);
	useEffect(() => {
		let frame = 0;
		const tick = (now: number) => {
			frame = requestAnimationFrame(tick);
			const previous = last.current;
			if (previous !== null && now - previous < 1000 / METER_FPS) {
				return;
			}
			last.current = now;
			const reading = previewMasterMeter()?.read();
			if (!reading) {
				return;
			}
			const elapsed = previous === null ? 0 : (now - previous) / 1000;
			setLevels((current) => nextMeterLevels(current, reading, elapsed));
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, []);
	const clipped = levels.clipped.some(Boolean);
	return (
		<div className="flex flex-col gap-1">
			{CHANNEL_NAMES.map((name, channel) => {
				const peakDb = displayDb(levels.peakDb[channel] ?? SILENCE_DB);
				const rmsDb = displayDb(levels.rmsDb[channel] ?? SILENCE_DB);
				return (
					<div className="flex items-center gap-2 text-xs" key={name}>
						<span aria-hidden="true" className="w-3 text-muted-foreground">
							{name[0]}
						</span>
						<div
							aria-label={tl("{channelName} channel level", {
								channelName: name,
							})}
							aria-valuemax={0}
							aria-valuemin={METER_FLOOR_DB}
							aria-valuenow={Math.round(Math.max(METER_FLOOR_DB, rmsDb))}
							aria-valuetext={tl("RMS {rmsLevel}, peak {peakLevel}", {
								peakLevel: formatDb(peakDb),
								rmsLevel: formatDb(rmsDb),
							})}
							className="relative h-2 flex-1 overflow-hidden rounded-sm bg-muted"
							role="meter"
						>
							<div
								className="absolute inset-y-0 left-0 bg-primary"
								style={{
									width: `${meterFraction(rmsDb, METER_FLOOR_DB) * 100}%`,
								}}
							/>
							<div
								className="absolute inset-y-0 w-0.5 bg-foreground"
								style={{
									left: `calc(${meterFraction(peakDb, METER_FLOOR_DB) * 100}% - 2px)`,
								}}
							/>
						</div>
						<span className="w-16 text-right tabular-nums">
							{formatDb(peakDb)}
						</span>
					</div>
				);
			})}
			<button
				aria-label={
					clipped ? "Clipping detected. Reset clip indicator" : "No clipping"
				}
				className={`self-start rounded-sm px-2 py-0.5 text-xs ${
					clipped
						? "bg-destructive text-destructive-foreground"
						: "bg-muted text-muted-foreground"
				}`}
				data-slot="meter-clip-light"
				onClick={() => {
					previewMasterMeter()?.resetClip();
					setLevels((current) => ({
						...current,
						clipped: current.clipped.map(() => false),
					}));
				}}
				type="button"
			>
				{clipped ? "Clip · reset" : "No clip"}
			</button>
		</div>
	);
}
