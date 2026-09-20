import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { Graphic } from "../../shared/project.ts";
import { type StyleProfile, styleProfileConfig } from "../../shared/styles.ts";

export function GraphicsPanel({
	graphics,
	styleProfile,
	time,
	onChange,
}: {
	graphics: Graphic[];
	styleProfile: StyleProfile;
	time: number;
	onChange: (graphics: Graphic[]) => void;
}) {
	const add = () =>
		onChange([
			...graphics,
			{
				animation: "slide-up",
				end: Math.min(7200, time + 3),
				entryDuration: 0.35,
				fill: styleProfileConfig(styleProfile).accent,
				height: 0.18,
				id: crypto.randomUUID(),
				opacity: 0.88,
				shape: "rectangle",
				start: time,
				stroke: "#ffffff",
				strokeWidth: 0,
				width: 0.42,
				x: 0.08,
				y: 0.12,
			},
		]);
	const change = (id: string, patch: Partial<Graphic>) =>
		onChange(
			graphics.map((graphic) =>
				graphic.id === id ? { ...graphic, ...patch } : graphic
			)
		);
	return (
		<RyuAppSection title="Vector graphics">
			<RyuAppActions>
				<Button disabled={time > 7199} onClick={add} variant="outline">
					Add vector shape
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground">
				Create bounded rectangle, ellipse, triangle, and line layers that stay
				editable in the saved project and render locally.
			</p>
			{graphics.map((graphic, index) => (
				<div className="studio-scene" key={graphic.id}>
					<strong>Vector shape {index + 1}</strong>
					<RyuAppField label="Shape">
						<NativeSelect
							aria-label={`Vector shape ${index + 1} shape`}
							onChange={(event) =>
								change(graphic.id, {
									shape: event.target.value as Graphic["shape"],
								})
							}
							value={graphic.shape}
						>
							<NativeSelectOption value="rectangle">
								Rectangle
							</NativeSelectOption>
							<NativeSelectOption value="ellipse">Ellipse</NativeSelectOption>
							<NativeSelectOption value="triangle">Triangle</NativeSelectOption>
							<NativeSelectOption value="line">Line</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Left", 0, 1],
							["y", "Top", 0, 1],
							["width", "Width", 0.02, 1],
							["height", "Height", 0.02, 1],
							["opacity", "Opacity", 0, 1],
							["entryDuration", "Entry duration", 0, 10],
						] as const
					).map(([key, label, min, max]) => (
						<RyuAppField key={key} label={label}>
							<Input
								aria-label={`Graphic ${index + 1} ${label}`}
								defaultValue={graphic[key]}
								key={graphic[key]}
								max={max}
								min={min}
								onBlur={(event) => {
									const value = Number(event.target.value);
									if (Number.isFinite(value) && value >= min && value <= max) {
										change(graphic.id, { [key]: value });
									} else {
										event.target.value = String(graphic[key]);
									}
								}}
								step={0.01}
								type="number"
							/>
						</RyuAppField>
					))}
					<RyuAppField label="Fill color">
						<ColorPickerPopover
							onValueChange={(value) => change(graphic.id, { fill: value })}
							triggerAriaLabel={`Graphic ${index + 1} fill color`}
							triggerClassName="w-full justify-start"
							value={graphic.fill}
						/>
					</RyuAppField>
					<RyuAppField label="Stroke color">
						<ColorPickerPopover
							onValueChange={(value) => change(graphic.id, { stroke: value })}
							triggerAriaLabel={`Vector shape ${index + 1} stroke color`}
							triggerClassName="w-full justify-start"
							value={graphic.stroke}
						/>
					</RyuAppField>
					<RyuAppField label="Stroke width">
						<Input
							aria-label={`Vector shape ${index + 1} stroke width`}
							defaultValue={graphic.strokeWidth}
							key={graphic.strokeWidth}
							max={0.08}
							min={0}
							onBlur={(event) => {
								const value = Number(event.target.value);
								if (Number.isFinite(value) && value >= 0 && value <= 0.08) {
									change(graphic.id, { strokeWidth: value });
								} else {
									event.target.value = String(graphic.strokeWidth);
								}
							}}
							step={0.005}
							type="number"
						/>
					</RyuAppField>
					<RyuAppField label="Entry animation">
						<NativeSelect
							aria-label={`Graphic ${index + 1} entry animation`}
							onChange={(event) =>
								change(graphic.id, {
									animation: event.target.value as Graphic["animation"],
								})
							}
							value={graphic.animation}
						>
							<NativeSelectOption value="none">None</NativeSelectOption>
							<NativeSelectOption value="slide-up">Slide up</NativeSelectOption>
							<NativeSelectOption value="slide-down">
								Slide down
							</NativeSelectOption>
							<NativeSelectOption value="slide-left">
								Slide left
							</NativeSelectOption>
							<NativeSelectOption value="slide-right">
								Slide right
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<Button
						onClick={() =>
							onChange(graphics.filter((item) => item.id !== graphic.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove graphic
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
