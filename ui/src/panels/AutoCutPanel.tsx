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
import { useState } from "react";
import {
	type AutoEditStyle,
	autoEditStyleSchema,
	MAX_AUTO_EDIT_SECONDS,
	MIN_AUTO_EDIT_SECONDS,
} from "../../../shared/auto-edit.ts";
import { useEditorProject } from "../editor/context.tsx";
import { openProject } from "../editor/project-actions.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { NumberField } from "../NumberField.tsx";
import {
	AspectSelect,
	CheckField,
	SourceList,
} from "./AutoCutPanel-fields.tsx";
import {
	type AutoCutForm,
	type AutoCutResponse,
	autoCutBody,
	autoCutResponseSchema,
	autoCutSources,
	autoCutSummary,
	errorText,
	remember,
} from "./AutoCutPanel-model.ts";
import { ShortsSection } from "./AutoCutPanel-shorts-section.tsx";
import type { PanelTab } from "./types.ts";

export {
	type AutoCutForm,
	type AutoCutResponse,
	autoCutBody,
	autoCutResponseSchema,
	autoCutSources,
	autoCutSummary,
	type ShortsForm,
	type ShortsResponse,
	shortsBody,
	shortsResponseSchema,
} from "./AutoCutPanel-model.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Highlights), below the highlight finder.
 */
export const autoCutPanelTab: PanelTab | null = null;

const STYLE_LABELS: Record<AutoEditStyle, string> = {
	cinematic: "Cinematic: long shots, dissolves and fades",
	energetic: "Energetic: cut on every beat",
	minimal: "Minimal: hard cuts on bars",
	smooth: "Smooth: bars with dissolves",
};

function AutoCutSection({ runtime }: { runtime: EditorRuntime }) {
	const tl = useLiteralMessages();
	const sources = autoCutSources(runtime.assets);
	const music = runtime.assets.filter((asset) => asset.kind === "audio");
	const [form, setForm] = useState<AutoCutForm>({
		aspect: "16:9",
		assetIds: [],
		captions: false,
		duration: 30,
		musicAssetId: "",
		style: "energetic",
	});
	const [working, setWorking] = useState(false);
	const [result, setResult] = useState<AutoCutResponse | null>(null);
	const change = (patch: Partial<AutoCutForm>) =>
		setForm((current) => ({ ...current, ...patch }));
	const selected = form.assetIds.filter((id) =>
		sources.some((asset) => asset.id === id)
	);
	const disabled = runtime.busy || working;

	const create = async () => {
		setWorking(true);
		try {
			const next = autoCutResponseSchema.parse(
				await runtime.api(
					"/auto-edit",
					autoCutBody({ ...form, assetIds: selected }) as Record<
						string,
						unknown
					>
				)
			);
			remember(runtime, next.project);
			setResult(next);
			runtime.setStatus(autoCutSummary(next));
		} catch (error) {
			runtime.setStatus(errorText(error, "AutoCut failed."));
		} finally {
			setWorking(false);
		}
	};

	return (
		<RyuAppSection title="AutoCut">
			<p>
				Pick sources and a music track. AutoCut ranks their best moments by
				speech, loudness and motion, cuts them to the music's beats and builds a
				new project. Your current project is not changed.
			</p>
			<SourceList
				assets={sources}
				disabled={disabled}
				onToggle={(id, checked) =>
					change({
						assetIds: checked
							? [...selected, id]
							: selected.filter((item) => item !== id),
					})
				}
				selected={selected}
			/>
			<RyuAppField label="Music">
				<NativeSelect
					aria-label="AutoCut music"
					onChange={(event) => change({ musicAssetId: event.target.value })}
					value={form.musicAssetId}
				>
					<NativeSelectOption value="">
						No music (steady cuts)
					</NativeSelectOption>
					{music.map((asset) => (
						<NativeSelectOption key={asset.id} value={asset.id}>
							{asset.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<NumberField
				label="Length (seconds)"
				max={MAX_AUTO_EDIT_SECONDS}
				min={MIN_AUTO_EDIT_SECONDS}
				onChange={(duration) => change({ duration })}
				step={1}
				value={form.duration}
			/>
			<RyuAppField label="Style">
				<NativeSelect
					aria-label="AutoCut style"
					onChange={(event) =>
						change({ style: autoEditStyleSchema.parse(event.target.value) })
					}
					value={form.style}
				>
					{autoEditStyleSchema.options.map((style) => (
						<NativeSelectOption key={style} value={style}>
							{STYLE_LABELS[style]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<AspectSelect
				label="AutoCut aspect"
				onChange={(aspect) => change({ aspect })}
				value={form.aspect}
			/>
			<CheckField
				checked={form.captions}
				disabled={disabled}
				label="Add captions from transcripts"
				onChange={(captions) => change({ captions })}
			/>
			{form.captions && form.musicAssetId !== "" && (
				<small>
					The music mutes the source audio, so its speech is not captioned.
				</small>
			)}
			<RyuAppActions>
				<Button
					disabled={disabled || selected.length === 0}
					onClick={() => void create()}
				>
					Create AutoCut
				</Button>
				{result && (
					<Button
						disabled={disabled}
						onClick={() => void openProject(runtime, result.project.id)}
						variant="outline"
					>
						{tl("Open {title}", { title: result.project.title })}
					</Button>
				)}
			</RyuAppActions>
			{result && <small role="status">{autoCutSummary(result)}</small>}
		</RyuAppSection>
	);
}

/** AutoCut (beat-cut montage from several sources) and vertical shorts. */
export function AutoCutPanel() {
	const runtime = useEditorProject();
	return (
		<>
			<AutoCutSection runtime={runtime} />
			<ShortsSection project={runtime.project} runtime={runtime} />
		</>
	);
}
