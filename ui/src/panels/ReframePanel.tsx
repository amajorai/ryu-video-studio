import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Switch } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { z } from "zod";
import {
	type StabilizeLevel,
	stabilizeLevelSchema,
} from "../../../shared/derivatives.ts";
import {
	type Asset,
	type Project,
	trackSettingFor,
} from "../../../shared/project.ts";
import {
	DEFAULT_REFRAME_SMOOTHING,
	isReframeableClip,
	type ReframeAspect,
	type ReframeMode,
	reframeAspectSchema,
	reframeCanvas,
	reframeModeLabels,
	reframeModeSchema,
	reframeTargets,
} from "../../../shared/reframe.ts";
import { useEditorProject } from "../editor/context.tsx";
import { NumberField } from "../NumberField.tsx";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Layouts), next to the other framing tools.
 */
export const reframePanelTab: PanelTab | null = null;

const MODE_HINTS: Record<ReframeMode, string> = {
	"blur-fill":
		"Shows the whole picture and fills the rest of the frame with a blurred copy.",
	center: "Crops every clip around its centre.",
	track:
		"Follows the moving or most detailed subject of each shot with a smooth pan.",
};

const STABILIZE_LABELS = {
	high: "High (strong shake)",
	low: "Low (light shake)",
	medium: "Medium",
} as const satisfies Record<StabilizeLevel, string>;

const stabilizeChoiceSchema = z.union([z.literal("off"), stabilizeLevelSchema]);
const stabilizedClipsSchema = z.array(
	z.object({ assetId: z.string().optional(), clipId: z.string() })
);

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** Status line after a reframe, from the route's extras. */
export function reframeSummary(extras: Record<string, unknown>): string {
	const clips = Array.isArray(extras.clips) ? extras.clips : [];
	const tracked = clips.filter(
		(clip) =>
			typeof clip === "object" &&
			clip !== null &&
			"mode" in clip &&
			clip.mode === "track"
	).length;
	const fallbacks = clips.filter(
		(clip) => typeof clip === "object" && clip !== null && "note" in clip
	).length;
	const size =
		typeof extras.width === "number" && typeof extras.height === "number"
			? ` at ${extras.width}×${extras.height}`
			: "";
	const stabilized = stabilizedClipsSchema.safeParse(extras.stabilized);
	const stabilizedCount = stabilized.success
		? stabilized.data.filter((clip) => clip.assetId !== undefined).length
		: 0;
	const parts = [`Reframed ${plural(clips.length, "clip")}${size}`];
	if (stabilizedCount > 0) {
		parts.push(`${stabilizedCount} stabilized first`);
	}
	if (tracked > 0) {
		parts.push(`${tracked} tracked`);
	}
	if (fallbacks > 0) {
		parts.push(`${fallbacks} centred (not tracked)`);
	}
	return `${parts.join("; ")}.`;
}

/** The `POST /projects/:id/reframe` body (the revision is added by the caller). */
export interface ReframeBody {
	aspect: ReframeAspect;
	clipIds?: string[];
	mode: ReframeMode;
	smoothing?: number;
	stabilize?: StabilizeLevel;
}

/** The reframe body for the panel's settings; smoothing only applies to tracking. */
export function reframeBody(settings: {
	aspect: ReframeAspect;
	clipIds?: string[];
	mode: ReframeMode;
	smoothing: number;
	stabilize: StabilizeLevel | "off";
}): ReframeBody {
	const body: ReframeBody = { aspect: settings.aspect, mode: settings.mode };
	if (settings.mode === "track") {
		body.smoothing = settings.smoothing;
	}
	if (settings.stabilize !== "off") {
		body.stabilize = settings.stabilize;
	}
	if (settings.clipIds) {
		body.clipIds = settings.clipIds;
	}
	return body;
}

/**
 * Clips the reframe will change: the selected visual clips on unlocked
 * tracks when "selected only" is on, otherwise every clip on an unlocked
 * track that covers the canvas.
 */
export function reframeScope(
	project: Project,
	assets: readonly Asset[],
	selectedIds: readonly string[],
	selectedOnly: boolean
): { clipIds?: string[]; count: number } {
	if (selectedOnly) {
		const byId = new Map(assets.map((asset) => [asset.id, asset]));
		const clipIds = project.segments
			.filter(
				(segment) =>
					selectedIds.includes(segment.id) &&
					!trackSettingFor(project, segment.track).locked &&
					isReframeableClip(segment, byId.get(segment.assetId))
			)
			.map((segment) => segment.id);
		return { clipIds, count: clipIds.length };
	}
	return { count: reframeTargets(project, assets).length };
}

/** Auto reframe to any target in `reframeAspects` (`POST /projects/:id/reframe`). */
export function ReframePanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { assets, busy, project, selectedIds } = runtime;
	const [aspect, setAspect] = useState<ReframeAspect>("9:16");
	const [mode, setMode] = useState<ReframeMode>("track");
	const [smoothing, setSmoothing] = useState(DEFAULT_REFRAME_SMOOTHING);
	const [selectedOnly, setSelectedOnly] = useState(false);
	const [stabilize, setStabilize] = useState<StabilizeLevel | "off">("off");
	const scope = reframeScope(project, assets, selectedIds, selectedOnly);
	const canvas = reframeCanvas(project, aspect);
	const disabledReason =
		scope.count === 0
			? selectedOnly
				? "Select a video or image clip on an unlocked track first."
				: "Add a full-frame video or image clip first."
			: undefined;
	return (
		<RyuAppSection title="Auto reframe">
			<RyuAppField
				description={tl("The canvas becomes {width}×{height}.", {
					width: String(canvas.width),
					height: String(canvas.height),
				})}
				label="Aspect ratio"
			>
				<NativeSelect
					aria-label="Reframe aspect ratio"
					onChange={(event) => {
						const parsed = reframeAspectSchema.safeParse(event.target.value);
						if (parsed.success) {
							setAspect(parsed.data);
						}
					}}
					value={aspect}
				>
					{reframeAspectSchema.options.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{option}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField description={MODE_HINTS[mode]} label="Framing">
				<NativeSelect
					aria-label="Reframe mode"
					onChange={(event) => {
						const parsed = reframeModeSchema.safeParse(event.target.value);
						if (parsed.success) {
							setMode(parsed.data);
						}
					}}
					value={mode}
				>
					{reframeModeSchema.options.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{reframeModeLabels[option]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{mode === "track" && (
				<NumberField
					label="Smoothing"
					max={1}
					min={0}
					onChange={setSmoothing}
					step={0.05}
					value={smoothing}
				/>
			)}
			<RyuAppField
				description="Steadies each video clip first (a reusable stabilized copy, as in Media tools), so the framing follows the subject, not the shake."
				label="Image stabilization"
			>
				<NativeSelect
					aria-label="Reframe image stabilization"
					onChange={(event) => {
						const parsed = stabilizeChoiceSchema.safeParse(event.target.value);
						if (parsed.success) {
							setStabilize(parsed.data);
						}
					}}
					value={stabilize}
				>
					<NativeSelectOption value="off">Off</NativeSelectOption>
					{stabilizeLevelSchema.options.map((level) => (
						<NativeSelectOption key={level} value={level}>
							{STABILIZE_LABELS[level]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField
				description={
					selectedOnly
						? tl(
								"{count, plural, one {{countText} selected clip} other {{countText} selected clips}}.",
								{ count: scope.count, countText: String(scope.count) }
							)
						: tl(
								"{count, plural, one {{countText} full-frame clip} other {{countText} full-frame clips}}; picture-in-picture insets, split-screen cells and locked tracks stay as they are.",
								{ count: scope.count, countText: String(scope.count) }
							)
				}
				label="Selected clips only"
			>
				<Switch
					aria-label="Reframe selected clips only"
					checked={selectedOnly}
					onCheckedChange={setSelectedOnly}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={busy || disabledReason !== undefined}
					onClick={() =>
						void runtime.routeEdit(
							"reframe",
							{
								...reframeBody({
									aspect,
									clipIds: scope.clipIds,
									mode,
									smoothing,
									stabilize,
								}),
							},
							reframeSummary
						)
					}
					size="sm"
					title={disabledReason}
				>
					{tl("Reframe to {aspect}", { aspect })}
				</Button>
			</RyuAppActions>
		</RyuAppSection>
	);
}
