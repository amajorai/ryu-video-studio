import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Textarea } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { z } from "zod";
import { chunkingOf } from "../../../shared/caption-chunking.ts";
import { profanityWordsSchema } from "../../../shared/profanity.ts";
import { activeCaptions } from "../../../shared/project.ts";
import {
	type CaptionChunking,
	captionChunkingSchema,
} from "../../../shared/schema/caption-style.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { NumberField } from "./CaptionStylePanel-fields.tsx";
import {
	PROFANITY_KEY,
	parseProfanityList,
	type Runtime,
	rechunkBody,
	styleTargetTrackId,
} from "./CaptionStylePanel-model.ts";

export function ChunkingForm({ runtime }: { runtime: Runtime }) {
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
