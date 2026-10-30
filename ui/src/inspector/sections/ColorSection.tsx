import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";

const GRADE_FIELDS = [
	["exposure", "Exposure", -3, 3],
	["temperature", "Temperature", -1, 1],
	["tint", "Tint", -1, 1],
	["vibrance", "Vibrance", -1, 1],
] as const;

/** Exposure, temperature, tint, and vibrance. */
export function ColorSection({
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	if (!visualControls) {
		return null;
	}
	return (
		<RyuAppField label="Color grade">
			<div className="studio-inline-fields">
				{GRADE_FIELDS.map(([key, label, min, max]) => (
					<NumberField
						key={key}
						label={label}
						max={max}
						min={min}
						onChange={(value) =>
							onChange({ colorGrade: { ...segment.colorGrade, [key]: value } })
						}
						step={0.05}
						value={segment.colorGrade[key]}
					/>
				))}
			</div>
		</RyuAppField>
	);
}
