import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import { type Layout, layoutLabel, layoutRange } from "../../shared/layouts.ts";
import type { Asset, Project } from "../../shared/project.ts";

export function LayoutPanel({
	assets,
	busy,
	onApply,
	project,
}: {
	assets: Asset[];
	busy: boolean;
	onApply: (layout: Layout, segmentIds: string[]) => void;
	project: Project;
}) {
	const [layout, setLayout] = useState<Layout>("side-by-side");
	const [segmentIds, setSegmentIds] = useState<string[]>([]);
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
				scale keyframes.
			</p>
			<RyuAppField label="Layout preset">
				<NativeSelect
					aria-label="Layout preset"
					disabled={busy}
					onChange={(event) => setLayout(event.target.value as Layout)}
					value={layout}
				>
					{(
						[
							["single", "Single frame"],
							["side-by-side", "Side by side"],
							["stacked", "Stacked"],
							["grid-2x2", "2 × 2 grid"],
							["grid-3x3", "3 × 3 grid"],
							["grid-4x4", "4 × 4 grid"],
							["picture-in-picture", "Picture in picture"],
						] as const
					).map(([value, label]) => (
						<NativeSelectOption key={value} value={value}>
							{label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
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
								{selected ? `${order + 1}. ` : ""}
								{name} · Track {segment.track + 1}
							</Button>
						);
					})
				) : (
					<small>Add visual clips to the timeline first.</small>
				)}
			</RyuAppField>
			<small>
				{valid
					? `${segmentIds.length} clip${segmentIds.length === 1 ? "" : "s"} · ${layoutLabel(layout)}`
					: `${layoutLabel(layout)} needs ${range.min === range.max ? range.min : `${range.min}–${range.max}`} visual clips.`}
			</small>
			<RyuAppActions>
				<Button
					disabled={busy || !valid}
					onClick={() => onApply(layout, segmentIds)}
				>
					Apply layout
				</Button>
			</RyuAppActions>
		</RyuAppSection>
	);
}
