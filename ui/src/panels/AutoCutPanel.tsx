import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Label } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useId, useState } from "react";
import { z } from "zod";
import {
	type AutoEditAspect,
	type AutoEditInput,
	type AutoEditStyle,
	autoEditAspectSchema,
	autoEditStyleSchema,
	MAX_AUTO_EDIT_SECONDS,
	MAX_AUTO_EDIT_SOURCES,
	MIN_AUTO_EDIT_SECONDS,
	type ShortsInput,
} from "../../../shared/auto-edit.ts";
import {
	type Asset,
	type Project,
	projectSchema,
} from "../../../shared/project.ts";
import { useEditorProject } from "../editor/context.tsx";
import { openProject } from "../editor/project-actions.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { NumberField } from "../NumberField.tsx";
import type { PanelTab } from "./types.ts";

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

const ASPECT_LABELS: Record<AutoEditAspect, string> = {
	"16:9": "16:9 landscape",
	"1:1": "1:1 square",
	"4:5": "4:5 portrait",
	"9:16": "9:16 vertical",
};

export interface AutoCutForm {
	aspect: AutoEditAspect;
	assetIds: string[];
	captions: boolean;
	duration: number;
	musicAssetId: string;
	style: AutoEditStyle;
}

export interface ShortsForm {
	aspect: AutoEditAspect;
	captions: boolean;
	count: number;
	exportShorts: boolean;
	maxSeconds: number;
	minSeconds: number;
}

/** The `POST /auto-edit` body for the form. */
export function autoCutBody(form: AutoCutForm): AutoEditInput {
	return {
		aspect: form.aspect,
		assetIds: form.assetIds.slice(0, MAX_AUTO_EDIT_SOURCES),
		captions: form.captions,
		duration: Math.min(
			MAX_AUTO_EDIT_SECONDS,
			Math.max(MIN_AUTO_EDIT_SECONDS, form.duration)
		),
		style: form.style,
		...(form.musicAssetId ? { musicAssetId: form.musicAssetId } : {}),
	};
}

/** The `POST /projects/:id/shorts` body for the form. */
export function shortsBody(form: ShortsForm, revision: number): ShortsInput {
	return {
		aspect: form.aspect,
		captions: form.captions,
		count: form.count,
		export: form.exportShorts,
		maxSeconds: Math.max(form.minSeconds, form.maxSeconds),
		minSeconds: form.minSeconds,
		revision,
	};
}

export const autoCutResponseSchema = z.object({
	beatSource: z.enum(["detected", "estimate", "none"]),
	captions: z.number(),
	duration: z.number(),
	project: projectSchema,
	slots: z.array(z.object({ end: z.number(), start: z.number() })),
	transitions: z.number(),
});
export type AutoCutResponse = z.infer<typeof autoCutResponseSchema>;

export const shortsResponseSchema = z.object({
	shorts: z.array(
		z.object({
			end: z.number(),
			exportError: z.string().optional(),
			job: z.object({ id: z.string() }).passthrough().optional(),
			project: projectSchema,
			start: z.number(),
			title: z.string(),
		})
	),
});
export type ShortsResponse = z.infer<typeof shortsResponseSchema>;

const BEAT_TEXT: Record<AutoCutResponse["beatSource"], string> = {
	detected: "cut on detected beats",
	estimate: "cut on estimated beats (detect beats on the music for exact bars)",
	none: "cut on a steady grid",
};

/** One status line describing an AutoCut result. */
export function autoCutSummary(result: AutoCutResponse): string {
	const clips = result.slots.length;
	const parts = [
		`${result.project.title}: ${clips} clip${clips === 1 ? "" : "s"} over ${result.duration.toFixed(1)} s, ${BEAT_TEXT[result.beatSource]}`,
	];
	if (result.transitions > 0) {
		parts.push(
			`${result.transitions} transition${result.transitions === 1 ? "" : "s"}`
		);
	}
	if (result.captions > 0) {
		parts.push(`${result.captions} caption${result.captions === 1 ? "" : "s"}`);
	}
	return `${parts.join(", ")}.`;
}

/** Media AutoCut can cut from: video and stills. */
export const autoCutSources = (assets: readonly Asset[]) =>
	assets.filter((asset) => asset.kind !== "audio");

const errorText = (error: unknown, fallback: string) =>
	error instanceof Error ? error.message : fallback;

function remember(runtime: EditorRuntime, project: Project) {
	runtime.setProjects((projects) => [
		...projects.filter((item) => item.id !== project.id),
		project,
	]);
}

function SourceList({
	assets,
	disabled,
	onToggle,
	selected,
}: {
	assets: readonly Asset[];
	disabled: boolean;
	onToggle: (id: string, checked: boolean) => void;
	selected: readonly string[];
}) {
	const baseId = useId();
	if (assets.length === 0) {
		return <small>Import video or images to cut from.</small>;
	}
	const full = selected.length >= MAX_AUTO_EDIT_SOURCES;
	return (
		<ul aria-label="AutoCut sources" className="flex flex-col gap-1">
			{assets.map((asset, index) => {
				const id = `${baseId}-${index}`;
				const checked = selected.includes(asset.id);
				return (
					<li className="flex items-center gap-2" key={asset.id}>
						<Checkbox
							checked={checked}
							disabled={disabled || (full && !checked)}
							id={id}
							onCheckedChange={(value) => onToggle(asset.id, value === true)}
						/>
						<Label htmlFor={id}>{asset.name}</Label>
					</li>
				);
			})}
		</ul>
	);
}

function CheckField({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	label: string;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center gap-2">
			<Checkbox
				checked={checked}
				disabled={disabled}
				id={id}
				onCheckedChange={(value) => onChange(value === true)}
			/>
			<Label htmlFor={id}>{label}</Label>
		</div>
	);
}

function AspectSelect({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (aspect: AutoEditAspect) => void;
	value: AutoEditAspect;
}) {
	return (
		<RyuAppField label={label}>
			<NativeSelect
				aria-label={label}
				onChange={(event) =>
					onChange(autoEditAspectSchema.parse(event.target.value))
				}
				value={value}
			>
				{autoEditAspectSchema.options.map((aspect) => (
					<NativeSelectOption key={aspect} value={aspect}>
						{ASPECT_LABELS[aspect]}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</RyuAppField>
	);
}

function AutoCutSection({ runtime }: { runtime: EditorRuntime }) {
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
						Open {result.project.title}
					</Button>
				)}
			</RyuAppActions>
			{result && <small role="status">{autoCutSummary(result)}</small>}
		</RyuAppSection>
	);
}

function ShortsSection({
	project,
	runtime,
}: {
	project: Project;
	runtime: EditorRuntime;
}) {
	const [form, setForm] = useState<ShortsForm>({
		aspect: "9:16",
		captions: true,
		count: 3,
		exportShorts: false,
		maxSeconds: 60,
		minSeconds: 15,
	});
	const [working, setWorking] = useState(false);
	const [shorts, setShorts] = useState<ShortsResponse["shorts"] | null>(null);
	const change = (patch: Partial<ShortsForm>) =>
		setForm((current) => ({ ...current, ...patch }));
	const disabled = runtime.busy || working;

	const make = async () => {
		setWorking(true);
		try {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			const result = shortsResponseSchema.parse(
				await runtime.api(
					`/projects/${saved.id}/shorts`,
					shortsBody(form, saved.revision) as Record<string, unknown>
				)
			);
			for (const short of result.shorts) {
				remember(runtime, short.project);
			}
			setShorts(result.shorts);
			const failed = result.shorts.filter((short) => short.exportError).length;
			runtime.setStatus(
				`Created ${result.shorts.length} short${result.shorts.length === 1 ? "" : "s"} from ${project.title}${form.exportShorts ? `; ${result.shorts.length - failed} export${result.shorts.length - failed === 1 ? "" : "s"} queued` : ""}.`
			);
		} catch (error) {
			runtime.setStatus(errorText(error, "Making shorts failed."));
		} finally {
			setWorking(false);
		}
	};

	return (
		<RyuAppSection title="Vertical shorts">
			<p>
				Turn this project's best highlights into separate short projects:
				reframed for the new aspect, captioned one word at a time, with a
				matching publish preset.
			</p>
			<NumberField
				label="Shorts to make"
				max={10}
				min={1}
				onChange={(count) => change({ count: Math.round(count) })}
				step={1}
				value={form.count}
			/>
			<NumberField
				label="Shortest short (seconds)"
				max={600}
				min={1}
				onChange={(minSeconds) => change({ minSeconds })}
				step={1}
				value={form.minSeconds}
			/>
			<NumberField
				label="Longest short (seconds)"
				max={600}
				min={1}
				onChange={(maxSeconds) => change({ maxSeconds })}
				step={1}
				value={form.maxSeconds}
			/>
			<AspectSelect
				label="Shorts aspect"
				onChange={(aspect) => change({ aspect })}
				value={form.aspect}
			/>
			<CheckField
				checked={form.captions}
				disabled={disabled}
				label="Word-by-word captions"
				onChange={(captions) => change({ captions })}
			/>
			<CheckField
				checked={form.exportShorts}
				disabled={disabled}
				label="Export each short"
				onChange={(exportShorts) => change({ exportShorts })}
			/>
			<RyuAppActions>
				<Button disabled={disabled} onClick={() => void make()}>
					Make shorts
				</Button>
			</RyuAppActions>
			{shorts && shorts.length > 0 && (
				<ol aria-label="Created shorts" className="flex flex-col gap-1">
					{shorts.map((short) => (
						<li className="flex items-center gap-2" key={short.project.id}>
							<span>
								{short.project.title} · {(short.end - short.start).toFixed(1)} s
								{short.exportError
									? ` · export failed: ${short.exportError}`
									: ""}
							</span>
							<Button
								aria-label={`Open ${short.project.title}`}
								disabled={disabled}
								onClick={() => void openProject(runtime, short.project.id)}
								size="sm"
								variant="outline"
							>
								Open
							</Button>
						</li>
					))}
				</ol>
			)}
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
