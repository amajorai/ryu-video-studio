import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	TRANSCRIPT_LANGUAGES,
	transcriptLanguageSchema,
} from "../../shared/caption-languages.ts";
import type { Asset } from "../../shared/project.ts";
import {
	parseSubtitlesLenient,
	type SkippedCue,
} from "../../shared/subtitles.ts";
import {
	type Transcript,
	transcriptSchema,
	transcriptWindowCues,
	transcriptWindowInputSchema,
	transcriptWindowWords,
	transcriptWordsInputSchema,
} from "../../shared/transcript.ts";
import { request, studioResponseSchema, transcribeInput } from "./bridge.ts";
import { readViewerValue, writeViewerValue } from "./editor/viewer-storage.ts";
import { studioFormat } from "./i18n/format.ts";

const LANGUAGE_KEY = "transcript-language";

/** Status text for an import, naming the first skipped cues. */
export function importReport(imported: number, skipped: readonly SkippedCue[]) {
	const base = studioFormat(
		"Imported {count, plural, one {# cue} other {# cues}} with their original timings.",
		{ count: imported }
	);
	if (!skipped.length) {
		return base;
	}
	const reasons = skipped
		.slice(0, 3)
		.map((item) =>
			studioFormat("line {line}: {reason}", {
				line: item.line,
				reason: item.reason,
			})
		)
		.join("; ");
	const skippedText = studioFormat(
		"Skipped {count, plural, one {# malformed cue} other {# malformed cues}} ({reasons}).",
		{
			count: skipped.length,
			reasons: `${reasons}${skipped.length > 3 ? "; …" : ""}`,
		}
	);
	return `${base} ${skippedText}`;
}

export function TranscriptPanel({
	assets,
	onUse,
	onStatus,
}: {
	assets: Asset[];
	onUse: (transcript: Transcript, highlighted?: boolean) => void;
	onStatus: (message: string) => void;
}) {
	const tl = useLiteralMessages();
	const [assetId, setAssetId] = useState("");
	const [transcript, setTranscript] = useState<Transcript | null>(null);
	const [working, setWorking] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const [language, setLanguage] = useState(() =>
		readViewerValue(LANGUAGE_KEY, transcriptLanguageSchema, "auto")
	);
	const cancel = useRef(false);
	const picker = useRef<HTMLInputElement>(null);
	const asset = assets.find((item) => item.id === assetId);
	useEffect(() => {
		let mounted = true;
		setTranscript(null);
		if (assetId) {
			void request(
				z.object({ transcript: z.json() }),
				`/assets/${assetId}/transcript`
			)
				.then((result) => {
					if (mounted) {
						setTranscript(
							result.transcript
								? transcriptSchema.parse(result.transcript)
								: null
						);
					}
				})
				.catch((error) =>
					onStatus(
						error instanceof Error ? error.message : "Transcript unavailable."
					)
				);
		}
		return () => {
			mounted = false;
		};
	}, [assetId, onStatus]);
	const transcribe = async (restart = false) => {
		const service = window.ryu?.media?.transcribe;
		if (!(asset && service)) {
			return;
		}
		setWorking(true);
		setTranscribing(true);
		cancel.current = false;
		let current: Transcript | undefined;
		try {
			current = transcriptSchema.parse(
				await request(
					studioResponseSchema,
					`/assets/${asset.id}/transcript`,
					"POST",
					restart
						? {
								language,
								restart: true,
								revision: transcript?.revision ?? null,
							}
						: { language }
				)
			);
			setTranscript(current);
			while (current.status === "running") {
				if (cancel.current) {
					current = transcriptSchema.parse(
						await request(
							studioResponseSchema,
							`/assets/${asset.id}/stop-transcript`,
							"POST",
							{
								revision: current.revision,
								status: "canceled",
							}
						)
					);
					break;
				}
				const audio = await request(
					z.object({
						start: z.number(),
						duration: z.number(),
						dataUrl: z.string(),
					}),
					`/assets/${asset.id}/audio-window`,
					"POST",
					{
						start: current.nextOffset,
					}
				);
				onStatus(
					`Transcribing ${asset.name} · ${Math.round((current.nextOffset / current.duration) * 100)}%`
				);
				// Every window uses the transcript's stored language, so a resumed
				// transcript never mixes languages (the sidecar refuses resuming
				// saved windows with a different one).
				const result = await service(
					transcribeInput(audio.dataUrl, current.language ?? language)
				);
				const cueInput = transcriptWindowInputSchema.safeParse(result);
				const wordInput = transcriptWordsInputSchema.safeParse(result);
				current = transcriptSchema.parse(
					await request(
						studioResponseSchema,
						`/assets/${asset.id}/transcript`,
						"PUT",
						{
							revision: current.revision,
							offset: current.nextOffset,
							cues: transcriptWindowCues(
								cueInput.success ? cueInput.data : "",
								audio.start,
								audio.duration
							),
							words: transcriptWindowWords(
								wordInput.success ? wordInput.data : undefined,
								audio.start,
								audio.duration
							),
							timing:
								cueInput.success && cueInput.data.segments?.length
									? "segments"
									: "windows",
						}
					)
				);
				setTranscript(current);
			}
			setTranscript(current);
			onStatus(
				current.status === "completed"
					? "Source transcript saved. Review its timing before applying captions."
					: "Transcription stopped. Saved windows can be resumed."
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Transcription failed.";
			if (current?.status === "running") {
				await request(
					studioResponseSchema,
					`/assets/${asset.id}/stop-transcript`,
					"POST",
					{
						revision: current.revision,
						status: "failed",
						error: message.slice(0, 1000),
					}
				)
					.then((value) => setTranscript(transcriptSchema.parse(value)))
					.catch(() => undefined);
			}
			onStatus(message);
		} finally {
			setWorking(false);
			setTranscribing(false);
		}
	};
	const importFile = async (file: File | undefined) => {
		if (!(asset && file)) {
			return;
		}
		setWorking(true);
		try {
			if (file.size > 2_000_000) {
				throw new Error("Transcript file is too large.");
			}
			const parsed = parseSubtitlesLenient(await file.text());
			if (!parsed.captions.length) {
				throw new Error(
					`No valid cues found in ${file.name}. ${importReport(0, parsed.skipped)}`
				);
			}
			const result = transcriptSchema.parse(
				await request(
					studioResponseSchema,
					`/assets/${asset.id}/import-transcript`,
					"POST",
					{
						revision: transcript?.revision ?? null,
						cues: parsed.captions,
					}
				)
			);
			setTranscript(result);
			onStatus(importReport(parsed.captions.length, parsed.skipped));
		} catch (error) {
			onStatus(
				error instanceof Error ? error.message : "Transcript import failed."
			);
		} finally {
			setWorking(false);
		}
	};
	return (
		<RyuAppSection title="Source transcript">
			<RyuAppField label="Source">
				<NativeSelect
					aria-label="Transcript source"
					disabled={working}
					onChange={(event) => setAssetId(event.target.value)}
					value={assetId}
				>
					<NativeSelectOption value="">Choose source media</NativeSelectOption>
					{assets
						.filter((item) => item.kind !== "image")
						.map((item) => (
							<NativeSelectOption key={item.id} value={item.id}>
								{item.name}
							</NativeSelectOption>
						))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Spoken language">
				<NativeSelect
					aria-label="Transcription language"
					disabled={working}
					onChange={(event) => {
						const parsed = transcriptLanguageSchema.safeParse(
							event.target.value
						);
						if (parsed.success) {
							setLanguage(parsed.data);
							writeViewerValue(LANGUAGE_KEY, parsed.data);
						}
					}}
					value={language}
				>
					{TRANSCRIPT_LANGUAGES.map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={
						!asset?.hasAudio ||
						working ||
						!window.ryu?.media?.transcribe ||
						transcript?.status === "completed"
					}
					onClick={() => void transcribe()}
					size="sm"
					variant="outline"
				>
					{transcript?.status === "completed"
						? "Transcription complete"
						: transcript?.nextOffset
							? "Resume transcription"
							: "Transcribe with Ryu"}
				</Button>
				{transcript && transcript.status !== "running" && (
					<Button
						disabled={working || !window.ryu?.media?.transcribe}
						onClick={() => void transcribe(true)}
						size="sm"
						variant="outline"
					>
						Transcribe again
					</Button>
				)}
				<Button
					disabled={!asset || working}
					onClick={() => picker.current?.click()}
					size="sm"
					variant="ghost"
				>
					Import source SRT / VTT / ASS
				</Button>
			</RyuAppActions>
			{transcribing && (
				<Button
					onClick={() => {
						cancel.current = true;
						onStatus(
							"Transcription will stop after the current window is saved."
						);
					}}
					size="sm"
					variant="outline"
				>
					Stop after this window
				</Button>
			)}
			{!window.ryu?.media?.transcribe && (
				<p>
					Automatic transcription requires Ryu's transcription service. You can
					import a timed source transcript here.
				</p>
			)}
			{transcript && (
				<>
					<p>
						{transcript.status} ·{" "}
						{Math.round(
							(transcript.nextOffset / Math.max(0.1, transcript.duration)) * 100
						)}
						% ·{" "}
						{transcript.origin === "imported"
							? "Imported timings"
							: transcript.timing === "segments"
								? "Engine segment timings"
								: "Window timings"}
					</p>
					{transcript.error && <p>{transcript.error}</p>}
					<Button
						disabled={!transcript.cues.length || working}
						onClick={() => onUse(transcript)}
						variant="outline"
					>
						Apply to timeline captions
					</Button>
					<Button
						disabled={!transcript.words.length || working}
						onClick={() => onUse({ ...transcript, cues: transcript.words })}
						variant="outline"
					>
						Apply word captions
					</Button>
					<p>
						{transcript.words.length
							? tl("{count} measured word timestamps available.", {
									count: String(transcript.words.length),
								})
							: "No word timestamps were provided by this engine."}
					</p>
					<Button
						disabled={!transcript.words.length || working}
						onClick={() => onUse(transcript, true)}
						variant="outline"
					>
						Apply highlighted captions
					</Button>
					<div>
						{transcript.cues.map((cue) => (
							<p key={cue.id}>
								<span className="font-mono">{cue.start.toFixed(1)}s</span>{" "}
								{cue.text}
							</p>
						))}
					</div>
				</>
			)}
			<input
				accept=".srt,.vtt,.ass,.ssa"
				hidden
				onChange={(event) => {
					void importFile(event.target.files?.[0]);
					event.target.value = "";
				}}
				ref={picker}
				type="file"
			/>
		</RyuAppSection>
	);
}
