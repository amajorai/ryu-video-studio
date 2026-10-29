import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Switch } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import { z } from "zod";
import { OUTPUT_RESOLUTIONS } from "../../../shared/output-resolution.ts";
import { exportCodecSchema } from "../../../shared/project.ts";
import { PUBLISH_PRESETS } from "../../../shared/publish-presets.ts";
import {
	encoderPresetSchema,
	exportContainerSchema,
	rateControlSchema,
} from "../../../shared/schema/export.ts";
import { download, mediaBlob, request } from "../bridge.ts";
import { exportVideo } from "../editor/actions/export.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { useEditorStore } from "../editor/store.ts";
import {
	alphaApplies,
	CODEC_OPTIONS,
	CONTAINER_OPTIONS,
	capabilityGap,
	codecApplies,
	type ExportCapabilities,
	type ExportForm,
	exportCapabilitiesSchema,
	exportFileName,
	exportRequestOf,
	initialExportForm,
	jobFileFormat,
	jobMetadata,
	outputResolutionChoiceOf,
	outputResolutionOptions,
	planSummary,
	previewExport,
	projectExportSettingsOf,
	withOutputResolution,
} from "./export-form.ts";
import { OutpostHandoff } from "./OutpostHandoff.tsx";
import type { PanelTab } from "./types.ts";

/**
 * The export form mounts in the Exports category, above the export history
 * it feeds, so it declares no tab of its own.
 */
export const exportPanelTab: PanelTab | null = null;

const outputResolutionChoiceSchema = z.enum([
	"",
	...OUTPUT_RESOLUTIONS,
	"custom",
]);

const optionalNumber = (value: string): number | undefined => {
	const parsed = z.coerce.number().int().safeParse(value);
	return value.trim() && parsed.success ? parsed.data : undefined;
};

function useExportCapabilities(): ExportCapabilities | undefined {
	const [capabilities, setCapabilities] = useState<ExportCapabilities>();
	useEffect(() => {
		let active = true;
		request(exportCapabilitiesSchema, "/capabilities")
			.then((value) => {
				if (active) {
					setCapabilities(value);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);
	return capabilities;
}

/** Export settings form: format, codec, quality, size, range, audio, alpha and presets. */
export function ExportPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { busy, duration, jobs, project, range } = runtime;
	const [form, setForm] = useState<ExportForm>(initialExportForm);
	const exportPreset = useEditorStore(
		runtime.store,
		(state) => state.exportPreset ?? null
	);
	useEffect(() => {
		if (!exportPreset) {
			return;
		}
		setForm((current) => ({ ...current, ...exportPreset }));
		runtime.store.setState({ exportPreset: null });
	}, [exportPreset, runtime.store]);
	const capabilities = useExportCapabilities();
	const update = (patch: Partial<ExportForm>) =>
		setForm((current) => ({ ...current, ...patch }));
	const preview = previewExport(project, form, range, duration);
	const plan = "plan" in preview ? preview.plan : undefined;
	const gap = plan ? capabilityGap(plan, capabilities) : undefined;
	const blocked = "error" in preview ? preview.error : gap;
	const container = plan?.container ?? form.container ?? "mp4";
	const resolutionChoice = outputResolutionChoiceOf(project, form);
	const inheritedSize =
		resolutionChoice === "" &&
		plan !== undefined &&
		(plan.output.width !== project.width ||
			plan.output.height !== project.height);
	const finished = jobs.filter(
		(job) => job.projectId === project.id && job.status === "completed"
	);
	const downloadJob = (jobId: string) =>
		runtime.act(async () => {
			const details = await request(z.json(), `/renders/${jobId}`);
			const format = jobFileFormat(details);
			download(
				await mediaBlob(`/renders/${jobId}/data`, format.mime),
				exportFileName(project.title, format)
			);
			const metadata = jobMetadata(details);
			if (metadata) {
				download(
					new Blob([metadata], { type: "text/plain" }),
					`${exportFileName(project.title, format).replace(/\.[^.]+$/, "")}-metadata.txt`
				);
			}
			runtime.setStatus(
				tl("Downloaded the {label} export.", { label: format.label })
			);
		});
	return (
		<RyuAppSection title="Export">
			<RyuAppField label="Publish preset">
				<NativeSelect
					aria-label="Publish preset"
					onChange={(event) =>
						update({ platformPreset: event.target.value || undefined })
					}
					value={form.platformPreset ?? ""}
				>
					<NativeSelectOption value="">
						{project.exportSettings?.platformPreset
							? "Project default"
							: "None"}
					</NativeSelectOption>
					{PUBLISH_PRESETS.map((preset) => (
						<NativeSelectOption key={preset.id} value={preset.id}>
							{preset.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Format">
				<NativeSelect
					aria-label="Export format"
					onChange={(event) =>
						update({
							container: exportContainerSchema
								.optional()
								.parse(event.target.value || undefined),
						})
					}
					value={form.container ?? ""}
				>
					<NativeSelectOption value="">Project default</NativeSelectOption>
					{CONTAINER_OPTIONS.map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{codecApplies(container) && (
				<RyuAppField label="Video codec">
					<NativeSelect
						aria-label="Export video codec"
						onChange={(event) =>
							update({
								codec: exportCodecSchema
									.optional()
									.parse(event.target.value || undefined),
							})
						}
						value={form.codec ?? ""}
					>
						<NativeSelectOption value="">Project codec</NativeSelectOption>
						{CODEC_OPTIONS.filter((option) => option.value !== "vp9").map(
							(option) => (
								<NativeSelectOption key={option.value} value={option.value}>
									{option.label}
								</NativeSelectOption>
							)
						)}
					</NativeSelect>
				</RyuAppField>
			)}
			{plan?.kind === "video" && !plan.videoCodec?.startsWith("prores") && (
				<>
					<RyuAppField label="Quality">
						<div className="flex flex-wrap items-center gap-2">
							<NativeSelect
								aria-label="Rate control"
								onChange={(event) =>
									update({
										rateControl: rateControlSchema
											.optional()
											.parse(event.target.value || undefined),
									})
								}
								value={form.rateControl ?? ""}
							>
								<NativeSelectOption value="">
									Project default
								</NativeSelectOption>
								<NativeSelectOption value="crf">
									Constant quality (CRF)
								</NativeSelectOption>
								<NativeSelectOption value="vbr">
									Variable bitrate
								</NativeSelectOption>
								<NativeSelectOption value="cbr">
									Constant bitrate
								</NativeSelectOption>
							</NativeSelect>
							{form.rateControl === "crf" && (
								<Input
									aria-label="CRF (lower is higher quality)"
									className="w-20"
									max={51}
									min={0}
									onChange={(event) =>
										update({ crf: optionalNumber(event.target.value) })
									}
									placeholder={String(plan.settings.crf ?? 23)}
									type="number"
									value={form.crf ?? ""}
								/>
							)}
							{(form.rateControl === "cbr" || form.rateControl === "vbr") && (
								<Input
									aria-label="Video bitrate (kbps)"
									className="w-28"
									min={100}
									onChange={(event) =>
										update({ bitrateKbps: optionalNumber(event.target.value) })
									}
									placeholder={String(plan.bitrateKbps ?? "")}
									type="number"
									value={form.bitrateKbps ?? ""}
								/>
							)}
						</div>
					</RyuAppField>
					<RyuAppField label="Encoder speed">
						<NativeSelect
							aria-label="Encoder preset"
							onChange={(event) =>
								update({
									encoderPreset: encoderPresetSchema
										.optional()
										.parse(event.target.value || undefined),
								})
							}
							value={form.encoderPreset ?? ""}
						>
							<NativeSelectOption value="">Project default</NativeSelectOption>
							{encoderPresetSchema.options.map((preset) => (
								<NativeSelectOption key={preset} value={preset}>
									{preset}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
				</>
			)}
			{plan?.kind !== "audio" && plan?.kind !== "gif" && (
				<RyuAppField
					description="Resolutions scale the timeline's short side and keep its aspect. A custom size with a different aspect is letterboxed."
					label="Output resolution"
				>
					<div className="flex flex-wrap items-center gap-2">
						<NativeSelect
							aria-label="Output resolution"
							onChange={(event) =>
								setForm((current) =>
									withOutputResolution(
										project,
										current,
										outputResolutionChoiceSchema.parse(event.target.value),
										plan?.output
									)
								)
							}
							value={resolutionChoice}
						>
							<NativeSelectOption value="">
								{inheritedSize
									? tl("Project default · {width} × {height}", {
											height: String(plan.output.height),
											width: String(plan.output.width),
										})
									: tl("Match timeline · {width} × {height}", {
											height: String(project.height),
											width: String(project.width),
										})}
							</NativeSelectOption>
							{outputResolutionOptions(project).map((option) => (
								<NativeSelectOption
									disabled={option.disabled}
									key={option.value}
									value={option.value}
								>
									{option.label}
								</NativeSelectOption>
							))}
							<NativeSelectOption value="custom">
								Custom size
							</NativeSelectOption>
						</NativeSelect>
						{resolutionChoice === "custom" && (
							<>
								<Input
									aria-label="Output width"
									className="w-24"
									onChange={(event) =>
										update({ outputWidth: optionalNumber(event.target.value) })
									}
									placeholder={String(project.width)}
									step={2}
									type="number"
									value={form.outputWidth ?? ""}
								/>
								<span aria-hidden="true">×</span>
								<Input
									aria-label="Output height"
									className="w-24"
									onChange={(event) =>
										update({ outputHeight: optionalNumber(event.target.value) })
									}
									placeholder={String(project.height)}
									step={2}
									type="number"
									value={form.outputHeight ?? ""}
								/>
							</>
						)}
					</div>
				</RyuAppField>
			)}
			{container === "gif" && (
				<RyuAppField label="GIF frame rate and width">
					<div className="flex items-center gap-2">
						<Input
							aria-label="GIF frame rate"
							className="w-20"
							max={30}
							min={1}
							onChange={(event) =>
								update({ gifFps: optionalNumber(event.target.value) })
							}
							placeholder={String(plan?.gif?.fps ?? 15)}
							type="number"
							value={form.gifFps ?? ""}
						/>
						<Input
							aria-label="GIF width"
							className="w-24"
							max={1920}
							min={64}
							onChange={(event) =>
								update({ gifWidth: optionalNumber(event.target.value) })
							}
							placeholder={String(plan?.gif?.width ?? 640)}
							type="number"
							value={form.gifWidth ?? ""}
						/>
					</div>
				</RyuAppField>
			)}
			<RyuAppField
				description={`In ${clock(range.start)} to Out ${clock(range.end)}`}
				label="Export the I/O range only"
			>
				<Switch
					aria-label="Export the I/O range only"
					checked={form.rangeOnly}
					onCheckedChange={(rangeOnly) => update({ rangeOnly })}
				/>
			</RyuAppField>
			{plan?.kind === "video" && (
				<RyuAppField label="Include audio">
					<Switch
						aria-label="Include audio"
						checked={form.includeAudio ?? plan.includeAudio}
						onCheckedChange={(includeAudio) => update({ includeAudio })}
					/>
				</RyuAppField>
			)}
			{alphaApplies(container) && (
				<RyuAppField
					description="MOV exports ProRes 4444, WebM exports VP9 with alpha; the background is left out."
					label="Transparent background"
				>
					<Switch
						aria-label="Transparent background"
						checked={form.alpha ?? plan?.alpha ?? false}
						onCheckedChange={(alpha) => update({ alpha })}
					/>
				</RyuAppField>
			)}
			{plan?.videoCodec === "h265-10bit" && (
				<RyuAppField
					description="Tags the export as HDR when a source clip is PQ or HLG."
					label="HDR metadata"
				>
					<Switch
						aria-label="HDR metadata"
						checked={form.hdr ?? plan.settings.hdr === "auto"}
						onCheckedChange={(hdr) => update({ hdr })}
					/>
				</RyuAppField>
			)}
			{(plan?.kind === "video" || plan?.kind === "audio") && (
				<RyuAppField label="Save the export to the library">
					<Switch
						aria-label="Save the export to the library"
						checked={form.saveAsAsset}
						onCheckedChange={(saveAsAsset) => update({ saveAsAsset })}
					/>
				</RyuAppField>
			)}
			{plan && (
				<p className="text-muted-foreground text-xs">{planSummary(plan)}</p>
			)}
			{plan?.warnings.map((warning) => (
				<p className="text-xs" key={warning} role="status">
					{warning}
				</p>
			))}
			{blocked && (
				<p className="text-destructive text-xs" role="alert">
					{blocked}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={busy || Boolean(blocked)}
					onClick={() =>
						void exportVideo(runtime, exportRequestOf(project, form, range))
					}
					size="sm"
				>
					Export
				</Button>
				<Button
					disabled={busy}
					onClick={() => {
						runtime.edit(
							{
								...project,
								exportSettings: projectExportSettingsOf(project, form),
							},
							"Export settings"
						);
						runtime.setStatus("Saved these export settings to the project.");
					}}
					size="sm"
					variant="outline"
				>
					Save as project default
				</Button>
			</div>
			{finished.length > 0 && (
				<RyuAppField label="Finished exports">
					<div className="flex flex-col gap-1">
						{finished.map((job) => (
							<Button
								disabled={busy}
								key={job.id}
								onClick={() => void downloadJob(job.id)}
								size="sm"
								variant="outline"
							>
								{tl("Download version {revision} · {codec}", {
									codec: job.codec ?? "file",
									revision: String(job.revision),
								})}
							</Button>
						))}
					</div>
				</RyuAppField>
			)}
			<OutpostHandoff />
		</RyuAppSection>
	);
}
