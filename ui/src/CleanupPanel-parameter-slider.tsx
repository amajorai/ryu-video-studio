import { Label } from "@ryu/blocks/companion/controls";
import { Slider } from "@ryu/ui/components/slider.tsx";
import { useId } from "react";

/** A labeled slider with its current value, for VAD parameters. */
export function ParameterSlider({
	disabled,
	format,
	label,
	max,
	min,
	onChange,
	step,
	value,
}: {
	disabled: boolean;
	format: (value: number) => string;
	label: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	step: number;
	value: number;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<Label htmlFor={id}>{label}</Label>
				<output className="font-mono text-xs" htmlFor={id}>
					{format(value)}
				</output>
			</div>
			<Slider
				aria-label={label}
				disabled={disabled}
				id={id}
				max={max}
				min={min}
				onValueChange={(next) => {
					const number = Array.isArray(next) ? next[0] : next;
					if (typeof number === "number" && Number.isFinite(number)) {
						onChange(number);
					}
				}}
				step={step}
				value={[value]}
			/>
		</div>
	);
}
