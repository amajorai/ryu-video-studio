import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import type { Project } from "../../../shared/project.ts";
import type { Speaker } from "../../../shared/schema/speaker.ts";
import {
	DEFAULT_CLUSTER_SPEAKERS,
	MAX_CLUSTER_SPEAKERS,
	MIN_CLUSTER_SPEAKERS,
	type SpeakerDetectMode,
	speakerDetectModeSchema,
	speakerUsage,
	speakerWindows,
} from "../../../shared/speakers.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Transcript), next to the words it labels.
 */
export const speakerPanelTab: PanelTab | null = null;

const MODE_LABELS: Record<SpeakerDetectMode, string> = {
	cluster: "Voice clustering (one mic)",
	"mic-dominance": "Loudest mic (linked or multicam mics)",
};

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** Status line after a detection run, from the route's extras. */
export function detectionSummary(
	extras: Record<string, unknown>,
	tl: LiteralMessage = (source, values) => formatMessage(source, values, "en")
): string {
	const speakers = Array.isArray(extras.speakers) ? extras.speakers.length : 0;
	const assigned = typeof extras.assigned === "number" ? extras.assigned : 0;
	const windows = typeof extras.windows === "number" ? extras.windows : 0;
	return tl(
		"Detected {speakers, plural, one {{speakerCount} speaker} other {{speakerCount} speakers}}; labelled {assignedCount} of {windows, plural, one {{windowCount} word} other {{windowCount} words}}.",
		{
			assignedCount: String(assigned),
			speakerCount: String(speakers),
			speakers,
			windowCount: String(windows),
			windows,
		}
	);
}

/** Speakers that can absorb `speaker` in a merge. */
export const mergeTargets = (project: Project, speaker: Speaker) =>
	(project.speakers ?? []).filter((candidate) => candidate.id !== speaker.id);

function SpeakerRow({
	runtime,
	speaker,
	usage,
}: {
	runtime: EditorRuntime & { project: Project };
	speaker: Speaker;
	usage: { clips: number; words: number } | undefined;
}) {
	const tl = useLiteralMessages();
	const [target, setTarget] = useState("");
	const [draftColor, setDraftColor] = useState(speaker.color);
	useEffect(() => setDraftColor(speaker.color), [speaker.color]);
	const targets = mergeTargets(runtime.project, speaker);
	const mergeInto = targets.find((candidate) => candidate.id === target);
	return (
		<div className="studio-scene" data-speaker-id={speaker.id}>
			<div className="flex items-center gap-2">
				<ColorPickerPopover
					onOpenChange={(open) => {
						// Commit once when the picker closes, not on every drag step.
						if (!open && draftColor !== speaker.color) {
							void runtime.routeEdit(
								"speakers",
								{ action: "recolor", color: draftColor, speakerId: speaker.id },
								() => `Recolored ${speaker.label}.`
							);
						}
					}}
					onValueChange={setDraftColor}
					triggerAriaLabel={tl("{speaker} color", { speaker: speaker.label })}
					value={draftColor}
				/>
				<Input
					aria-label={tl("{speaker} name", { speaker: speaker.label })}
					defaultValue={speaker.label}
					disabled={runtime.busy}
					key={speaker.label}
					maxLength={40}
					onBlur={(event) => {
						const label = event.target.value.trim();
						if (!label || label === speaker.label) {
							event.target.value = speaker.label;
							return;
						}
						void runtime.routeEdit(
							"speakers",
							{ action: "rename", label, speakerId: speaker.id },
							() => `Renamed ${speaker.label} to ${label}.`
						);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.currentTarget.blur();
						}
					}}
				/>
			</div>
			<small className="text-muted-foreground">
				{plural(usage?.words ?? 0, "word")} ·{" "}
				{plural(usage?.clips ?? 0, "clip")}
			</small>
			{targets.length > 0 && (
				<div className="flex items-center gap-2">
					<NativeSelect
						aria-label={tl("Merge {speaker} into", { speaker: speaker.label })}
						onChange={(event) => setTarget(event.target.value)}
						value={target}
					>
						<NativeSelectOption value="">Merge into…</NativeSelectOption>
						{targets.map((candidate) => (
							<NativeSelectOption key={candidate.id} value={candidate.id}>
								{candidate.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<Button
						disabled={runtime.busy || !mergeInto}
						onClick={() => {
							if (!mergeInto) {
								return;
							}
							void runtime
								.routeEdit(
									"speakers",
									{
										action: "merge",
										into: mergeInto.id,
										speakerIds: [speaker.id],
									},
									() => `Merged ${speaker.label} into ${mergeInto.label}.`
								)
								.then(() => setTarget(""));
						}}
						size="sm"
						variant="outline"
					>
						Merge
					</Button>
				</div>
			)}
		</div>
	);
}

/** Speaker detection plus the project's speaker list (rename, recolor, merge). */
export function SpeakerPanel() {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const { busy, project } = runtime;
	const [mode, setMode] = useState<SpeakerDetectMode>("cluster");
	const [count, setCount] = useState(DEFAULT_CLUSTER_SPEAKERS);
	const speakers = project.speakers ?? [];
	const usage = speakerUsage(project);
	const words = speakerWindows(project).length;
	return (
		<RyuAppSection title="Speakers">
			<RyuAppField label="Detection">
				<NativeSelect
					aria-label="Speaker detection mode"
					onChange={(event) => {
						const parsed = speakerDetectModeSchema.safeParse(
							event.target.value
						);
						if (parsed.success) {
							setMode(parsed.data);
						}
					}}
					value={mode}
				>
					{speakerDetectModeSchema.options.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{MODE_LABELS[option]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{mode === "cluster" && (
				<RyuAppField label="Number of speakers">
					<NativeSelect
						aria-label="Number of speakers"
						onChange={(event) => setCount(Number(event.target.value))}
						value={String(count)}
					>
						{Array.from(
							{ length: MAX_CLUSTER_SPEAKERS - MIN_CLUSTER_SPEAKERS + 1 },
							(_, index) => MIN_CLUSTER_SPEAKERS + index
						).map((option) => (
							<NativeSelectOption key={option} value={String(option)}>
								{option}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
			)}
			<RyuAppActions>
				<Button
					disabled={busy || words === 0}
					onClick={() =>
						void runtime.routeEdit(
							"speakers/detect",
							mode === "cluster" ? { k: count, mode } : { mode },
							(extras) => detectionSummary(extras, tl)
						)
					}
					size="sm"
					title={
						words === 0
							? "Transcribe or import captions with word timing first."
							: undefined
					}
				>
					Detect speakers
				</Button>
			</RyuAppActions>
			{words === 0 && (
				<p className="text-muted-foreground">
					Speakers are detected from caption words. Transcribe dialogue first.
				</p>
			)}
			{speakers.map((speaker) => (
				<SpeakerRow
					key={speaker.id}
					runtime={runtime}
					speaker={speaker}
					usage={usage.get(speaker.id)}
				/>
			))}
		</RyuAppSection>
	);
}
