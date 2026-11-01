import { z } from "zod";
import type { ExportCodec, Marker, Project } from "./project.ts";
import type { ExportSettings } from "./schema/export.ts";

/**
 * Platform-ready export presets. A preset fills export settings (container,
 * codec, size and rate control) beneath any explicit overrides, adds review
 * warnings for the target platform, and writes a `metadata.txt` with the
 * title, description and marker chapters next to the export. Presets only
 * prepare files; nothing is published to a third-party service.
 */

export const publishPresetIdSchema = z.enum([
	"youtube-1080p",
	"youtube-4k",
	"youtube-shorts",
	"instagram-reels",
	"tiktok",
	"x",
	"linkedin",
	"podcast-audio",
]);
export type PublishPresetId = z.infer<typeof publishPresetIdSchema>;

export interface PublishPreset {
	/** Whether markers become chapter lines in the metadata file. */
	chapters: boolean;
	/** Video codec the preset encodes with (ignored for audio containers). */
	codec?: ExportCodec;
	id: PublishPresetId;
	label: string;
	/** Exports longer than this get a review warning. */
	maxDurationSeconds?: number;
	settings: Omit<ExportSettings, "platformPreset">;
}

const landscape1080 = { outputWidth: 1920, outputHeight: 1080 } as const;
const vertical1080 = { outputWidth: 1080, outputHeight: 1920 } as const;

export const PUBLISH_PRESETS: readonly PublishPreset[] = [
	{
		id: "youtube-1080p",
		label: "YouTube 1080p",
		chapters: true,
		codec: "h264",
		settings: {
			container: "mp4",
			...landscape1080,
			rateControl: "vbr",
			bitrateKbps: 10_000,
			audioBitrateKbps: 320,
			encoderPreset: "medium",
		},
	},
	{
		id: "youtube-4k",
		label: "YouTube 4K",
		chapters: true,
		codec: "h264",
		settings: {
			container: "mp4",
			outputWidth: 3840,
			outputHeight: 2160,
			rateControl: "vbr",
			bitrateKbps: 45_000,
			audioBitrateKbps: 320,
			encoderPreset: "medium",
		},
	},
	{
		id: "youtube-shorts",
		label: "YouTube Shorts",
		chapters: false,
		codec: "h264",
		maxDurationSeconds: 60,
		settings: {
			container: "mp4",
			...vertical1080,
			rateControl: "vbr",
			bitrateKbps: 10_000,
			audioBitrateKbps: 256,
			encoderPreset: "medium",
		},
	},
	{
		id: "instagram-reels",
		label: "Instagram Reels",
		chapters: false,
		codec: "h264",
		maxDurationSeconds: 60,
		settings: {
			container: "mp4",
			...vertical1080,
			rateControl: "vbr",
			bitrateKbps: 8000,
			audioBitrateKbps: 256,
			encoderPreset: "medium",
		},
	},
	{
		id: "tiktok",
		label: "TikTok",
		chapters: false,
		codec: "h264",
		maxDurationSeconds: 60,
		settings: {
			container: "mp4",
			...vertical1080,
			rateControl: "vbr",
			bitrateKbps: 8000,
			audioBitrateKbps: 256,
			encoderPreset: "medium",
		},
	},
	{
		id: "x",
		label: "X",
		chapters: false,
		codec: "h264",
		settings: {
			container: "mp4",
			...landscape1080,
			rateControl: "vbr",
			bitrateKbps: 8000,
			audioBitrateKbps: 192,
			encoderPreset: "medium",
		},
	},
	{
		id: "linkedin",
		label: "LinkedIn",
		chapters: false,
		codec: "h264",
		settings: {
			container: "mp4",
			...landscape1080,
			rateControl: "vbr",
			bitrateKbps: 8000,
			audioBitrateKbps: 192,
			encoderPreset: "medium",
		},
	},
	{
		id: "podcast-audio",
		label: "Podcast audio",
		chapters: true,
		settings: { container: "mp3" },
	},
];

/** The preset for a stored `platformPreset` value, if it names a known one. */
export function publishPresetFor(
	id: string | undefined
): PublishPreset | undefined {
	return PUBLISH_PRESETS.find((preset) => preset.id === id);
}

/** `m:ss` below an hour, `h:mm:ss` from an hour, as chapter lists use. */
export function chapterTimestamp(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const rest = String(whole % 60).padStart(2, "0");
	return hours
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${String(minutes).padStart(2, "0")}:${rest}`;
}

/**
 * Chapter lines from markers inside the exported range, re-based to the
 * range start and sorted. A first chapter at 00:00 is added when the
 * earliest marker starts later, so the list always opens at the beginning.
 */
export function markerChapters(
	markers: readonly Pick<Marker, "label" | "time">[],
	range: { end: number; start: number }
): string[] {
	const inside = markers
		.filter((marker) => marker.time >= range.start && marker.time < range.end)
		.map((marker) => ({ label: marker.label, time: marker.time - range.start }))
		.sort((a, b) => a.time - b.time || a.label.localeCompare(b.label));
	if (!inside.length) {
		return [];
	}
	const lines = inside.map(
		(chapter) => `${chapterTimestamp(chapter.time)} ${chapter.label}`
	);
	return (inside[0]?.time ?? 0) >= 1
		? [`${chapterTimestamp(0)} Start`, ...lines]
		: lines;
}

const MAX_DESCRIPTION_CHARACTERS = 5000;

/** The `metadata.txt` written next to a preset export. */
export function publishMetadataText(
	project: Pick<Project, "brief" | "markers" | "title">,
	preset: PublishPreset,
	range: { end: number; start: number }
): string {
	const description = project.brief
		.trim()
		.slice(0, MAX_DESCRIPTION_CHARACTERS)
		.trim();
	const lines = [
		`Title: ${project.title}`,
		`Platform: ${preset.label}`,
		`Duration: ${chapterTimestamp(range.end - range.start)}`,
		"",
		"Description:",
		description || "(no description)",
	];
	const chapters = preset.chapters
		? markerChapters(project.markers, range)
		: [];
	if (chapters.length) {
		lines.push("", "Chapters:", ...chapters);
	}
	return `${lines.join("\n")}\n`;
}

/** Review warnings for an export made with `preset`. */
export function publishPresetWarnings(
	preset: PublishPreset,
	facts: {
		canvasHeight: number;
		canvasWidth: number;
		duration: number;
		/** The size actually exported, when a request replaced the preset's. */
		output?: { height: number; width: number };
	}
): string[] {
	const warnings: string[] = [];
	if (
		preset.maxDurationSeconds !== undefined &&
		facts.duration > preset.maxDurationSeconds + 1e-6
	) {
		warnings.push(
			`${preset.label} exports are meant to be at most ${preset.maxDurationSeconds} seconds; this export is ${facts.duration.toFixed(1)} seconds.`
		);
	}
	const outputWidth = facts.output?.width ?? preset.settings.outputWidth;
	const outputHeight = facts.output?.height ?? preset.settings.outputHeight;
	if (
		outputWidth !== undefined &&
		outputHeight !== undefined &&
		Math.abs(
			outputWidth / outputHeight - facts.canvasWidth / facts.canvasHeight
		) > 0.01
	) {
		warnings.push(
			`The ${facts.canvasWidth} × ${facts.canvasHeight} canvas is letterboxed into ${outputWidth} × ${outputHeight}. Reframe the project to fill the frame.`
		);
	}
	return warnings;
}
