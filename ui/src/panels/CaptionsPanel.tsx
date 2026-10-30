import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useRef, useState } from "react";
import {
	activeCaptions,
	type Caption,
	parseSubtitles,
	SUBTITLE_EXPORT_FORMATS,
	type SubtitleExportFormat,
	subtitleText,
} from "../../../shared/project.ts";
import { download } from "../bridge.ts";
import { DubCaptions } from "../DubCaptions.tsx";
import { addAssetToTimeline } from "../editor/actions/placement.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { NumberField } from "../NumberField.tsx";
import { TranslateCaptions } from "../TranslateCaptions.tsx";
import { CaptionGlossary } from "./CaptionGlossary.tsx";

/** Largest subtitle file accepted for import. */
const SUBTITLE_FILE_LIMIT = 2_000_000;
/** Latest caption end, matching the timeline limit. */
const CAPTION_LIMIT = 7200;

/** The Captions tab: caption tracks, translation, dubbing, and cue editing. */
export function CaptionsPanel() {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const { editCaptions, editingCaptions, project, setStatus, time } = runtime;
	const captionPicker = useRef<HTMLInputElement>(null);
	const [subtitleFormat, setSubtitleFormat] =
		useState<SubtitleExportFormat>("srt");
	const updateCue = (id: string, patch: Partial<Caption>) =>
		editCaptions(
			editingCaptions.map((cue) => (cue.id === id ? { ...cue, ...patch } : cue))
		);
	const applyTranslation = (
		original: Caption[],
		translated: Caption[],
		language: string
	) => {
		const latest = runtime.latestProject.current;
		if (
			!latest ||
			latest.id !== project.id ||
			JSON.stringify(activeCaptions(latest)) !== JSON.stringify(original)
		) {
			throw new Error(
				"The captions changed during translation. Your current edit was kept; try again."
			);
		}
		runtime.edit((current) => {
			const existing = current.captionTracks.find(
				(track) => track.language.toLowerCase() === language.toLowerCase()
			);
			const trackId = existing?.id ?? crypto.randomUUID();
			return {
				...current,
				captionTrackId: trackId,
				captionTracks: existing
					? current.captionTracks.map((track) =>
							track.id === existing.id
								? { ...track, captions: translated }
								: track
						)
					: [
							...current.captionTracks,
							{ captions: translated, id: trackId, label: language, language },
						],
			};
		}, "Translate captions");
	};
	return (
		<>
			<RyuAppSection title="Timed captions">
				<RyuAppField label="Caption track">
					<NativeSelect
						aria-label="Caption track"
						onChange={(event) =>
							runtime.edit({
								...project,
								captionTrackId: event.target.value || null,
							})
						}
						value={project.captionTrackId ?? ""}
					>
						<NativeSelectOption value="">Source captions</NativeSelectOption>
						{project.captionTracks.map((track) => (
							<NativeSelectOption key={track.id} value={track.id}>
								{track.label} · {track.language}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
				<TranslateCaptions
					captions={editingCaptions}
					onApply={applyTranslation}
					onStatus={setStatus}
				/>
				<DubCaptions
					captions={editingCaptions}
					onAsset={(asset) => {
						runtime.setAssets((current) => [asset, ...current]);
						addAssetToTimeline(runtime, asset);
					}}
					onStatus={setStatus}
					projectId={project.id}
				/>
				<RyuAppActions>
					<Button
						onClick={() => captionPicker.current?.click()}
						size="sm"
						variant="outline"
					>
						Import SRT / VTT
					</Button>
					<Button
						onClick={() =>
							editCaptions([
								...editingCaptions,
								{
									end: Math.min(CAPTION_LIMIT, time + 3),
									id: crypto.randomUUID(),
									start: time,
									text: "New caption",
								},
							])
						}
						size="sm"
						variant="ghost"
					>
						Add caption
					</Button>
				</RyuAppActions>
				{editingCaptions.map((cue, index) => (
					<div className="studio-scene" key={cue.id}>
						<Button
							onClick={() => runtime.setTime(cue.start)}
							size="sm"
							variant="ghost"
						>
							{clock(cue.start)} → {clock(cue.end)}
						</Button>
						{cue.words?.length ? (
							<RyuAppField label="Word highlight color">
								<ColorPickerPopover
									onValueChange={(value) =>
										updateCue(cue.id, { highlightColor: value })
									}
									triggerAriaLabel={tl(
										"Caption {captionNumber} highlight color",
										{
											captionNumber: String(index + 1),
										}
									)}
									triggerClassName="w-full justify-start"
									value={cue.highlightColor ?? "#ffd43b"}
								/>
							</RyuAppField>
						) : null}
						<Textarea
							aria-label={tl("Caption {captionNumber}", {
								captionNumber: String(index + 1),
							})}
							onChange={(event) =>
								updateCue(cue.id, {
									text: event.target.value,
									words: undefined,
								})
							}
							value={cue.text}
						/>
						<div className="studio-pair">
							<NumberField
								label="Caption start"
								max={CAPTION_LIMIT}
								min={0}
								onChange={(start) =>
									updateCue(cue.id, { start, words: undefined })
								}
								value={cue.start}
							/>
							<NumberField
								label="Caption end"
								max={CAPTION_LIMIT}
								min={0}
								onChange={(end) => updateCue(cue.id, { end, words: undefined })}
								value={cue.end}
							/>
						</div>
						<Button
							onClick={() =>
								editCaptions(
									editingCaptions.filter((item) => item.id !== cue.id)
								)
							}
							size="sm"
							variant="ghost"
						>
							Remove caption
						</Button>
					</div>
				))}
				<RyuAppField label="Subtitle format">
					<NativeSelect
						aria-label="Subtitle format"
						onChange={(event) => {
							const next = SUBTITLE_EXPORT_FORMATS.find(
								(format) => format === event.target.value
							);
							if (next) {
								setSubtitleFormat(next);
							}
						}}
						value={subtitleFormat}
					>
						<NativeSelectOption value="srt">SRT</NativeSelectOption>
						<NativeSelectOption value="vtt">WebVTT</NativeSelectOption>
						<NativeSelectOption value="txt">
							Plain text (TXT)
						</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
				<Button
					disabled={!editingCaptions.length}
					onClick={() =>
						download(
							new Blob([subtitleText(editingCaptions, subtitleFormat)], {
								type: subtitleFormat === "vtt" ? "text/vtt" : "text/plain",
							}),
							`${project.title}.${subtitleFormat}`
						)
					}
					variant="outline"
				>
					Download subtitles
				</Button>
				<input
					accept=".srt,.vtt"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) {
							void runtime.act(async () => {
								if (file.size > SUBTITLE_FILE_LIMIT) {
									throw new Error("Subtitle file is too large.");
								}
								editCaptions(parseSubtitles(await file.text()));
							});
						}
						event.target.value = "";
					}}
					ref={captionPicker}
					type="file"
				/>
			</RyuAppSection>
			<CaptionGlossary />
		</>
	);
}
