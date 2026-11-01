/** ASS timestamp `H:MM:SS.cc`, rounded to centiseconds. */
export function assTimestamp(seconds: number): string {
	const cs = Math.round(seconds * 100);
	return `${Math.floor(cs / 360_000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/**
 * Dialogue text with ASS override characters neutralized: backslashes and
 * braces become full-width look-alikes and newlines become `\N`.
 */
export function assText(value: string): string {
	return value
		.replace(/\\/g, "＼")
		.replace(/\{/g, "｛")
		.replace(/\}/g, "｝")
		.replace(/\r?\n/g, "\\N");
}

/** `#rrggbb` as the ASS `bbggrr` color order. */
export function assBgr(hex: string): string {
	const rgb = hex.slice(1);
	return rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
}
