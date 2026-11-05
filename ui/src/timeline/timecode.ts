/**
 * SMPTE-style timecode for the go-to field. Fractional rates (23.976,
 * 29.97, 59.94) count frames at the nominal integer rate (24, 30, 60), as
 * non-drop-frame timecode does; a `;` before the frames selects drop-frame
 * counting at 29.97 and 59.94. Pure and deterministic.
 */

/** Nominal (integer) frame rate timecode counts in. */
export const nominalFps = (fps: number) => Math.max(1, Math.round(fps));

/** Frames dropped per minute in drop-frame timecode, or 0 when not applicable. */
export function dropFramesPerMinute(fps: number): number {
	const nominal = nominalFps(fps);
	const fractional = Math.abs(fps - nominal) > 1e-6;
	if (!fractional || nominal % 30 !== 0) {
		return 0;
	}
	return (nominal / 30) * 2;
}

export interface FormatTimecodeOptions {
	/** Use drop-frame counting (`HH:MM:SS;FF`) where the rate supports it. */
	dropFrame?: boolean;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `HH:MM:SS:FF` (or `HH:MM:SS;FF` for drop-frame) for `seconds` at `fps`. */
export function formatTimecode(
	seconds: number,
	fps: number,
	options: FormatTimecodeOptions = {}
): string {
	const nominal = nominalFps(fps);
	let frame = Math.max(
		0,
		Math.round((Number.isFinite(seconds) ? seconds : 0) * fps)
	);
	const drop = options.dropFrame ? dropFramesPerMinute(fps) : 0;
	if (drop) {
		// Re-insert the frame numbers drop-frame skips at each non-tenth minute.
		const perTenMinutes = Math.round(fps * 600);
		const perMinute = nominal * 60 - drop;
		const tens = Math.floor(frame / perTenMinutes);
		const rest = frame % perTenMinutes;
		frame +=
			9 * drop * tens +
			(rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
	}
	const frames = frame % nominal;
	const totalSeconds = Math.floor(frame / nominal);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = totalSeconds % 60;
	return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${drop ? ";" : ":"}${pad(frames)}`;
}

const TIMECODE_PATTERN = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})([:;.])(\d{1,3})$/;
const FRAMES_PATTERN = /^(\d{1,9})\s*f?$/i;
const SECONDS_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)\s*s$/i;
const RELATIVE_PATTERN = /^([+-])\s*(.+)$/;

function parseAbsolute(text: string, fps: number): number | null {
	const frameMatch = FRAMES_PATTERN.exec(text);
	if (frameMatch) {
		return Number(frameMatch[1]) / fps;
	}
	const secondsMatch = SECONDS_PATTERN.exec(text);
	if (secondsMatch) {
		return Number(secondsMatch[1]);
	}
	const match = TIMECODE_PATTERN.exec(text);
	if (!match) {
		return null;
	}
	const [, hoursText, minutesText, secondsText, separator, framesText] = match;
	const hours = Number(hoursText ?? 0);
	const minutes = Number(minutesText);
	const secs = Number(secondsText);
	const frames = Number(framesText);
	const nominal = nominalFps(fps);
	if (minutes > 59 || secs > 59 || frames >= nominal) {
		return null;
	}
	const totalMinutes = hours * 60 + minutes;
	let frameNumber = (totalMinutes * 60 + secs) * nominal + frames;
	if (separator === ";") {
		const drop = dropFramesPerMinute(fps);
		if (!drop) {
			return null;
		}
		// Frames 0..drop-1 do not exist at the start of a non-tenth minute.
		if (secs === 0 && frames < drop && minutes % 10 !== 0) {
			return null;
		}
		frameNumber -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
	}
	return frameNumber / fps;
}

/**
 * Parse go-to input into seconds, or null when it is not valid. Accepts
 * `HH:MM:SS:FF` or `MM:SS:FF` (`;` before the frames for drop-frame), a
 * bare frame count (`120` or `120f`), seconds with an `s` suffix (`4.5s`),
 * and any of those prefixed with `+`/`-` as an offset from `current`.
 * The result is clamped at 0 but not at the timeline end.
 */
export function parseTimecode(
	input: string,
	fps: number,
	current = 0
): number | null {
	if (!(fps > 0)) {
		return null;
	}
	const text = input.trim();
	if (!text) {
		return null;
	}
	const relative = RELATIVE_PATTERN.exec(text);
	if (relative) {
		const [, sign, rest] = relative;
		const offset = parseAbsolute((rest ?? "").trim(), fps);
		if (offset === null) {
			return null;
		}
		return Math.max(0, current + (sign === "-" ? -offset : offset));
	}
	const absolute = parseAbsolute(text, fps);
	return absolute === null ? null : Math.max(0, absolute);
}
