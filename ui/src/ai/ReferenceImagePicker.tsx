import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Checkbox, Label } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useId } from "react";
import { MAX_REFERENCE_IMAGES } from "../../../shared/generation.ts";
import type { Asset } from "../../../shared/project.ts";

/** Toggle `id` in an ordered reference list, never exceeding the limit. */
export function toggleReference(
	selected: readonly string[],
	id: string,
	checked: boolean
): string[] {
	if (!checked) {
		return selected.filter((candidate) => candidate !== id);
	}
	if (selected.includes(id) || selected.length >= MAX_REFERENCE_IMAGES) {
		return [...selected];
	}
	return [...selected, id];
}

/** Library still images offered as references, excluding `excludeId`. */
export function referenceCandidates(
	assets: readonly Asset[],
	excludeId?: string
): Asset[] {
	return assets.filter(
		(asset) => asset.kind === "image" && asset.id !== excludeId
	);
}

/** Up to four library images sent with an image request as visual references. */
export function ReferenceImagePicker({
	assets,
	disabled,
	excludeId,
	onChange,
	selected,
}: {
	assets: readonly Asset[];
	disabled?: boolean;
	excludeId?: string;
	onChange: (ids: string[]) => void;
	selected: readonly string[];
}) {
	const tl = useLiteralMessages();
	const baseId = useId();
	const candidates = referenceCandidates(assets, excludeId);
	const full = selected.length >= MAX_REFERENCE_IMAGES;
	return (
		<RyuAppField
			description={
				candidates.length
					? tl(
							"{selectedCount} of {maxCount} selected. References are sent to the image model with your direction.",
							{ maxCount: MAX_REFERENCE_IMAGES, selectedCount: selected.length }
						)
					: "Add still images to the library to use them as references."
			}
			label="Reference images (optional)"
		>
			{candidates.length > 0 && (
				<ul aria-label="Reference images" className="grid gap-1">
					{candidates.map((asset, index) => {
						const checked = selected.includes(asset.id);
						const id = `${baseId}-${index}`;
						return (
							<li className="flex items-center gap-2" key={asset.id}>
								<Checkbox
									checked={checked}
									disabled={disabled || (full && !checked)}
									id={id}
									onCheckedChange={(value) =>
										onChange(
											toggleReference(selected, asset.id, value === true)
										)
									}
								/>
								<Label className="truncate" htmlFor={id}>
									{asset.name}
								</Label>
							</li>
						);
					})}
				</ul>
			)}
		</RyuAppField>
	);
}
