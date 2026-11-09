import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	CLIP_COLOR_LABELS,
	CLIP_COLOR_SWATCHES,
	clipColorName,
	clipColorPatch,
	clipLabelPatch,
	MAX_CLIP_LABEL_LENGTH,
} from "../../timeline/clip-meta.ts";
import type { ClipSectionProps } from "../section-props.ts";

/** Clip label and color tag, shown on the timeline clip. */
export function ClipMetaSection({ onChange, segment }: ClipSectionProps) {
	const recolor = (color: (typeof CLIP_COLOR_LABELS)[number] | undefined) => {
		const patch = clipColorPatch(segment, color);
		if (patch) {
			onChange(patch);
		}
	};
	return (
		<RyuAppField label="Label">
			<Input
				aria-label="Clip label"
				defaultValue={segment.label ?? ""}
				key={`${segment.id}:${segment.label ?? ""}`}
				maxLength={MAX_CLIP_LABEL_LENGTH}
				onBlur={(event) => {
					const patch = clipLabelPatch(segment, event.target.value);
					if (patch) {
						onChange(patch);
					}
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					} else if (event.key === "Escape") {
						event.currentTarget.value = segment.label ?? "";
						event.currentTarget.blur();
					}
				}}
				placeholder="Add a label"
			/>
			<div
				aria-label="Clip color"
				className="flex flex-wrap gap-1"
				role="radiogroup"
			>
				<Button
					aria-checked={segment.color === undefined}
					onClick={() => recolor(undefined)}
					role="radio"
					size="xs"
					variant={segment.color === undefined ? "secondary" : "ghost"}
				>
					None
				</Button>
				{CLIP_COLOR_LABELS.map((color) => (
					<Button
						aria-checked={segment.color === color}
						aria-label={clipColorName(color)}
						className="data-[checked=true]:ring-2 data-[checked=true]:ring-ring"
						data-checked={segment.color === color ? "true" : undefined}
						key={color}
						onClick={() => recolor(color)}
						role="radio"
						size="icon-xs"
						style={{ backgroundColor: CLIP_COLOR_SWATCHES[color] }}
						title={clipColorName(color)}
						variant="outline"
					/>
				))}
			</div>
		</RyuAppField>
	);
}
