import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Input } from "@ryu/blocks/companion/controls";
export function NumberField({
	label,
	value,
	onChange,
	min,
	max,
	step = 0.1,
	onFocus,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step?: number;
	onFocus?: () => void;
}) {
	return (
		<RyuAppField label={label}>
			<Input
				aria-label={label}
				defaultValue={Number(value.toFixed(3))}
				key={value}
				max={max}
				min={min}
				onBlur={(e) => {
					const number = Number(e.target.value);
					if (
						Number.isFinite(number) &&
						number >= min &&
						number <= max &&
						number !== value
					) {
						onChange(number);
					} else {
						e.target.value = String(value);
					}
				}}
				onFocus={onFocus}
				step={step}
				type="number"
			/>
		</RyuAppField>
	);
}
