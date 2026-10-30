import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	addOverlayKeyframe,
	type KeyframeSample,
	type OverlayKeyframeItem,
	removeOverlayKeyframe,
	setOverlayKeyframeInterpolation,
	setOverlayKeyframeValue,
} from "../../../shared/overlay-keyframes.ts";
import {
	isColorKeyframeProperty,
	type KeyframeInterpolation,
	type KeyframeProperty,
	keyframeInterpolationSchema,
} from "../../../shared/schema/keyframe.ts";
import { NumberField } from "../NumberField.tsx";
import { channelLabel } from "./lane-math.ts";

/**
 * Easing from a keyframe to the next. `bezier` needs control points, so the
 * editor only shows it for keyframes that already have a curve (set in the
 * graph editor, by an agent or the project API).
 */
export const easingLabels: Record<KeyframeInterpolation, string> = {
	bezier: "Custom curve",
	"ease-in": "Ease in",
	"ease-in-out": "Ease in and out",
	"ease-out": "Ease out",
	hold: "Hold",
	linear: "Linear",
};
export const panelEasings: readonly KeyframeInterpolation[] = [
	"linear",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"hold",
];

export interface OverlayKeyframesEditorProps<
	Item extends OverlayKeyframeItem,
	Channel extends KeyframeProperty,
> {
	/** The channel range offered for a number keyframe. */
	boundsOf: (property: Channel) => readonly [number, number];
	channels: readonly Channel[];
	/** Help text while the playhead is inside the item. */
	insideHint: string;
	isChannel: (property: string) => property is Channel;
	item: Item;
	/** Overrides of the shared channel names (for example "Left" for x). */
	labels?: Partial<Record<Channel, string>>;
	/** Accessible name prefix, such as "Title 1". */
	name: string;
	onChange: (item: Item) => void;
	/** Help text while the playhead is outside the item. */
	outsideHint: string;
	/** The animated value of a channel at item-relative `elapsed` seconds. */
	sampleAt: (property: Channel, elapsed: number) => KeyframeSample;
	/** Playhead, in timeline seconds. */
	time: number;
}

/**
 * Keyframe authoring for a title or graphic: pick a channel, record its
 * current value at the playhead, then edit each keyframe's value (a color
 * for color channels), easing to the next keyframe, or remove it. The
 * timeline's overlay keyframe lanes drag the same keyframes in time.
 */
export function OverlayKeyframesEditor<
	Item extends OverlayKeyframeItem,
	Channel extends KeyframeProperty,
>({
	boundsOf,
	channels,
	isChannel,
	item,
	labels,
	name,
	insideHint,
	outsideHint,
	onChange,
	sampleAt,
	time,
}: OverlayKeyframesEditorProps<Item, Channel>) {
	const tl = useLiteralMessages();
	const [property, setProperty] = useState<Channel>(channels[0] as Channel);
	const labelOf = (channel: Channel) =>
		labels?.[channel] ?? channelLabel({ property: channel });
	const keyframes = (item.keyframes ?? []).filter((keyframe) =>
		isChannel(keyframe.property)
	);
	const inside = time >= item.start && time <= item.end;
	return (
		<RyuAppField
			description={inside ? insideHint : outsideHint}
			label="Keyframes"
		>
			<div className="flex flex-wrap items-center gap-2">
				<NativeSelect
					aria-label={tl("{itemName} keyframe property", { itemName: name })}
					onChange={(event) => {
						const { value } = event.target;
						if (isChannel(value)) {
							setProperty(value);
						}
					}}
					value={property}
				>
					{channels.map((option) => (
						<NativeSelectOption key={option} value={option}>
							{labelOf(option)}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					disabled={!inside}
					onClick={() =>
						onChange(
							addOverlayKeyframe(
								item,
								property,
								sampleAt(property, time - item.start),
								time,
								crypto.randomUUID(),
								boundsOf(property)
							)
						)
					}
					size="sm"
					variant="outline"
				>
					Add keyframe at playhead
				</Button>
			</div>
			{keyframes.length ? (
				<ul className="mt-2 flex flex-col gap-1">
					{keyframes.map((keyframe) => {
						const channel = keyframe.property as Channel;
						const label = labelOf(channel);
						const easing = keyframe.interpolation ?? "linear";
						const seconds = keyframe.time.toFixed(2);
						const easings =
							easing === "bezier" ? [...panelEasings, easing] : panelEasings;
						const [min, max] = boundsOf(channel);
						return (
							<li
								className="flex flex-wrap items-center gap-2"
								data-overlay-keyframe={keyframe.id}
								key={keyframe.id}
							>
								<span className="min-w-24 flex-1 text-muted-foreground text-xs">
									{tl("{channelName} at +{seconds}s", {
										channelName: label,
										seconds,
									})}
								</span>
								{isColorKeyframeProperty(channel) ? (
									<ColorPickerPopover
										onValueChange={(color) =>
											onChange(
												setOverlayKeyframeValue(item, keyframe.id, { color })
											)
										}
										triggerAriaLabel={tl(
											"{itemName} {channelName} keyframe at {seconds} seconds, color",
											{ channelName: label, itemName: name, seconds }
										)}
										value={keyframe.color ?? "#ffffff"}
									/>
								) : (
									<NumberField
										ariaLabel={tl(
											"{itemName} {channelName} keyframe at {seconds} seconds, value",
											{ channelName: label, itemName: name, seconds }
										)}
										className="w-24"
										label="Value"
										max={max}
										min={min}
										onChange={(next) =>
											onChange(
												setOverlayKeyframeValue(
													item,
													keyframe.id,
													{ value: next },
													[min, max]
												)
											)
										}
										step={max - min > 10 ? 1 : 0.01}
										value={keyframe.value ?? min}
									/>
								)}
								<NativeSelect
									aria-label={tl(
										"{channelName} keyframe at {seconds} seconds, easing to the next keyframe",
										{ channelName: label, seconds }
									)}
									onChange={(event) => {
										const next = keyframeInterpolationSchema.safeParse(
											event.target.value
										);
										if (next.success) {
											onChange(
												setOverlayKeyframeInterpolation(
													item,
													keyframe.id,
													next.data
												)
											);
										}
									}}
									size="sm"
									value={easing}
								>
									{easings.map((option) => (
										<NativeSelectOption key={option} value={option}>
											{easingLabels[option]}
										</NativeSelectOption>
									))}
								</NativeSelect>
								<Button
									aria-label={tl(
										"Remove {channelName} keyframe at {seconds} seconds",
										{ channelName: label, seconds }
									)}
									onClick={() =>
										onChange(removeOverlayKeyframe(item, keyframe.id))
									}
									size="sm"
									variant="ghost"
								>
									Remove
								</Button>
							</li>
						);
					})}
				</ul>
			) : null}
		</RyuAppField>
	);
}
