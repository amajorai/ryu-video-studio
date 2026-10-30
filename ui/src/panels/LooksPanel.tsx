import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import { z } from "zod";
import { colorLooks, type LookId } from "../../../shared/color-looks.ts";
import { lookThumbnails } from "../color/look-thumbnail.ts";
import { readLut } from "../color/lut-client.ts";
import { useEditor } from "../editor/context.tsx";
import { NumberField } from "../NumberField.tsx";
import type { PanelTab } from "./types.ts";

/** Looks have their own library tab. */
export const looksPanelTab: PanelTab | null = {
	label: "Looks",
	value: "looks",
};

const frameSchema = z.object({ data: z.string() });

/** Named color looks applied to the selected clips, with graded thumbnails. */
export function LooksPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const { assets, busy, project, selectedIds } = runtime;
	const [intensity, setIntensity] = useState(1);
	const [thumbnails, setThumbnails] = useState<Map<LookId, string> | null>(
		null
	);
	const [previewing, setPreviewing] = useState(false);
	if (!project) {
		return null;
	}
	const targets = project.segments.filter(
		(segment) =>
			selectedIds.includes(segment.id) &&
			assets.find((asset) => asset.id === segment.assetId)?.kind !== "audio"
	);
	const apply = (id: LookId, name: string) =>
		void runtime.routeEdit(
			"color",
			{
				clipIds: targets.slice(0, 8).map((segment) => segment.id),
				look: { id, intensity },
			},
			() =>
				`Applied the ${name} look to ${targets.length === 1 ? "the clip" : `${Math.min(8, targets.length)} clips`}.`
		);
	const preview = async () => {
		setPreviewing(true);
		try {
			// A look replaces the clip's grade (keeping its LUT), so preview it on
			// the frame rendered with the target clips' grades neutralized.
			const ungraded = targets.slice(0, 8).map((segment) => segment.id);
			const query = ungraded.length ? `&ungraded=${ungraded.join(",")}` : "";
			const frame = frameSchema.parse(
				await runtime.api(
					`/projects/${project.id}/inspect-frame?time=${runtime.time.toFixed(3)}${query}`
				)
			);
			const base = targets[0]?.colorGrade;
			const lut = base?.lut
				? await readLut(base.lut.lutId).catch(() => null)
				: null;
			const rendered = await lookThumbnails(
				frame.data,
				colorLooks.map((look) => look.id),
				intensity,
				base ? { grade: base, lut } : undefined
			);
			setThumbnails(rendered);
			if (!rendered) {
				runtime.setStatus("This webview cannot draw look previews.");
			}
		} catch (error) {
			runtime.setStatus(
				error instanceof Error
					? error.message
					: "The look previews could not be rendered."
			);
		} finally {
			setPreviewing(false);
		}
	};
	return (
		<RyuAppField label="Color looks">
			<small>
				{targets.length
					? tl(
							"Applies to {clipCount, plural, one {the selected clip} other {{clipLabel} selected clips}}; each clip keeps its LUT.",
							{
								clipCount: targets.length,
								clipLabel: String(Math.min(8, targets.length)),
							}
						)
					: "Select one or more visual clips to apply a look."}
			</small>
			<div className="studio-inline-fields">
				<NumberField
					label="Look intensity"
					max={1}
					min={0}
					onChange={setIntensity}
					step={0.05}
					value={intensity}
				/>
			</div>
			<RyuAppActions>
				<Button
					disabled={previewing || project.segments.length === 0}
					onClick={() => void preview()}
					size="sm"
					variant="outline"
				>
					{thumbnails ? "Refresh previews" : "Preview looks at the playhead"}
				</Button>
			</RyuAppActions>
			<ul className="grid grid-cols-3 gap-2" data-testid="looks-grid">
				{colorLooks.map((look) => {
					const thumbnail = thumbnails?.get(look.id);
					return (
						<li key={look.id}>
							<button
								aria-label={tl("Apply {name}: {description}", {
									description: look.description,
									name: look.name,
								})}
								className="flex w-full flex-col items-stretch gap-1 rounded-md border p-1 text-left text-xs hover:bg-muted disabled:opacity-50"
								disabled={busy || targets.length === 0}
								onClick={() => apply(look.id, look.name)}
								title={look.description}
								type="button"
							>
								{thumbnail ? (
									<img
										alt=""
										className="aspect-video w-full rounded-sm object-cover"
										height={54}
										src={thumbnail}
										width={96}
									/>
								) : (
									<span
										aria-hidden
										className="aspect-video w-full rounded-sm bg-muted"
									/>
								)}
								<span>{look.name}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</RyuAppField>
	);
}
