import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { Title } from "../../shared/project.ts";

export function TitlesPanel({
	titles,
	time,
	onChange,
}: {
	titles: Title[];
	time: number;
	onChange: (titles: Title[]) => void;
}) {
	const add = (lower: boolean) =>
		onChange([
			...titles,
			{
				id: crypto.randomUUID(),
				start: time,
				end: Math.min(7200, time + 3),
				text: lower ? "Name · Role" : "Your title",
				x: 0.5,
				y: lower ? 0.8 : 0.5,
				fontSize: lower ? 0.045 : 0.08,
				color: "#ffffff",
				fadeIn: 0.2,
				fadeOut: 0.2,
				animation: "fade",
			},
		]);
	const change = (id: string, patch: Partial<Title>) =>
		onChange(
			titles.map((title) => (title.id === id ? { ...title, ...patch } : title))
		);
	return (
		<RyuAppSection title="Titles and lower thirds">
			<RyuAppActions>
				<Button
					disabled={time > 7199}
					onClick={() => add(false)}
					size="sm"
					variant="outline"
				>
					Add title
				</Button>
				<Button
					disabled={time > 7199}
					onClick={() => add(true)}
					size="sm"
					variant="ghost"
				>
					Add lower third
				</Button>
			</RyuAppActions>
			{titles.map((title, index) => (
				<div className="studio-scene" key={title.id}>
					<Textarea
						aria-label={`Title ${index + 1} text`}
						maxLength={500}
						onChange={(event) => change(title.id, { text: event.target.value })}
						value={title.text}
					/>
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Horizontal position", 0, 1],
							["y", "Vertical position", 0, 1],
							["fontSize", "Text size", 0.02, 0.2],
							["fadeIn", "Fade in", 0, 10],
							["fadeOut", "Fade out", 0, 10],
						] as const
					).map(([key, label, min, max]) => (
						<RyuAppField key={key} label={label}>
							<Input
								aria-label={`Title ${index + 1} ${label}`}
								defaultValue={title[key]}
								key={title[key]}
								max={max}
								min={min}
								onBlur={(event) => {
									const value = Number(event.target.value);
									if (Number.isFinite(value) && value >= min && value <= max) {
										change(title.id, { [key]: value });
									} else {
										event.target.value = String(title[key]);
									}
								}}
								step={0.01}
								type="number"
							/>
						</RyuAppField>
					))}
					<RyuAppField label="Text color">
						<ColorPickerPopover
							onValueChange={(value) => change(title.id, { color: value })}
							triggerAriaLabel={`Title ${index + 1} color`}
							triggerClassName="w-full justify-start"
							value={title.color}
						/>
					</RyuAppField>
					<RyuAppField label="Entry animation">
						<NativeSelect
							aria-label={`Title ${index + 1} entry animation`}
							onChange={(event) =>
								change(title.id, {
									animation: event.target.value as Title["animation"],
								})
							}
							value={title.animation}
						>
							<NativeSelectOption value="fade">Fade</NativeSelectOption>
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
							onChange(titles.filter((item) => item.id !== title.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove title
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
