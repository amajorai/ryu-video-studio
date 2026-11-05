import {
	animatedValue,
	animationExpression,
	isAnimated,
} from "../../../shared/animation.ts";
import { type Segment, segmentDuration } from "../../../shared/project.ts";

/** Most `sendcmd` steps one clip's temperature curve may emit. */
const MAX_TEMPERATURE_STEPS = 2000;

const decimal = (value: number) => Number(value.toFixed(6));

/**
 * `eq` for brightness, contrast and saturation (with exposure folded into
 * brightness and vibrance into saturation). Keyframed values become
 * per-frame expressions over `t` (clip-relative seconds after the source
 * `setpts`) with `eval=frame`; a static clip keeps its historical numbers.
 */
function eqFilter(segment: Segment): string {
	const { exposure, vibrance } = segment.colorGrade;
	const animated =
		isAnimated(segment, "brightness") ||
		isAnimated(segment, "contrast") ||
		isAnimated(segment, "saturation") ||
		isAnimated(segment, "exposure");
	if (!animated) {
		const brightness = decimal(segment.brightness + exposure / 3);
		const saturation = decimal(segment.saturation * (1 + vibrance * 0.5));
		return `eq=brightness=${brightness}:contrast=${segment.contrast}:saturation=${saturation}`;
	}
	const channel = (property: "brightness" | "contrast" | "saturation") =>
		animationExpression(segment, property, "t");
	const brightness = isAnimated(segment, "exposure")
		? `(${channel("brightness")})+(${animationExpression(segment, "exposure", "t")})/3`
		: `(${channel("brightness")})+${decimal(exposure / 3)}`;
	const saturation = `(${channel("saturation")})*${decimal(1 + vibrance * 0.5)}`;
	return `eq=brightness='${brightness}':contrast='${channel("contrast")}':saturation='${saturation}':eval=frame`;
}

/**
 * Short, stable per-clip filter instance name for `sendcmd` targets: an
 * FNV-1a hash of the clip id keeps every command short.
 */
function balanceName(segment: Segment): string {
	let hash = 0x81_1c_9d_c5;
	for (const character of segment.id) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01_00_01_93);
	}
	return `colorbalance@kt${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Most characters one clip's temperature `sendcmd` script may take. */
export const TEMPERATURE_COMMAND_BUDGET = 24_576;

/**
 * Sample times floored to the millisecond (so a command never fires a frame
 * late), balance values to 1/10000.
 */
const commandTime = (value: number) =>
	Number((Math.floor(value * 1000 + 1e-6) / 1000).toFixed(3));
const commandValue = (value: number) => Number(value.toFixed(4)) || 0;

function temperatureCommands(
	segment: Segment,
	name: string,
	step: number
): string {
	const duration = segmentDuration(segment);
	const commands: string[] = [];
	let previous: number | undefined;
	for (let index = 0; index * step <= duration + 1e-9; index++) {
		const time = commandTime(index * step);
		const value = commandValue(animatedValue(segment, "temperature", time));
		if (value !== previous) {
			commands.push(
				`${time} ${name} rs ${value},${name} bs ${commandValue(-value)}`
			);
			previous = value;
		}
	}
	return commands.join(";");
}

/**
 * Seconds between temperature samples: two output frames, coarsened (in
 * steps of 25%) only when a long, ever-changing curve would exceed
 * `TEMPERATURE_COMMAND_BUDGET`, so the filtergraph stays well inside the
 * single-argument limit.
 */
export function temperatureStep(segment: Segment, fps: number): number {
	const name = balanceName(segment);
	let step = Math.max(
		2 / fps,
		segmentDuration(segment) / MAX_TEMPERATURE_STEPS
	);
	while (
		temperatureCommands(segment, name, step).length > TEMPERATURE_COMMAND_BUDGET
	) {
		step *= 1.25;
	}
	return step;
}

/**
 * Keyframed temperature: `colorbalance` options cannot take expressions, so
 * the curve is sampled every two output frames (see `temperatureStep`) and
 * sent as `rs`/`bs` commands whenever the sampled value changes. Tint stays
 * static.
 */
function temperatureFilters(segment: Segment, fps: number): string[] {
	const tint = segment.colorGrade.tint;
	const name = balanceName(segment);
	const commands = temperatureCommands(
		segment,
		name,
		temperatureStep(segment, fps)
	);
	const initial = decimal(animatedValue(segment, "temperature", 0));
	return [
		`sendcmd=c='${commands}'`,
		`${name}=rs=${initial}:gs=${tint}:bs=${decimal(-initial)}`,
	];
}

/**
 * Brightness, contrast, saturation and the basic grade (exposure, vibrance,
 * temperature and tint) as `eq` plus an optional `colorbalance`. `fps` sets
 * the sampling rate of keyframed temperature.
 */
export function basicColorFilters(segment: Segment, fps = 30): string[] {
	const filters = [eqFilter(segment)];
	if (isAnimated(segment, "temperature")) {
		filters.push(...temperatureFilters(segment, fps));
		return filters;
	}
	const { temperature, tint } = segment.colorGrade;
	if (temperature || tint) {
		filters.push(
			`colorbalance=rs=${temperature}:gs=${tint}:bs=${-temperature}`
		);
	}
	return filters;
}
