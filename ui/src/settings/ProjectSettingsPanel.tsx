import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useRef, useState } from "react";
import { z } from "zod";
import {
	frameRateLabel,
	PROJECT_FRAME_RATES,
} from "../../../shared/frame-rate.ts";
import { MAX_CANVAS } from "../../../shared/limits.ts";
import { projectSchema } from "../../../shared/project.ts";
import { CANVAS_PRESETS, customCanvas } from "../../../shared/settings.ts";
import {
	styleProfileConfig,
	styleProfileOptions,
} from "../../../shared/styles.ts";
import { download, request } from "../bridge.ts";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import {
	downloadInterchange,
	downloadProjectArchive,
	importPackage,
} from "../editor/project-actions.ts";
import { NumberField } from "../NumberField.tsx";

const FORMATS = CANVAS_PRESETS.map(
	([width, height, label]) => [`${width}x${height}`, label] as const
);
const CUSTOM_FORMAT = "custom";

/** Inspector content while no clip is selected: output settings and project files. */
export function ProjectSettingsPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { busy, edit, project, setStatus } = runtime;
	const packagePicker = useRef<HTMLInputElement>(null);
	const downloadJson = (value: unknown, filename: string) =>
		download(
			new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
			filename
		);
	const format = `${project.width}x${project.height}`;
	const presetFormat = FORMATS.some(([value]) => value === format);
	const [customOpen, setCustomOpen] = useState(false);
	const showCustom = customOpen || !presetFormat;
	const resize = (width: number, height: number) => {
		const next = customCanvas(width, height);
		if (next.width !== width || next.height !== height) {
			setStatus(
				tl(
					"Canvas set to {width}×{height} (even edges, 128 to {maxCanvas} px, aspect within 1:10 to 10:1).",
					{
						height: String(next.height),
						maxCanvas: String(MAX_CANVAS),
						width: String(next.width),
					}
				)
			);
		}
		edit({ ...project, ...next }, "Change canvas size");
	};
	return (
		<>
			<RyuAppField label="Title">
				<Input
					onChange={(event) => edit({ ...project, title: event.target.value })}
					value={project.title}
				/>
			</RyuAppField>
			<RyuAppField label="Format">
				<NativeSelect
					aria-label="Output format"
					onChange={(event) => {
						if (event.target.value === CUSTOM_FORMAT) {
							setCustomOpen(true);
							return;
						}
						const [width, height] = event.target.value.split("x").map(Number);
						if (width && height) {
							setCustomOpen(false);
							edit({ ...project, height, width });
						}
					}}
					value={showCustom ? CUSTOM_FORMAT : format}
				>
					{FORMATS.map(([value, label]) => (
						<NativeSelectOption key={value} value={value}>
							{label}
						</NativeSelectOption>
					))}
					<NativeSelectOption value={CUSTOM_FORMAT}>
						{presetFormat
							? "Custom size…"
							: tl("Custom · {width}×{height}", {
									height: String(project.height),
									width: String(project.width),
								})}
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{showCustom && (
				<div className="grid grid-cols-2 gap-2">
					<NumberField
						label="Canvas width (px)"
						max={MAX_CANVAS}
						min={128}
						onChange={(width) => resize(width, project.height)}
						step={2}
						value={project.width}
					/>
					<NumberField
						label="Canvas height (px)"
						max={MAX_CANVAS}
						min={128}
						onChange={(height) => resize(project.width, height)}
						step={2}
						value={project.height}
					/>
				</div>
			)}
			<RyuAppField label="Frame rate">
				<NativeSelect
					aria-label="Frame rate"
					onChange={(event) =>
						edit({
							...project,
							fps: projectSchema.shape.fps.parse(Number(event.target.value)),
						})
					}
					value={project.fps}
				>
					{PROJECT_FRAME_RATES.map((fps) => (
						<NativeSelectOption key={fps} value={fps}>
							{frameRateLabel(fps)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Video codec">
				<NativeSelect
					aria-label="Video codec"
					onChange={(event) =>
						edit({
							...project,
							exportCodec: projectSchema.shape.exportCodec.parse(
								event.target.value
							),
						})
					}
					value={project.exportCodec}
				>
					<NativeSelectOption value="h264">H.264 · MP4</NativeSelectOption>
					<NativeSelectOption value="h265">H.265 · HEVC</NativeSelectOption>
					<NativeSelectOption value="h265-10bit">
						H.265 10-bit · HEVC
					</NativeSelectOption>
					<NativeSelectOption value="prores">
						ProRes 422 · MOV
					</NativeSelectOption>
					<NativeSelectOption value="prores-4444">
						ProRes 4444 · MOV
					</NativeSelectOption>
					<NativeSelectOption value="vp9">VP9 · WebM</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Export preset">
				<NativeSelect
					aria-label="Export preset"
					onChange={(event) =>
						edit({
							...project,
							exportPreset: projectSchema.shape.exportPreset.parse(
								event.target.value
							),
						})
					}
					value={project.exportPreset}
				>
					<NativeSelectOption value="master">
						Master · high quality
					</NativeSelectOption>
					<NativeSelectOption value="review">
						Review · smaller file
					</NativeSelectOption>
					<NativeSelectOption value="social">
						Social · balanced
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Visual style">
				<NativeSelect
					aria-label="Visual style"
					onChange={(event) =>
						edit({
							...project,
							styleProfile: projectSchema.shape.styleProfile.parse(
								event.target.value
							),
						})
					}
					value={project.styleProfile}
				>
					{styleProfileOptions().map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<small>{styleProfileConfig(project.styleProfile).description}</small>
			</RyuAppField>
			<Button
				onClick={() => downloadJson(project, `${project.title}.json`)}
				variant="outline"
			>
				Download project JSON
			</Button>
			<Button
				disabled={busy}
				onClick={() => void downloadInterchange(runtime, "fcpxml")}
				variant="outline"
			>
				Download FCPXML
			</Button>
			<Button
				disabled={busy}
				onClick={() => void downloadInterchange(runtime, "xmeml")}
				variant="outline"
			>
				Download Premiere XML
			</Button>
			<Button
				disabled={busy}
				onClick={() => void downloadInterchange(runtime, "otio")}
				variant="outline"
			>
				Download OpenTimelineIO
			</Button>
			<Button
				onClick={() =>
					void request(z.json(), `/projects/${project.id}/package`)
						.then((bundle) => {
							downloadJson(bundle, `${project.title}.ryu-video-package.json`);
							setStatus("Production package downloaded.");
						})
						.catch((error) => setStatus(message(error)))
				}
				variant="outline"
			>
				Download production package
			</Button>
			<Button
				disabled={busy}
				onClick={() => void downloadProjectArchive(runtime)}
				title="A ZIP with the project and every media file it uses, to open on another node"
				variant="outline"
			>
				Download project archive
			</Button>
			<input
				accept=".json,application/json,.zip,application/zip"
				hidden
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) {
						void importPackage(runtime, file).catch((error) =>
							setStatus(message(error))
						);
					}
					event.target.value = "";
				}}
				ref={packagePicker}
				type="file"
			/>
			<Button onClick={() => packagePicker.current?.click()} variant="outline">
				Import package or archive
			</Button>
		</>
	);
}
