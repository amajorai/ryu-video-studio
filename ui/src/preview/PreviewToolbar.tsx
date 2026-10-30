import { Button, Checkbox, Label } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useId, useRef, useState } from "react";
import {
	copyPreviewFrame,
	customGuideOf,
	savePreviewFrame,
	setCustomGuide,
	setPlaybackRate,
	setPreviewGuides,
	setPreviewQuality,
	setPreviewZoom,
	togglePreviewFullscreen,
	togglePreviewGuide,
} from "../editor/actions/preview.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useEditorStore } from "../editor/store.ts";
import { NumberField } from "../NumberField.tsx";
import {
	CUSTOM_GUIDE_LIMITS,
	PREVIEW_GUIDE_IDS,
	PREVIEW_GUIDE_LABELS,
	parseGuideAspect,
} from "./overlays/guide-geometry.ts";
import {
	isPreviewQuality,
	PLAYBACK_RATES,
	PREVIEW_QUALITIES,
	PREVIEW_QUALITY_LABELS,
	playbackRateLabel,
} from "./quality.ts";
import {
	PREVIEW_ZOOM_LEVELS,
	type PreviewZoom,
	previewZoomLabel,
} from "./viewport-math.ts";

/** "Fit (17%)": the real fit scale, which may fall outside the 25-400% zoom range. */
export function fitZoomLabel(fitScale: number): string {
	const percent =
		Number.isFinite(fitScale) && fitScale > 0 ? Math.round(fitScale * 100) : 0;
	return percent ? `Fit (${percent}%)` : "Fit";
}

/** Option values for the zoom menu: "fit", or the zoom factor as a string. */
export function zoomOptionValues(zoom: PreviewZoom): string[] {
	const levels = PREVIEW_ZOOM_LEVELS.map(String);
	const current = String(zoom);
	return zoom === "fit" || levels.includes(current)
		? ["fit", ...levels]
		: [
				"fit",
				...[...PREVIEW_ZOOM_LEVELS, zoom].sort((a, b) => a - b).map(String),
			];
}

/** Rates for the playback-rate menu, including an off-menu current rate. */
export function rateOptionValues(rate: number): number[] {
	return PLAYBACK_RATES.includes(rate as (typeof PLAYBACK_RATES)[number])
		? [...PLAYBACK_RATES]
		: [...PLAYBACK_RATES, rate].sort((a, b) => a - b);
}

const percent = (value: number) => Math.round(value * 1000) / 10;

/** Custom guide and grid settings, shown while either guide is on. */
function CustomGuideFields({ runtime }: { runtime: EditorRuntime }) {
	const stored = useEditorStore(runtime.store, (state) => state.customGuide);
	const guide = customGuideOf({ customGuide: stored });
	const [aspectText, setAspectText] = useState(() =>
		guide.aspect === null ? "" : String(Number(guide.aspect.toFixed(4)))
	);
	const [aspectError, setAspectError] = useState(false);
	const commitAspect = () => {
		const aspect = parseGuideAspect(aspectText);
		const invalid = aspectText.trim() !== "" && aspect === null;
		setAspectError(invalid);
		if (!invalid) {
			setCustomGuide(runtime, { aspect });
		}
	};
	const maxMargin = CUSTOM_GUIDE_LIMITS.maxMargin * 100;
	return (
		<div className="grid gap-1.5 border-t pt-1.5" data-custom-guide="">
			<Label className="text-xs" htmlFor="studio-custom-guide-aspect">
				Custom aspect (W:H, blank for none)
			</Label>
			<input
				aria-invalid={aspectError}
				className="h-7 rounded-md border bg-background px-2 text-xs"
				id="studio-custom-guide-aspect"
				onBlur={commitAspect}
				onChange={(event) => setAspectText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commitAspect();
					}
				}}
				placeholder="2.35:1"
				value={aspectText}
			/>
			{aspectError ? (
				<p className="text-destructive text-xs" role="alert">
					Use W:H between 1:10 and 10:1.
				</p>
			) : null}
			<NumberField
				label="Side margins (%)"
				max={maxMargin}
				min={0}
				onChange={(value) =>
					setCustomGuide(runtime, {
						margins: {
							...guide.margins,
							left: value / 100,
							right: value / 100,
						},
					})
				}
				step={1}
				value={percent(guide.margins.left)}
			/>
			<NumberField
				label="Top and bottom margins (%)"
				max={maxMargin}
				min={0}
				onChange={(value) =>
					setCustomGuide(runtime, {
						margins: {
							...guide.margins,
							bottom: value / 100,
							top: value / 100,
						},
					})
				}
				step={1}
				value={percent(guide.margins.top)}
			/>
			<NumberField
				label="Grid columns"
				max={CUSTOM_GUIDE_LIMITS.maxGrid}
				min={CUSTOM_GUIDE_LIMITS.minGrid}
				onChange={(value) => setCustomGuide(runtime, { gridColumns: value })}
				step={1}
				value={guide.gridColumns}
			/>
			<NumberField
				label="Grid rows"
				max={CUSTOM_GUIDE_LIMITS.maxGrid}
				min={CUSTOM_GUIDE_LIMITS.minGrid}
				onChange={(value) => setCustomGuide(runtime, { gridRows: value })}
				step={1}
				value={guide.gridRows}
			/>
		</div>
	);
}

function GuidesMenu({ runtime }: { runtime: EditorRuntime }) {
	const tl = useLiteralMessages();
	const guides = useEditorStore(runtime.store, (state) => state.guides);
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const closeOutside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node | null)) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [open]);

	return (
		<div
			className="relative"
			onKeyDown={(event) => {
				if (event.key === "Escape" && open) {
					event.stopPropagation();
					setOpen(false);
				}
			}}
			ref={rootRef}
		>
			<Button
				aria-controls={panelId}
				aria-expanded={open}
				aria-pressed={guides.size > 0}
				onClick={() => setOpen((value) => !value)}
				size="dense"
				variant="ghost"
			>
				{guides.size
					? tl("Guides ({size})", { size: String(guides.size) })
					: "Guides"}
			</Button>
			{open ? (
				// Rendered in place rather than in a portal so it stays visible in fullscreen.
				<fieldset
					className="absolute top-full left-0 z-[80] mt-1 grid max-h-[70vh] w-60 gap-1.5 overflow-y-auto rounded-xl border bg-popover p-2 text-popover-foreground shadow-md"
					id={panelId}
				>
					<legend className="sr-only">Preview guides</legend>
					{PREVIEW_GUIDE_IDS.map((id) => {
						const inputId = `${panelId}-${id}`;
						return (
							<div className="flex items-center gap-2" key={id}>
								<Checkbox
									checked={guides.has(id)}
									id={inputId}
									onCheckedChange={() => togglePreviewGuide(runtime, id)}
								/>
								<Label className="font-normal text-xs" htmlFor={inputId}>
									{PREVIEW_GUIDE_LABELS[id]}
								</Label>
							</div>
						);
					})}
					{guides.has("custom") || guides.has("grid") ? (
						<CustomGuideFields runtime={runtime} />
					) : null}
					<Button
						disabled={!guides.size}
						onClick={() => setPreviewGuides(runtime, [])}
						size="dense"
						variant="ghost"
					>
						Hide all guides
					</Button>
				</fieldset>
			) : null}
		</div>
	);
}

export interface PreviewToolbarProps {
	/** Screen pixels per project pixel when the frame fits, for the "Fit" label. */
	fitScale: number;
	fullscreen: boolean;
	runtime: EditorRuntime;
	/**
	 * Show the playback-rate menu (the clock and the media layer follow
	 * `store.playbackRate`). The editor viewport turns it on.
	 */
	showPlaybackRate?: boolean;
	/** Show the "Use proxies" toggle (the preview sources follow `store.useProxies`). */
	showProxies?: boolean;
	/**
	 * Show the preview-quality menu (proxy choice and the GPU layer's canvas
	 * size follow `store.previewQuality`). The editor viewport turns it on.
	 */
	showQuality?: boolean;
}

/**
 * Preview chrome: zoom, guides, frame snapshots, and fullscreen, plus the
 * playback-rate and quality menus once their consumers apply them. Every control changes only how this viewer
 * watches the project; none of it reaches the project or a render.
 */
export function PreviewToolbar({
	fitScale,
	fullscreen,
	runtime,
	showPlaybackRate = false,
	showProxies = false,
	showQuality = false,
}: PreviewToolbarProps) {
	const { store } = runtime;
	const zoom = useEditorStore(store, (state) => state.previewZoom);
	const rate = useEditorStore(store, (state) => state.playbackRate);
	const quality = useEditorStore(store, (state) => state.previewQuality);
	const useProxies = useEditorStore(store, (state) => state.useProxies);

	return (
		<div
			aria-label="Preview controls"
			className="relative z-[70] flex shrink-0 flex-wrap items-center gap-1 pb-1"
			data-preview-toolbar=""
			role="toolbar"
		>
			<NativeSelect
				appearance="dense"
				aria-label="Preview zoom"
				onChange={(event) => {
					const { value } = event.target;
					setPreviewZoom(runtime, value === "fit" ? "fit" : Number(value));
				}}
				value={String(zoom)}
			>
				{zoomOptionValues(zoom).map((value) => (
					<NativeSelectOption key={value} value={value}>
						{value === "fit"
							? fitZoomLabel(fitScale)
							: previewZoomLabel(Number(value))}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<GuidesMenu runtime={runtime} />
			{showPlaybackRate ? (
				<NativeSelect
					appearance="dense"
					aria-label="Playback rate"
					onChange={(event) =>
						setPlaybackRate(runtime, Number(event.target.value))
					}
					value={String(rate)}
				>
					{rateOptionValues(rate).map((value) => (
						<NativeSelectOption key={value} value={String(value)}>
							{playbackRateLabel(value)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			) : null}
			{showQuality ? (
				<NativeSelect
					appearance="dense"
					aria-label="Preview quality"
					onChange={(event) => {
						const { value } = event.target;
						if (isPreviewQuality(value)) {
							setPreviewQuality(runtime, value);
						}
					}}
					value={quality}
				>
					{PREVIEW_QUALITIES.map((value) => (
						<NativeSelectOption key={value} value={value}>
							{PREVIEW_QUALITY_LABELS[value]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			) : null}
			{showProxies ? (
				<Button
					aria-pressed={useProxies}
					onClick={() => store.setState({ useProxies: !useProxies })}
					size="dense"
					title="Play preview video from lighter proxy files when they exist. Exports always use the original media."
					variant={useProxies ? "secondary" : "ghost"}
				>
					Use proxies
				</Button>
			) : null}
			<Button
				disabled={!runtime.project}
				onClick={() => {
					void savePreviewFrame(runtime);
				}}
				size="dense"
				variant="ghost"
			>
				Save frame
			</Button>
			<Button
				disabled={!runtime.project}
				onClick={() => {
					void copyPreviewFrame(runtime);
				}}
				size="dense"
				variant="ghost"
			>
				Copy frame
			</Button>
			<Button
				aria-pressed={fullscreen}
				onClick={() => {
					void togglePreviewFullscreen(runtime);
				}}
				size="dense"
				variant="ghost"
			>
				{fullscreen ? "Exit fullscreen" : "Fullscreen"}
			</Button>
		</div>
	);
}
