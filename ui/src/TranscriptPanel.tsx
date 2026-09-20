import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useRef, useState } from "react";
import { type Asset, parseSubtitles } from "../../shared/project.ts";
import {
	type Transcript,
	transcriptSchema,
	transcriptWindowCues,
	transcriptWindowWords,
} from "../../shared/transcript.ts";
import { request } from "./bridge.ts";

export function TranscriptPanel({
	assets,
	onUse,
	onStatus,
}: {
	assets: Asset[];
	onUse: (transcript: Transcript, highlighted?: boolean) => void;
	onStatus: (message: string) => void;
}) {
	const [assetId, setAssetId] = useState("");
	const [transcript, setTranscript] = useState<Transcript | null>(null);
	const [working, setWorking] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const cancel = useRef(false);
	const picker = useRef<HTMLInputElement>(null);
	const asset = assets.find((item) => item.id === assetId);
	useEffect(() => {
		let mounted = true;
		setTranscript(null);
		if (assetId) {
			void request<{ transcript: unknown }>(`/assets/${assetId}/transcript`)
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
					`/assets/${asset.id}/transcript`,
					"POST",
					restart
						? { restart: true, revision: transcript?.revision ?? null }
						: undefined
				)
			);
			setTranscript(current);
			while (current.status === "running") {
				if (cancel.current) {
					current = transcriptSchema.parse(
						await request(`/assets/${asset.id}/stop-transcript`, "POST", {
							revision: current.revision,
							status: "canceled",
						})
					);
					break;
				}
				const audio = await request<{
					start: number;
					duration: number;
					dataUrl: string;
				}>(`/assets/${asset.id}/audio-window`, "POST", {
					start: current.nextOffset,
				});
				onStatus(
					`Transcribing ${asset.name} · ${Math.round((current.nextOffset / current.duration) * 100)}%`
				);
				const result = await service({
					audio: audio.dataUrl,
					filename: "source-window.wav",
					detailed: true,
				});
				current = transcriptSchema.parse(
					await request(`/assets/${asset.id}/transcript`, "PUT", {
						revision: current.revision,
						offset: current.nextOffset,
						cues: transcriptWindowCues(result, audio.start, audio.duration),
						words: transcriptWindowWords(result, audio.start, audio.duration),
						timing:
							typeof result === "object" &&
							result !== null &&
							"segments" in result &&
							Array.isArray(result.segments) &&
							result.segments.length
								? "segments"
								: "windows",
					})
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
				await request(`/assets/${asset.id}/stop-transcript`, "POST", {
					revision: current.revision,
					status: "failed",
					error: message.slice(0, 1000),
				})
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
			const result = transcriptSchema.parse(
				await request(`/assets/${asset.id}/import-transcript`, "POST", {
					revision: transcript?.revision ?? null,
					cues: parseSubtitles(await file.text()),
				})
			);
			setTranscript(result);
			onStatus("Source transcript imported with its original timings.");
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
					Import source SRT / VTT
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
							? `${transcript.words.length} measured word timestamps available.`
							: "No word timestamps were provided by this engine."}
					</p>
					<Button
						disabled={!transcript.words.length || working}
						onClick={() => onUse(transcript, true)}
						variant="outline"
					>
						Apply highlighted captions
					</Button>
					<div className="studio-transcript-text">
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
				accept=".srt,.vtt"
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
