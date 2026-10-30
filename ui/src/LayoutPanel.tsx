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
import { useEffect, useState } from "react";
import {
	type Layout,
	type LayoutFit,
	type LayoutOptions,
	layoutFitSchema,
	layoutLabel,
	layoutRange,
	layoutSchema,
} from "../../shared/layouts.ts";
import type { Asset, Project } from "../../shared/project.ts";

export function LayoutPanel({
	assets,
	busy,
	onApply,
	project,
}: {
	assets: Asset[];
	busy: boolean;
	/**
	 * Applies the layout. `options` carries the fit choice and the library
	 * assets (for the fill crop); pass it to `applyLayout`.
	 */
	onApply: (
		layout: Layout,
		segmentIds: string[],
		options: LayoutOptions
	) => void;
	project: Project;
}) {
	const tl = useLiteralMessages();
	const [layout, setLayout] = useState<Layout>("side-by-side");
	const [segmentIds, setSegmentIds] = useState<string[]>([]);
	const [fit, setFit] = useState<LayoutFit | "keep">("keep");
	const visualSegments = project.segments.filter(
		(segment) =>
			assets.find((asset) => asset.id === segment.assetId)?.kind !== "audio"
	);
	useEffect(() => {
		setSegmentIds((current) =>
			current.filter((id) =>
				project.segments.some(
					(segment) =>
						segment.id === id &&
						assets.find((asset) => asset.id === segment.assetId)?.kind !==
							"audio"
				)
			)
		);
	}, [project.id, project.segments, assets]);
	const range = layoutRange(layout);
	const valid =
		segmentIds.length >= range.min && segmentIds.length <= range.max;
	return (
		<RyuAppSection title="Layouts">
			<p>
				Place selected visual clips into a bounded composition. Selection order
				controls the slot order; applying a layout replaces their position and
				scale keyframes. Inset clips need a higher track than the main clip to
				draw on top.
			</p>
			<RyuAppField label="Layout preset">
				<NativeSelect
					aria-label="Layout preset"
					disabled={busy}
					onChange={(event) =>
						setLayout(layoutSchema.parse(event.target.value))
					}
					value={layout}
				>
					{layoutSchema.options.map((value) => (
						<NativeSelectOption key={value} value={value}>
							{layoutLabel(value)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Cell framing">
				<NativeSelect
					aria-label="Cell framing"
					disabled={busy}
					onChange={(event) =>
						setFit(
							event.target.value === "keep"
								? "keep"
								: layoutFitSchema.parse(event.target.value)
						)
					}
					value={fit}
				>
					<NativeSelectOption value="keep">
						Keep each clip's framing
					</NativeSelectOption>
					<NativeSelectOption value="fit">
						Fit (letterbox in the cell)
					</NativeSelectOption>
					<NativeSelectOption value="fill">
						Fill (crop to cover the cell)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{fit === "fill" && (
				<small>
					Fill replaces each clip's crop with a centred crop for its cell.
					Choosing Fit later removes that crop.
				</small>
			)}
			<RyuAppField label="Visual clips in slot order">
				{visualSegments.length ? (
					visualSegments.map((segment) => {
						const selected = segmentIds.includes(segment.id);
						const order = segmentIds.indexOf(segment.id);
						const name =
							assets.find((asset) => asset.id === segment.assetId)?.name ??
							"Media";
						return (
							<Button
								aria-pressed={selected}
								disabled={busy || (!selected && segmentIds.length >= range.max)}
								key={segment.id}
								onClick={() =>
									setSegmentIds((current) =>
										current.includes(segment.id)
											? current.filter((id) => id !== segment.id)
											: [...current, segment.id]
									)
								}
								size="sm"
								variant="outline"
							>
								{selected
									? tl("{position}. {name} · Track {track}", {
											name,
											position: String(order + 1),
											track: String(segment.track + 1),
										})
									: tl("{name} · Track {track}", {
											name,
											track: String(segment.track + 1),
										})}
							</Button>
						);
					})
				) : (
					<small>Add visual clips to the timeline first.</small>
				)}
			</RyuAppField>
			<small>
				{valid
					? tl("{count, plural, one {# clip} other {# clips}} · {layout}", {
							count: segmentIds.length,
							layout: layoutLabel(layout),
						})
					: tl("{layout} needs {clips} visual clips.", {
							clips:
								range.min === range.max
									? String(range.min)
									: `${range.min}–${range.max}`,
							layout: layoutLabel(layout),
						})}
			</small>
			<RyuAppActions>
				<Button
					disabled={busy || !valid}
					onClick={() =>
						onApply(
							layout,
							segmentIds,
							fit === "keep" ? { assets } : { assets, fit }
						)
					}
				>
					Apply layout
				</Button>
			</RyuAppActions>
		</RyuAppSection>
	);
}
