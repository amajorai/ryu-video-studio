import { useState } from "react";
import {
	type HslBand,
	hslBandNameSchema,
} from "../../../shared/schema/color.ts";
import { NumberField } from "../NumberField.tsx";
import { setHslBand } from "./color-controls.ts";

type BandName = HslBand["band"];

const bandSwatches: Record<BandName, string> = {
	aqua: "hsl(180 70% 50%)",
	blue: "hsl(225 70% 55%)",
	green: "hsl(120 60% 45%)",
	magenta: "hsl(310 70% 55%)",
	orange: "hsl(30 85% 55%)",
	purple: "hsl(270 60% 55%)",
	red: "hsl(0 75% 55%)",
	yellow: "hsl(55 85% 55%)",
};

const bandLabel = (band: BandName) =>
	`${band[0]?.toUpperCase()}${band.slice(1)}`;

interface HslBandsProps {
	bands: HslBand[] | undefined;
	/** `undefined` when every band is neutral. */
	onChange: (bands: HslBand[] | undefined) => void;
}

/** Hue, saturation and lightness per color band (one band edited at a time). */
export function HslBands({ bands, onChange }: HslBandsProps) {
	const [active, setActive] = useState<BandName>("red");
	const current = bands?.find((item) => item.band === active);
	const field = (key: "hue" | "saturation" | "lightness", label: string) => (
		<NumberField
			label={`${bandLabel(active)} ${label}`}
			max={1}
			min={-1}
			onChange={(value) =>
				onChange(setHslBand(bands, active, { [key]: value }))
			}
			step={0.05}
			value={current?.[key] ?? 0}
		/>
	);
	return (
		<div className="flex flex-col gap-2">
			<div
				aria-label="HSL band"
				className="flex flex-wrap gap-1"
				role="radiogroup"
			>
				{hslBandNameSchema.options.map((band) => {
					const edited = bands?.some((item) => item.band === band);
					return (
						<button
							aria-checked={active === band}
							aria-label={`${bandLabel(band)}${edited ? " (adjusted)" : ""}`}
							className="relative size-6 rounded-full border-2 aria-checked:border-foreground"
							key={band}
							onClick={() => setActive(band)}
							role="radio"
							style={{ background: bandSwatches[band] }}
							type="button"
						>
							{edited ? (
								<span
									aria-hidden
									className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-foreground"
								/>
							) : null}
						</button>
					);
				})}
			</div>
			<div className="studio-inline-fields">
				{field("hue", "hue")}
				{field("saturation", "saturation")}
				{field("lightness", "lightness")}
			</div>
		</div>
	);
}
