import {
	RyuAppActions,
	RyuAppEmpty,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
	type Asset,
	assetSchema,
	projectSchema,
} from "../../../shared/project.ts";
import {
	type TemplateSummary,
	templateAdjustmentSchema,
	templateAssignmentSchema,
	templateSummarySchema,
	templatesResponseSchema,
} from "../../../shared/templates.ts";
import { request, studioResponseSchema } from "../bridge.ts";
import { useEditor } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import { resetHistory } from "../editor/project-actions.ts";
import type { PanelTab } from "./types.ts";

/** Templates have their own library tab. */
export const templatesPanelTab: PanelTab | null = {
	label: "Templates",
	value: "templates",
};

const savedTemplateSchema = z.object({
	project: projectSchema,
	template: templateSummarySchema,
});

const instanceResponseSchema = z.object({
	adjustments: z.array(templateAdjustmentSchema),
	assignments: z.array(templateAssignmentSchema),
	createdAssets: z.array(assetSchema),
	project: projectSchema,
	unfilledSlotIds: z.array(z.string()),
	unusedAssetIds: z.array(z.string()),
});
export type TemplateInstance = z.infer<typeof instanceResponseSchema>;

/** Add `id` to the end of the pick order, or remove it when already picked. */
export function togglePicked(picked: readonly string[], id: string): string[] {
	return picked.includes(id)
		? picked.filter((item) => item !== id)
		: [...picked, id];
}

/** `12.5 s` style length for template cards. */
export function formatTemplateSeconds(seconds: number): string {
	return `${Math.round(seconds * 10) / 10} s`;
}

/** One status line describing how a template was filled. */
export function instanceStatus(
	result: Pick<
		TemplateInstance,
		"adjustments" | "assignments" | "unfilledSlotIds" | "unusedAssetIds"
	>,
	title: string
): string {
	const total = result.assignments.length + result.unfilledSlotIds.length;
	const parts = [
		`Created "${title}" with ${result.assignments.length} of ${total} slots filled.`,
	];
	if (result.unfilledSlotIds.length > 0) {
		parts.push(
			`${result.unfilledSlotIds.length} kept their placeholder; replace them on the timeline.`
		);
	}
	if (result.unusedAssetIds.length > 0) {
		parts.push(`${result.unusedAssetIds.length} media items were not used.`);
	}
	const retimed = result.adjustments.filter(
		(item) => item.change === "retimed"
	).length;
	if (retimed > 0) {
		parts.push(`${retimed} short clips were slowed to fill their slot.`);
	}
	const short = result.adjustments.filter(
		(item) => item.change === "short"
	).length;
	if (short > 0) {
		parts.push(`${short} clips are shorter than their slot.`);
	}
	return parts.join(" ");
}

/** Media that can fill a slot: library sources, never preview proxies. */
export const pickableAssets = (assets: readonly Asset[]) =>
	assets.filter((asset) => asset.derivation !== "proxy");

/** Saved and built-in project templates: save the selection, or start from one. */
export function TemplatesPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const { assets, busy, project, projects, selectedIds } = runtime;
	const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
	const [error, setError] = useState("");
	const [chosenId, setChosenId] = useState<string | null>(null);
	const [picked, setPicked] = useState<string[]>([]);
	const [music, setMusic] = useState(true);
	const [title, setTitle] = useState("");
	const [templateTitle, setTemplateTitle] = useState("");
	const [reload, setReload] = useState(0);
	const libraryStamp = projects
		.map((item) => `${item.id}:${item.revision}`)
		.join(",");

	useEffect(() => {
		let mounted = true;
		request(templatesResponseSchema, "/templates")
			.then((result) => {
				if (mounted) {
					setTemplates(result.templates);
					setError("");
				}
			})
			.catch((reason: unknown) => {
				if (mounted) {
					setError(message(reason));
				}
			});
		return () => {
			mounted = false;
		};
		// Reload when the project library changes or a template is saved.
	}, [libraryStamp, reload]);

	const chosen = templates?.find((item) => item.id === chosenId);
	const media = pickableAssets(assets);

	const saveTemplate = () =>
		runtime.act(async () => {
			const saved = await runtime.ensureSaved();
			if (!saved || selectedIds.length === 0) {
				return;
			}
			const name = templateTitle.trim();
			const result = savedTemplateSchema.parse(
				await request(
					studioResponseSchema,
					`/projects/${saved.id}/save-template`,
					"POST",
					{
						slots: selectedIds.map((segmentId) => ({ segmentId })),
						revision: saved.revision,
						...(name ? { title: name } : {}),
					}
				)
			);
			runtime.setProjects((current) => [...current, result.project]);
			setTemplateTitle("");
			setReload((value) => value + 1);
			runtime.setStatus(
				tl('Saved "{title}" with {slotCount} slots.', {
					title: result.template.title,
					slotCount: String(result.template.slots.length),
				})
			);
		});

	const instantiate = (template: TemplateSummary) =>
		runtime.act(async () => {
			if (runtime.dirty) {
				await runtime.save();
			}
			const name = title.trim();
			const result = instanceResponseSchema.parse(
				await request(studioResponseSchema, "/template-instances", "POST", {
					templateId: template.id,
					assetIds: picked,
					...(name ? { title: name } : {}),
					...(template.builtIn ? { music } : {}),
				})
			);
			if (result.createdAssets.length > 0) {
				runtime.setAssets((current) => [
					...result.createdAssets,
					...current.filter(
						(item) =>
							!result.createdAssets.some((created) => created.id === item.id)
					),
				]);
			}
			runtime.setProjects((current) => [result.project, ...current]);
			runtime.setProject(result.project);
			runtime.setSelected(null);
			resetHistory(runtime);
			runtime.setTime(0);
			runtime.setPlaying(false);
			runtime.setDirty(false);
			setPicked([]);
			setTitle("");
			runtime.setStatus(instanceStatus(result, result.project.title));
		});

	// The fill form opens under the template it fills.
	const fillForm = chosen ? (
		<div
			aria-label={tl("Fill {template}", { template: chosen.title })}
			className="flex flex-col gap-2 rounded-md border p-3"
			role="group"
		>
			<p className="font-medium text-sm">Slots</p>
			<ol className="flex flex-col gap-1 text-sm">
				{chosen.slots.map((slot, index) => (
					<li className="flex justify-between gap-2" key={slot.id}>
						<span>
							{index + 1}. {slot.label}
						</span>
						<span className="text-muted-foreground text-xs">
							{slot.kind} · {formatTemplateSeconds(slot.duration)}
						</span>
					</li>
				))}
			</ol>
			<p className="text-muted-foreground text-xs">
				Pick media in the order it should fill the slots. Stills hold for their
				slot; video is trimmed to fit.
			</p>
			{media.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					Import media first; empty slots keep their placeholder.
				</p>
			) : (
				<ul aria-label="Template media" className="flex flex-col gap-1">
					{media.map((asset) => {
						const order = picked.indexOf(asset.id);
						return (
							<li className="flex min-w-0 items-center gap-2" key={asset.id}>
								<Checkbox
									aria-label={tl("Use {asset}", { asset: asset.name })}
									checked={order >= 0}
									onCheckedChange={() =>
										setPicked((current) => togglePicked(current, asset.id))
									}
								/>
								<span className="truncate text-sm">{asset.name}</span>
								<span className="text-muted-foreground text-xs">
									{order >= 0 ? `#${order + 1}` : asset.kind}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{chosen.builtIn && (
				<label className="flex items-center gap-2 text-sm">
					<Checkbox
						aria-label="Generate music"
						checked={music}
						onCheckedChange={(checked) => setMusic(checked === true)}
					/>
					Generate a local music bed (an audio pick replaces it)
				</label>
			)}
			<RyuAppField label="Project title">
				<Input
					aria-label="New project title"
					maxLength={200}
					onChange={(event) => setTitle(event.target.value)}
					placeholder={chosen.title}
					value={title}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={busy}
					onClick={() => void instantiate(chosen)}
					size="sm"
				>
					Create project
				</Button>
				{picked.length > 0 && (
					<Button onClick={() => setPicked([])} size="sm" variant="ghost">
						Clear picks
					</Button>
				)}
			</RyuAppActions>
		</div>
	) : null;

	return (
		<RyuAppSection title="Templates">
			{project && (
				<div className="flex flex-col gap-2 rounded-md border p-3">
					<p className="font-medium text-sm">Save as template</p>
					<p className="text-muted-foreground text-xs">
						Selected clips become replaceable slots. Titles, effects, timing and
						other clips stay as they are.
					</p>
					<RyuAppField label="Template name">
						<Input
							aria-label="Template name"
							maxLength={200}
							onChange={(event) => setTemplateTitle(event.target.value)}
							placeholder={tl("{project} template", { project: project.title })}
							value={templateTitle}
						/>
					</RyuAppField>
					<RyuAppActions>
						<Button
							disabled={busy || selectedIds.length === 0}
							onClick={() => void saveTemplate()}
							size="sm"
						>
							{tl(
								"{count, plural, one {Save {countText} selected clip as template} other {Save {countText} selected clips as template}}",
								{
									count: selectedIds.length,
									countText: selectedIds.length
										? String(selectedIds.length)
										: "",
								}
							)}
						</Button>
					</RyuAppActions>
				</div>
			)}
			{error && (
				<p className="text-destructive text-sm" role="status">
					{error}
				</p>
			)}
			{templates === null && !error && (
				<p className="text-muted-foreground text-sm">Loading templates…</p>
			)}
			{templates !== null && templates.length === 0 && (
				<RyuAppEmpty
					description="Save clips from a project to make your first template."
					title="No templates"
				/>
			)}
			{templates !== null && templates.length > 0 && (
				<ul aria-label="Templates" className="flex flex-col gap-2">
					{templates.map((template) => {
						const active = template.id === chosenId;
						return (
							<li
								className="flex min-w-0 flex-col gap-1 rounded-md border p-2"
								data-template-id={template.id}
								key={template.id}
							>
								<div className="flex min-w-0 items-center gap-2">
									<span className="truncate font-medium" data-template-title>
										{template.title}
									</span>
									<span className="text-muted-foreground text-xs">
										{template.builtIn ? "Built-in" : "Saved"}
										{template.category ? ` · ${template.category}` : ""}
									</span>
								</div>
								{template.description && (
									<p className="text-muted-foreground text-xs">
										{template.description}
									</p>
								)}
								<span className="text-muted-foreground text-xs">
									{tl("{width} × {height} · {duration} · {slotCount} slots", {
										width: String(template.width),
										height: String(template.height),
										duration: formatTemplateSeconds(template.duration),
										slotCount: String(template.slots.length),
									})}
								</span>
								<RyuAppActions>
									<Button
										aria-expanded={active}
										onClick={() => {
											setChosenId(active ? null : template.id);
											setPicked([]);
										}}
										size="sm"
										variant={active ? "secondary" : "outline"}
									>
										{active ? "Close" : "Use template"}
									</Button>
								</RyuAppActions>
								{active && fillForm}
							</li>
						);
					})}
				</ul>
			)}
		</RyuAppSection>
	);
}
