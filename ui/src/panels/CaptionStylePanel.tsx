import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Button,
	Checkbox,
	Input,
	Label,
	Textarea,
} from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useId, useRef, useState } from "react";
import { z } from "zod";
import { chunkingOf } from "../../../shared/caption-chunking.ts";
import {
	applyEmojiSuggestions,
	type EmojiSuggestion,
	emojiPrompt,
	parseEmojiSuggestions,
	subtitleFormatOfFile,
} from "../../../shared/caption-edits.ts";
import {
	activeTrackStyle,
	CAPTION_PRESETS,
	type CaptionPreset,
	effectiveCaptionStyle,
} from "../../../shared/caption-style.ts";
import { profanityWordsSchema } from "../../../shared/profanity.ts";
import {
	activeCaptions,
	type Caption,
	type Project,
} from "../../../shared/project.ts";
import {
	type CaptionChunking,
	type CaptionStyle,
	captionChunkingSchema,
	captionWordAnimationSchema,
} from "../../../shared/schema/caption-style.ts";
import { fontFamilySchema } from "../../../shared/schema/text-style.ts";
import { TITLE_FONTS } from "../../../shared/text-style.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { ImportedFontField } from "../ImportedFontField.tsx";
import { studioFormat } from "../i18n/format.ts";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Captions), under the caption list.
 */
export const captionStylePanelTab: PanelTab | null = null;

const PROFANITY_KEY = "caption-profanity-words";
const MAX_IMPORT_BYTES = 2_000_000;

type Runtime = EditorRuntime & { project: Project };

/** Style target: the active language track when one is selected. */
export const styleTargetTrackId = (project: Project): string | null =>
	project.captionTrackId ?? null;

/** The style currently stored for the target (project or active track). */
export const storedStyle = (project: Project): CaptionStyle | undefined =>
	project.captionTrackId ? activeTrackStyle(project) : project.captionStyle;

/** Status line after an import, from the route's extras. */
export function importSummary(extras: Record<string, unknown>): string {
	const imported = typeof extras.imported === "number" ? extras.imported : 0;
	const skipped = Array.isArray(extras.skipped) ? extras.skipped : [];
	const base = studioFormat(
		"Imported {count, plural, one {# caption} other {# captions}}.",
		{ count: imported }
	);
	if (!skipped.length) {
		return base;
	}
	const first = z
		.object({ line: z.number(), reason: z.string() })
		.safeParse(skipped[0]);
	const skippedText = studioFormat(
		"Skipped {count, plural, one {# malformed cue} other {# malformed cues}}.",
		{ count: skipped.length }
	);
	const detail = first.success
		? ` ${studioFormat("First: line {line}, {reason}", {
				line: first.data.line,
				reason: first.data.reason,
			})}`
		: "";
	return `${base} ${skippedText}${detail}`;
}

/** Comma or newline separated words, validated against the route schema. */
export function parseProfanityList(text: string): string[] {
	const words = [
		...new Set(
			text
				.split(/[\s,]+/)
				.map((word) => word.trim())
				.filter(Boolean)
		),
	];
	const parsed = profanityWordsSchema.safeParse(words);
	return parsed.success ? parsed.data : [];
}

/** Body for `caption-rechunk` (profanity words only when filtering). */
export function rechunkBody(
	chunking: CaptionChunking,
	profanityWords: readonly string[],
	trackId: string | null
): Record<string, unknown> {
	const body: Record<string, unknown> = { chunking, trackId };
	if ((chunking.profanity ?? "none") !== "none" && profanityWords.length) {
		body.profanityWords = [...profanityWords];
	}
	return body;
}

const ANIMATION_LABELS: Record<
	z.infer<typeof captionWordAnimationSchema>,
	string
> = {
	bounce: "Bounce the spoken word",
	box: "Block behind the spoken word",
	highlight: "Highlight the spoken word",
	karaoke: "Karaoke fill",
	none: "None",
	pop: "Pop the spoken word",
	reveal: "Reveal words as spoken",
};

/** The preset's caption box as a CSS color, or transparent without one. */
function presetBoxColor(preset: CaptionPreset): string {
	const { backgroundColor, backgroundOpacity } = preset.style;
	if (!(backgroundColor && backgroundOpacity)) {
		return "transparent";
	}
	return `color-mix(in srgb, ${backgroundColor} ${Math.round(backgroundOpacity * 100)}%, transparent)`;
}

function PresetGallery({
	onApply,
	selected,
	disabled,
}: {
	disabled: boolean;
	onApply: (preset: CaptionPreset) => void;
	selected: string | undefined;
}) {
	return (
		<ul aria-label="Caption presets" className="grid grid-cols-2 gap-2">
			{CAPTION_PRESETS.map((preset) => (
				<li key={preset.id}>
					<button
						aria-pressed={selected === preset.id}
						className="flex flex-col items-start gap-0.5 rounded-md border border-border p-2 text-left text-xs hover:bg-muted aria-pressed:border-primary"
						data-caption-preset={preset.id}
						disabled={disabled}
						onClick={() => onApply(preset)}
						type="button"
					>
						<span
							aria-hidden="true"
							className="w-full truncate rounded bg-neutral-700 px-2 py-2 text-center text-sm"
						>
							<span
								className="rounded-sm px-1"
								style={{
									backgroundColor: presetBoxColor(preset),
									color: preset.style.color,
									fontFamily:
										TITLE_FONTS[preset.style.fontFamily ?? "system-sans"].css,
									fontWeight: preset.style.fontWeight ?? 700,
									textShadow: "0 0 2px rgb(0 0 0 / 0.9)",
								}}
							>
								{preset.style.uppercase
									? preset.label.toUpperCase()
									: preset.label}
							</span>
						</span>
						<span className="font-medium text-foreground">{preset.label}</span>
						<span className="text-muted-foreground">{preset.description}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/** The text a number field shows for `value` (empty when unset). */
export function numberFieldText(value: number | undefined): string {
	return value === undefined ? "" : String(Number(value.toFixed(4)));
}

/**
 * Parse a number field's text: `null` for an empty field, `undefined` for
 * text that is not a number yet, otherwise the value clamped into range.
 */
export function parseNumberField(
	text: string,
	min: number,
	max: number
): number | null | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	const next = Number(trimmed);
	if (!Number.isFinite(next)) {
		return undefined;
	}
	return Math.min(max, Math.max(min, next));
}

/**
 * A number input that keeps the typed text as a local draft, so intermediate
 * input ("", "0", "0.") stays visible. In-range values apply as they are
 * typed; on blur or Enter the draft is clamped into range, or cleared through
 * `onClear` when the field allows an unset value.
 */
function NumberField({
	label,
	max,
	min,
	onChange,
	onClear,
	placeholder,
	step,
	value,
}: {
	label: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	onClear?: () => void;
	placeholder?: string;
	step: number;
	value: number | undefined;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const commit = () => {
		if (draft === null) {
			return;
		}
		setDraft(null);
		const next = parseNumberField(draft, min, max);
		if (next === null) {
			onClear?.();
		} else if (next !== undefined) {
			onChange(next);
		}
	};
	return (
		<RyuAppField label={label}>
			<Input
				aria-label={label}
				max={max}
				min={min}
				onBlur={commit}
				onChange={(event) => {
					const text = event.target.value;
					setDraft(text);
					const next = Number(text);
					if (
						text.trim() &&
						Number.isFinite(next) &&
						next >= min &&
						next <= max
					) {
						onChange(next);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						commit();
					}
				}}
				placeholder={placeholder}
				step={step}
				type="number"
				value={draft ?? numberFieldText(value)}
			/>
		</RyuAppField>
	);
}

function ColorField({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (value: string) => void;
	value: string;
}) {
	return (
		<RyuAppField label={label}>
			<ColorPickerPopover
				onValueChange={onChange}
				triggerAriaLabel={label}
				triggerClassName="w-full justify-start"
				value={value}
			/>
		</RyuAppField>
	);
}

function StyleForm({ runtime }: { runtime: Runtime }) {
	const { project } = runtime;
	const resolved = effectiveCaptionStyle(project);
	const [draft, setDraft] = useState<CaptionStyle>(
		() => storedStyle(project) ?? {}
	);
	const value = { ...resolved, ...draft };
	const change = (patch: CaptionStyle) =>
		setDraft((current) => ({ ...current, ...patch, presetId: undefined }));
	const trackId = styleTargetTrackId(project);
	const uppercaseId = useId();
	return (
		<>
			<RyuAppField label="Font">
				<NativeSelect
					aria-label="Caption font"
					onChange={(event) => {
						const parsed = fontFamilySchema.safeParse(event.target.value);
						if (parsed.success) {
							change({ fontFamily: parsed.data });
						}
					}}
					value={value.fontFamily}
				>
					{fontFamilySchema.options.map((family) => (
						<NativeSelectOption key={family} value={family}>
							{TITLE_FONTS[family].label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<ImportedFontField
				label="Caption"
				onChange={(choice) =>
					change({
						customFont: choice.customFont,
						systemFont: choice.systemFont,
					})
				}
				value={{
					customFont: value.customFont ?? undefined,
					systemFont: value.systemFont ?? undefined,
				}}
			/>
			<NumberField
				label="Size (% of height)"
				max={12}
				min={2}
				onChange={(next) => change({ fontSize: next / 100 })}
				step={0.5}
				value={value.fontSize * 100}
			/>
			<RyuAppField label="Weight">
				<NativeSelect
					aria-label="Caption weight"
					onChange={(event) =>
						change({ fontWeight: Number(event.target.value) })
					}
					value={String(value.fontWeight)}
				>
					{[400, 500, 600, 700, 800, 900].map((weight) => (
						<NativeSelectOption key={weight} value={String(weight)}>
							{weight}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={value.uppercase}
					id={uppercaseId}
					onCheckedChange={(checked) => change({ uppercase: checked === true })}
				/>
				<Label htmlFor={uppercaseId}>Uppercase</Label>
			</div>
			<ColorField
				label="Text color"
				onChange={(color) => change({ color })}
				value={value.color}
			/>
			<ColorField
				label="Highlight color"
				onChange={(highlightColor) => change({ highlightColor })}
				value={value.highlightColor}
			/>
			<ColorField
				label="Outline color"
				onChange={(outlineColor) => change({ outlineColor })}
				value={value.outlineColor}
			/>
			<NumberField
				label="Outline (% of height)"
				max={2}
				min={0}
				onChange={(next) => change({ outlineWidth: next / 100 })}
				step={0.05}
				value={value.outlineWidth * 100}
			/>
			<NumberField
				label="Shadow (% of height)"
				max={2}
				min={0}
				onChange={(next) => change({ shadowDepth: next / 100 })}
				step={0.05}
				value={value.shadowDepth * 100}
			/>
			<ColorField
				label="Box color"
				onChange={(backgroundColor) => change({ backgroundColor })}
				value={value.backgroundColor}
			/>
			<NumberField
				label="Box opacity (%)"
				max={100}
				min={0}
				onChange={(next) => change({ backgroundOpacity: next / 100 })}
				step={5}
				value={value.backgroundOpacity * 100}
			/>
			<NumberField
				label="Horizontal position (%)"
				max={100}
				min={0}
				onChange={(next) => change({ positionX: next / 100 })}
				step={1}
				value={value.positionX * 100}
			/>
			<NumberField
				label="Vertical position (%)"
				max={100}
				min={0}
				onChange={(next) => change({ positionY: next / 100 })}
				step={1}
				value={value.positionY * 100}
			/>
			<NumberField
				label="Max lines"
				max={3}
				min={1}
				onChange={(next) => change({ maxLines: Math.round(next) })}
				step={1}
				value={value.maxLines}
			/>
			<RyuAppField label="Word animation">
				<NativeSelect
					aria-label="Caption word animation"
					onChange={(event) => {
						const parsed = captionWordAnimationSchema.safeParse(
							event.target.value
						);
						if (parsed.success) {
							change({ wordAnimation: parsed.data });
						}
					}}
					value={value.wordAnimation}
				>
					{captionWordAnimationSchema.options.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{ANIMATION_LABELS[option]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={runtime.busy}
					onClick={() =>
						void runtime.routeEdit(
							"caption-style",
							{ mode: "replace", style: draft, trackId },
							() => "Caption style saved."
						)
					}
					size="sm"
				>
					Apply style
				</Button>
				<Button
					disabled={runtime.busy}
					onClick={() => {
						setDraft({});
						void runtime.routeEdit(
							"caption-style",
							{ mode: "replace", style: {}, trackId },
							() => "Captions use the default style again."
						);
					}}
					size="sm"
					variant="ghost"
				>
					Reset to default
				</Button>
			</RyuAppActions>
		</>
	);
}

function ChunkingForm({ runtime }: { runtime: Runtime }) {
	const { project } = runtime;
	const [chunking, setChunking] = useState<CaptionChunking>(
		() => project.captionChunking ?? { mode: "words" }
	);
	const [words, setWords] = useState(() =>
		readViewerValue(PROFANITY_KEY, profanityWordsSchema, []).join(", ")
	);
	const resolved = chunkingOf(chunking);
	const change = (patch: Partial<CaptionChunking>) => {
		const parsed = captionChunkingSchema.safeParse({ ...chunking, ...patch });
		if (parsed.success) {
			setChunking(parsed.data);
		}
	};
	const clear = (key: "maxChars" | "maxWords" | "minDuration") => {
		const { [key]: _removed, ...rest } = chunking;
		setChunking(rest);
	};
	const captions = activeCaptions(project);
	return (
		<>
			<RyuAppField label="Grouping">
				<NativeSelect
					aria-label="Caption grouping"
					onChange={(event) => {
						const mode = captionChunkingSchema.shape.mode.safeParse(
							event.target.value
						);
						if (mode.success) {
							change({ mode: mode.data });
						}
					}}
					value={chunking.mode}
				>
					<NativeSelectOption value="segments">
						Keep sentences
					</NativeSelectOption>
					<NativeSelectOption value="words">Short phrases</NativeSelectOption>
					<NativeSelectOption value="single-word">
						One word at a time
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{chunking.mode !== "single-word" && (
				<>
					<NumberField
						label="Max words"
						max={20}
						min={1}
						onChange={(maxWords) => change({ maxWords: Math.round(maxWords) })}
						onClear={() => clear("maxWords")}
						step={1}
						value={Math.min(resolved.maxWords, 20)}
					/>
					<NumberField
						label="Max characters"
						max={120}
						min={8}
						onChange={(maxChars) => change({ maxChars: Math.round(maxChars) })}
						onClear={() => clear("maxChars")}
						step={1}
						value={Number.isFinite(resolved.maxChars) ? resolved.maxChars : 120}
					/>
				</>
			)}
			<NumberField
				label="Min duration (s)"
				max={5}
				min={0.1}
				onChange={(minDuration) => change({ minDuration })}
				onClear={() => clear("minDuration")}
				placeholder="None"
				step={0.1}
				value={chunking.minDuration}
			/>
			<NumberField
				label="Close gaps under (s)"
				max={2}
				min={0}
				onChange={(closeGaps) => change({ closeGaps })}
				step={0.05}
				value={resolved.closeGaps}
			/>
			<RyuAppField label="Profanity">
				<NativeSelect
					aria-label="Caption profanity"
					onChange={(event) => {
						const profanity = z
							.enum(["none", "mask", "remove"])
							.safeParse(event.target.value);
						if (profanity.success) {
							change({ profanity: profanity.data });
						}
					}}
					value={resolved.profanity}
				>
					<NativeSelectOption value="none">Leave as spoken</NativeSelectOption>
					<NativeSelectOption value="mask">Mask (f***)</NativeSelectOption>
					<NativeSelectOption value="remove">
						Remove the word
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{resolved.profanity !== "none" && (
				<RyuAppField label="Also filter">
					<Textarea
						aria-label="Extra words to filter"
						onBlur={() =>
							writeViewerValue(PROFANITY_KEY, parseProfanityList(words))
						}
						onChange={(event) => setWords(event.target.value)}
						placeholder="Comma-separated words"
						rows={2}
						value={words}
					/>
				</RyuAppField>
			)}
			<RyuAppActions>
				<Button
					disabled={runtime.busy || captions.length === 0}
					onClick={() =>
						void runtime.routeEdit(
							"caption-rechunk",
							rechunkBody(
								chunking,
								parseProfanityList(words),
								styleTargetTrackId(project)
							),
							() => "Captions regrouped."
						)
					}
					size="sm"
				>
					Rechunk captions
				</Button>
			</RyuAppActions>
		</>
	);
}

function EmojiSuggestions({ runtime }: { runtime: Runtime }) {
	const { project } = runtime;
	const [suggestions, setSuggestions] = useState<EmojiSuggestion[]>([]);
	const [accepted, setAccepted] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const captions = activeCaptions(project);
	const model = window.ryu?.model;
	const byId = new Map(captions.map((caption) => [caption.id, caption]));
	const suggest = async () => {
		if (!model) {
			return;
		}
		setLoading(true);
		try {
			const reply = await model.complete(emojiPrompt(captions));
			const next = parseEmojiSuggestions(reply, captions);
			setSuggestions(next);
			setAccepted(new Set(next.map((item) => item.captionId)));
			runtime.setStatus(
				next.length
					? `Review ${next.length} emoji suggestion${next.length === 1 ? "" : "s"} before applying.`
					: "No emoji suggestions for these captions."
			);
		} catch (error) {
			runtime.setStatus(
				error instanceof Error ? error.message : "Emoji suggestions failed."
			);
		} finally {
			setLoading(false);
		}
	};
	const apply = () => {
		const chosen = suggestions.filter((item) => accepted.has(item.captionId));
		const next: Caption[] = applyEmojiSuggestions(captions, chosen);
		void runtime
			.routeEdit(
				"captions",
				{
					action: "replace",
					captions: next,
					trackId: styleTargetTrackId(project),
				},
				() => `Added ${chosen.length} emoji.`
			)
			.then(() => setSuggestions([]));
	};
	return (
		<>
			<RyuAppActions>
				<Button
					disabled={!model || loading || runtime.busy || captions.length === 0}
					onClick={() => void suggest()}
					size="sm"
					title={model ? undefined : "Requires Ryu's model service."}
					variant="outline"
				>
					{loading ? "Suggesting…" : "Suggest emoji"}
				</Button>
			</RyuAppActions>
			{suggestions.length > 0 && (
				<>
					<ul className="flex flex-col gap-1">
						{suggestions.map((item) => (
							<li className="flex items-center gap-2" key={item.captionId}>
								<Checkbox
									aria-label={`Add ${item.emoji}`}
									checked={accepted.has(item.captionId)}
									onCheckedChange={(checked) =>
										setAccepted((current) => {
											const next = new Set(current);
											if (checked === true) {
												next.add(item.captionId);
											} else {
												next.delete(item.captionId);
											}
											return next;
										})
									}
								/>
								<span>
									{byId.get(item.captionId)?.text} {item.emoji}
								</span>
							</li>
						))}
					</ul>
					<RyuAppActions>
						<Button
							disabled={runtime.busy || accepted.size === 0}
							onClick={apply}
							size="sm"
						>
							Apply {accepted.size} emoji
						</Button>
						<Button
							onClick={() => setSuggestions([])}
							size="sm"
							variant="ghost"
						>
							Discard
						</Button>
					</RyuAppActions>
				</>
			)}
		</>
	);
}

function CaptionImport({ runtime }: { runtime: Runtime }) {
	const picker = useRef<HTMLInputElement>(null);
	const [lenient, setLenient] = useState(true);
	const [append, setAppend] = useState(false);
	const lenientId = useId();
	const appendId = useId();
	const importFile = async (file: File | undefined) => {
		if (!file) {
			return;
		}
		const format = subtitleFormatOfFile(file.name);
		if (!format) {
			runtime.setStatus("Choose an .srt, .vtt, .ass, or .ssa subtitle file.");
			return;
		}
		if (file.size > MAX_IMPORT_BYTES) {
			runtime.setStatus("Subtitle file is too large.");
			return;
		}
		await runtime.routeEdit(
			"caption-import",
			{
				format,
				lenient,
				mode: append ? "append" : "replace",
				text: await file.text(),
				trackId: styleTargetTrackId(runtime.project),
			},
			importSummary
		);
	};
	return (
		<>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={lenient}
					id={lenientId}
					onCheckedChange={(checked) => setLenient(checked === true)}
				/>
				<Label htmlFor={lenientId}>Skip malformed cues and report them</Label>
			</div>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={append}
					id={appendId}
					onCheckedChange={(checked) => setAppend(checked === true)}
				/>
				<Label htmlFor={appendId}>Add to the existing captions</Label>
			</div>
			<RyuAppActions>
				<Button
					disabled={runtime.busy}
					onClick={() => picker.current?.click()}
					size="sm"
					variant="outline"
				>
					Import SRT / VTT / ASS
				</Button>
			</RyuAppActions>
			<input
				accept=".srt,.vtt,.ass,.ssa"
				aria-label="Subtitle file"
				hidden
				onChange={(event) => {
					void importFile(event.target.files?.[0]);
					event.target.value = "";
				}}
				ref={picker}
				type="file"
			/>
		</>
	);
}

/** Caption style, chunking, emoji, and caption import options. */
export function CaptionStylePanel() {
	const runtime = useEditorProject();
	const { project } = runtime;
	const trackId = styleTargetTrackId(project);
	const target = trackId
		? project.captionTracks.find((track) => track.id === trackId)?.label
		: undefined;
	const selected = storedStyle(project)?.presetId;
	// Re-mount the forms when the stored values change on the server.
	const formKey = `${project.id}:${trackId ?? "source"}:${JSON.stringify(storedStyle(project) ?? {})}`;
	return (
		<>
			<RyuAppSection title="Caption style">
				<p className="text-muted-foreground text-xs">
					Styling {target ? `the ${target} track` : "the source captions"}.
				</p>
				<PresetGallery
					disabled={runtime.busy}
					onApply={(preset) =>
						void runtime.routeEdit(
							"caption-style",
							{ mode: "replace", style: preset.style, trackId },
							() => `Applied the ${preset.label} caption style.`
						)
					}
					selected={selected}
				/>
				<StyleForm key={formKey} runtime={runtime} />
			</RyuAppSection>
			<RyuAppSection title="Caption timing">
				<ChunkingForm
					key={`${project.id}:${JSON.stringify(project.captionChunking ?? {})}`}
					runtime={runtime}
				/>
				<EmojiSuggestions runtime={runtime} />
			</RyuAppSection>
			<RyuAppSection title="Import captions">
				<CaptionImport runtime={runtime} />
			</RyuAppSection>
		</>
	);
}
