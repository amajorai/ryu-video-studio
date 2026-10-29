import { CLIP_COLOR_SWATCHES, clipColorName } from "./clip-meta.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";

/**
 * Clip color tag (a left stripe and a light tint) and the clip's label as a
 * chip along the bottom edge. Renaming and recoloring happen in the
 * inspector's label section and the clip context menu.
 */
export function ClipLabel({ segment }: ClipSlotProps) {
	const { color, label } = segment;
	if (!(color || label)) {
		return null;
	}
	const swatch = color ? CLIP_COLOR_SWATCHES[color] : undefined;
	return (
		<>
			{color && swatch ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 border-l-4"
					data-clip-color={color}
					style={{
						backgroundColor: `color-mix(in srgb, ${swatch} 22%, transparent)`,
						borderLeftColor: swatch,
					}}
					title={clipColorName(color)}
				/>
			) : null}
			{label ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute bottom-0 left-2 z-[3] max-w-[calc(100%-1rem)] truncate rounded-sm bg-card/85 px-1 text-[0.55rem] text-foreground leading-tight"
					data-clip-label=""
				>
					{label}
				</span>
			) : null}
		</>
	);
}
