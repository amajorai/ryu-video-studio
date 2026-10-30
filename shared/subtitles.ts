import { type Caption, captionSchema } from "./project.ts";

/** Most captions one import may produce (the caption list bound). */
export const MAX_IMPORTED_CAPTIONS = 5000;

export type SubtitleFormat = "srt" | "vtt" | "ass";

/** Formats a caption download can be written in. */
export const SUBTITLE_EXPORT_FORMATS = ["srt", "vtt", "txt"] as const;
export type SubtitleExportFormat = (typeof SUBTITLE_EXPORT_FORMATS)[number];

/**
 * Caption text as SRT, WebVTT, or plain text (`txt`: one cue per line in time
 * order, with line breaks inside a cue joined by a space).
 */
export function subtitleText(
	captions: Caption[],
	format: SubtitleExportFormat
): string {
	if (format === "txt") {
		const lines = [...captions]
			.sort((a, b) => a.start - b.start)
			.map((c) => c.text.replace(/\s*\n\s*/g, " ").trim())
			.filter(Boolean);
		return lines.length ? `${lines.join("\n")}\n` : "";
	}
	const stamp = (t: number) => {
		const ms = Math.round(t * 1000);
		return `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
	};
	return (
		(format === "vtt" ? "WEBVTT\n\n" : "") +
		[...captions]
			.sort((a, b) => a.start - b.start)
			.map(
				(c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`
			)
			.join("\n")
	);
}

/** One cue an import left out, with its 1-based source line. */
export interface SkippedCue {
	line: number;
	reason: string;
}

export interface SubtitleImport {
	captions: Caption[];
	skipped: SkippedCue[];
}

class CueError extends Error {}

/** `HH:MM:SS,mmm`, `MM:SS.mmm`, or ASS `H:MM:SS.cc` as seconds; NaN when malformed. */
export function subtitleSeconds(raw: string): number {
	const value = raw.trim().replace(",", ".");
	if (!/^(?:\d+:){1,2}\d+(?:\.\d+)?$/.test(value)) {
		return Number.NaN;
	}
	const parts = value.split(":").map(Number);
	const seconds = parts.at(-1) ?? Number.NaN;
	if (parts.slice(1).some((part) => part >= 60) || seconds >= 60) {
		return Number.NaN;
	}
	return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Detect the format from the text itself (ASS/SSA, WebVTT, otherwise SRT). */
export function detectSubtitleFormat(text: string): SubtitleFormat {
	const head = text.replace(/^﻿/, "").trimStart();
	if (/^\[Script Info\]/i.test(head) || /^\[Events\]/im.test(text)) {
		return "ass";
	}
	return head.startsWith("WEBVTT") ? "vtt" : "srt";
}

function timedCue(start: number, end: number, text: string): Caption {
	if (!(Number.isFinite(start) && Number.isFinite(end))) {
		throw new CueError("Invalid subtitle timestamp.");
	}
	if (end <= start) {
		throw new CueError("Caption end must follow its start.");
	}
	if (!text.trim()) {
		throw new CueError("Caption has no text.");
	}
	const parsed = captionSchema.safeParse({
		id: crypto.randomUUID(),
		start,
		end,
		text: text.slice(0, 2000),
	});
	if (!parsed.success) {
		throw new CueError("Caption timing is outside the supported range.");
	}
	return parsed.data;
}

/** WebVTT inline tags (`<b>`, `<c.yellow>`, `<00:00:01.000>`) and entities. */
function plainVttText(text: string): string {
	return text
		.replace(/<[^>\n]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

const VTT_BLOCKS = /^(?:WEBVTT|NOTE|STYLE|REGION)\b/;

interface CueSink {
	add: (line: number, build: () => Caption) => void;
	skip: (line: number, reason: string) => void;
}

function readSrtVtt(text: string, sink: CueSink, vtt: boolean) {
	const lines = text.replace(/^﻿/, "").replace(/\r/g, "").split("\n");
	let index = 0;
	while (index < lines.length) {
		while (index < lines.length && !lines[index]?.trim()) {
			index += 1;
		}
		if (index >= lines.length) {
			break;
		}
		const first = index;
		const block: string[] = [];
		while (index < lines.length && lines[index]?.trim()) {
			block.push(lines[index] ?? "");
			index += 1;
		}
		const timing = block.findIndex((line) => line.includes("-->"));
		if (timing < 0) {
			if (!VTT_BLOCKS.test(block[0] ?? "")) {
				sink.skip(first + 1, "Missing a `start --> end` timing line.");
			}
			continue;
		}
		const match = block[timing]?.match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/);
		const body = block
			.slice(timing + 1)
			.join("\n")
			.trimEnd();
		sink.add(first + timing + 1, () =>
			timedCue(
				subtitleSeconds(match?.[1] ?? ""),
				subtitleSeconds(match?.[2] ?? ""),
				vtt ? plainVttText(body) : body
			)
		);
	}
}

const DEFAULT_ASS_FORMAT = [
	"layer",
	"start",
	"end",
	"style",
	"name",
	"marginl",
	"marginr",
	"marginv",
	"effect",
	"text",
];

/**
 * Plain text of an ASS/SSA `Text` field: override blocks (`{\b1}`) are
 * dropped, `\N`/`\n` become newlines, and `\h` becomes a space.
 */
export function assPlainText(text: string): string {
	return text
		.replace(/\{[^}]*\}/g, "")
		.replace(/\\[Nn]/g, "\n")
		.replace(/\\h/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

function readAss(text: string, sink: CueSink) {
	const lines = text.replace(/^﻿/, "").replace(/\r/g, "").split("\n");
	let inEvents = false;
	let format = DEFAULT_ASS_FORMAT;
	lines.forEach((raw, position) => {
		const line = raw.trim();
		if (/^\[.*\]$/.test(line)) {
			inEvents = /^\[events\]$/i.test(line);
			return;
		}
		if (!inEvents) {
			return;
		}
		const field = line.match(/^([A-Za-z]+)\s*:\s?(.*)$/);
		const kind = field?.[1]?.toLowerCase();
		const value = field?.[2] ?? "";
		if (kind === "format") {
			format = value.split(",").map((name) => name.trim().toLowerCase());
			return;
		}
		if (kind !== "dialogue") {
			return;
		}
		const textIndex = format.indexOf("text");
		const fields = value.split(",");
		const columns =
			textIndex < 0
				? fields
				: [...fields.slice(0, textIndex), fields.slice(textIndex).join(",")];
		const column = (name: string) => columns[format.indexOf(name)] ?? "";
		if (textIndex < 0 || fields.length < format.length) {
			sink.skip(position + 1, "Dialogue line is missing fields.");
			return;
		}
		const body = column("text");
		if (/\{[^}]*\\p[1-9]/.test(body)) {
			sink.skip(position + 1, "Vector drawings are not captions.");
			return;
		}
		sink.add(position + 1, () =>
			timedCue(
				subtitleSeconds(column("start")),
				subtitleSeconds(column("end")),
				assPlainText(body)
			)
		);
	});
}

function readSubtitles(
	text: string,
	format: SubtitleFormat,
	lenient: boolean
): SubtitleImport {
	const captions: Caption[] = [];
	const skipped: SkippedCue[] = [];
	const sink: CueSink = {
		add: (line, build) => {
			if (captions.length >= MAX_IMPORTED_CAPTIONS) {
				if (!lenient) {
					throw new Error("Import between 1 and 5000 timed captions.");
				}
				sink.skip(line, `More than ${MAX_IMPORTED_CAPTIONS} captions.`);
				return;
			}
			try {
				captions.push(build());
			} catch (error) {
				if (!(lenient && error instanceof CueError)) {
					throw error instanceof CueError ? new Error(error.message) : error;
				}
				skipped.push({ line, reason: error.message });
			}
		},
		skip: (line, reason) => {
			if (lenient) {
				skipped.push({ line, reason });
			}
		},
	};
	if (format === "ass") {
		readAss(text, sink);
	} else {
		readSrtVtt(text, sink, format === "vtt");
	}
	return { captions, skipped };
}

/**
 * Parse SRT, WebVTT, or ASS/SSA text. Strict: the first malformed cue throws.
 * Blocks without a timing line (headers, notes) are ignored.
 */
export function parseSubtitles(
	text: string,
	format: SubtitleFormat = detectSubtitleFormat(text)
): Caption[] {
	const { captions } = readSubtitles(text, format, false);
	if (!captions.length || captions.length > MAX_IMPORTED_CAPTIONS) {
		throw new Error("Import between 1 and 5000 timed captions.");
	}
	return captions;
}

/**
 * Parse SRT, WebVTT, or ASS/SSA text, keeping every valid cue and reporting
 * each skipped cue with its line and reason. Never throws for a bad cue.
 */
export function parseSubtitlesLenient(
	text: string,
	format: SubtitleFormat = detectSubtitleFormat(text)
): SubtitleImport {
	return readSubtitles(text, format, true);
}
