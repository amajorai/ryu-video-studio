import { RyuAppActions, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { type KeyboardEvent, useState } from "react";
import {
	copyKeyframes,
	pasteKeyframes,
} from "../../../../shared/keyframe-clipboard.ts";
import { type Keyframe, segmentDuration } from "../../../../shared/project.ts";
import {
	keyframeInterpolationSchema,
	keyframePropertySchema,
	keyframeValueBounds,
} from "../../../../shared/schema/keyframe.ts";
import { useEditor } from "../../editor/context.tsx";
import { clock } from "../../editor/format.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";
import {
	addKeyframeAt,
	audioKeyframeProperties,
	interpolationOptions,
	propertyKeyframes,
	setKeyframeClipboard,
	useKeyframeClipboard,
	visualKeyframeProperties,
	withBezierControl,
	withInterpolation,
} from "./keyframe-list.ts";

type KeyframeProperty = Keyframe["property"];

const bezierFields = [
	{ index: 0, label: "Curve x1", max: 1, min: 0 },
	{ index: 1, label: "Curve y1", max: 2, min: -1 },
	{ index: 2, label: "Curve x2", max: 1, min: 0 },
	{ index: 3, label: "Curve y2", max: 2, min: -1 },
] as const;

/** Input types whose Cmd/Ctrl+C/V belong to the list, not to text editing. */
const nonTextInputTypes = new Set(["button", "checkbox", "radio"]);

/**
 * True for elements that own text copy/paste: text-like inputs, textareas
 * and contenteditable. Selection checkboxes and the interpolation `select`
 * keep the list's keyframe shortcuts.
 */
const editableTarget = (target: EventTarget) => {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (target.isContentEditable || target.tagName === "TEXTAREA") {
		return true;
	}
	return (
		target instanceof HTMLInputElement && !nonTextInputTypes.has(target.type)
	);
};

/** Keyframes of one property on the inspected clip, with curves and copy/paste. */
export function KeyframesSection({
	onChange,
	onPropertyChange,
	property,
	segment,
	visualControls,
}: ClipSectionProps & {
	onPropertyChange: (property: KeyframeProperty) => void;
	/** The animated property; audio clips without a visualization use volume. */
	property: KeyframeProperty;
}) {
	const { setStatus, setTime, time } = useEditor();
	const tl = useLiteralMessages();
	const copied = useKeyframeClipboard();
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const frames = propertyKeyframes(segment, property);
	const localTime = time - segment.start;
	const insideClip = localTime >= 0 && localTime <= segmentDuration(segment);
	const [min, max] = keyframeValueBounds(property);
	const options = [
		...(visualControls ? visualKeyframeProperties : []),
		...audioKeyframeProperties,
	];
	const selectedIds = frames
		.filter((frame) => selected.has(frame.id))
		.map((frame) => frame.id);

	const copy = () => {
		const payload = copyKeyframes(
			segment,
			selectedIds.length > 0 ? { ids: selectedIds } : { properties: [property] }
		);
		if (payload.items.length === 0) {
			setStatus("Add a keyframe before copying.");
			return;
		}
		setKeyframeClipboard(payload);
		setStatus(
			tl("Copied {count, plural, one {# keyframe} other {# keyframes}}.", {
				count: payload.items.length,
			})
		);
	};

	const paste = () => {
		if (!copied) {
			setStatus("Copy keyframes before pasting.");
			return;
		}
		if (!insideClip) {
			setStatus("Move the playhead inside the clip to paste keyframes.");
			return;
		}
		const result = pasteKeyframes(segment, copied, localTime);
		if (result.pasted === 0) {
			setStatus("No copied keyframe fits this clip at the playhead.");
			return;
		}
		onChange({ keyframes: result.segment.keyframes });
		setStatus(
			result.skipped > 0
				? tl("Pasted {pasted} keyframes; {skipped} did not fit this clip.", {
						pasted: result.pasted,
						skipped: result.skipped,
					})
				: tl("Pasted {count, plural, one {# keyframe} other {# keyframes}}.", {
						count: result.pasted,
					})
		);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			!(event.metaKey || event.ctrlKey) ||
			event.altKey ||
			editableTarget(event.target)
		) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key !== "c" && key !== "v") {
			return;
		}
		// Keep the timeline's clip copy/paste shortcuts out of the list.
		event.preventDefault();
		event.stopPropagation();
		if (key === "c") {
			copy();
		} else {
			paste();
		}
	};

	const toggle = (id: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});

	return (
		<RyuAppSection title="Animation">
			<NativeSelect
				aria-label="Animation property"
				onChange={(event) =>
					onPropertyChange(keyframePropertySchema.parse(event.target.value))
				}
				value={property}
			>
				{options.map((option) => (
					<NativeSelectOption key={option.property} value={option.property}>
						{option.label}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<RyuAppActions>
				<Button
					disabled={!insideClip}
					onClick={() =>
						onChange({ keyframes: addKeyframeAt(segment, property, localTime) })
					}
					size="sm"
					variant="outline"
				>
					Add keyframe
				</Button>
				<Button
					disabled={frames.length === 0}
					onClick={copy}
					size="sm"
					variant="ghost"
				>
					{selectedIds.length > 0
						? tl("Copy {count} selected", { count: selectedIds.length })
						: "Copy keyframes"}
				</Button>
				<Button
					disabled={!(copied && insideClip)}
					onClick={paste}
					size="sm"
					variant="ghost"
				>
					Paste at playhead
				</Button>
			</RyuAppActions>
			<div
				aria-label="Keyframes"
				onKeyDown={onKeyDown}
				role="group"
				tabIndex={-1}
			>
				{frames.map((frame) => (
					<div className="studio-scene" key={frame.id}>
						<Checkbox
							aria-label={tl("Select keyframe at {time}", {
								time: clock(frame.time),
							})}
							checked={selected.has(frame.id)}
							onCheckedChange={() => toggle(frame.id)}
						/>
						<Button
							onClick={() => setTime(segment.start + frame.time)}
							size="sm"
							variant="ghost"
						>
							{clock(frame.time)}
						</Button>
						<NumberField
							label={tl("{property} at {time}s", {
								property: frame.property,
								time: frame.time,
							})}
							max={max}
							min={min}
							onChange={(value) =>
								onChange({
									keyframes: segment.keyframes.map((existing) =>
										existing.id === frame.id ? { ...existing, value } : existing
									),
								})
							}
							value={frame.value}
						/>
						<NativeSelect
							aria-label={tl("Curve after {time}", { time: clock(frame.time) })}
							onChange={(event) =>
								onChange({
									keyframes: withInterpolation(
										segment.keyframes,
										frame.id,
										keyframeInterpolationSchema.parse(event.target.value)
									),
								})
							}
							value={frame.interpolation ?? "linear"}
						>
							{interpolationOptions.map((option) => (
								<NativeSelectOption key={option.kind} value={option.kind}>
									{option.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
						{frame.bezier &&
							bezierFields.map((field) => (
								<NumberField
									key={field.index}
									label={tl("{label} at {time}s", {
										label: tl(field.label),
										time: frame.time,
									})}
									max={field.max}
									min={field.min}
									onChange={(value) =>
										onChange({
											keyframes: withBezierControl(
												segment.keyframes,
												frame.id,
												field.index,
												value
											),
										})
									}
									step={0.01}
									value={frame.bezier?.[field.index] ?? 0}
								/>
							))}
						<Button
							onClick={() =>
								onChange({
									keyframes: segment.keyframes.filter(
										(existing) => existing.id !== frame.id
									),
								})
							}
							size="sm"
							variant="ghost"
						>
							Remove keyframe
						</Button>
					</div>
				))}
			</div>
		</RyuAppSection>
	);
}
