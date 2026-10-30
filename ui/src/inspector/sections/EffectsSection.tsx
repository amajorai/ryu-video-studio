import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOptGroup,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Toggle } from "@ryu/ui/components/toggle.tsx";
import {
	type Effect,
	type EffectType,
	effectLabels,
	effectTypeSchema,
	MAX_EFFECT_STACK,
	RELIGHT_PRESETS,
	relightParams,
	relightPresetLabels,
	relightPresetSchema,
	seededEffectTypes,
	temporalEffectTypes,
} from "../../../../shared/effects.ts";
import { type Segment, segmentSchema } from "../../../../shared/project.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";

const ENTRY_TRANSITIONS = [
	["none", "None"],
	["crossfade", "Crossfade"],
	["zoom-in", "Zoom in"],
	["zoom-out", "Zoom out"],
	["slide-left", "Slide left"],
	["slide-right", "Slide right"],
	["slide-up", "Slide up"],
	["slide-down", "Slide down"],
] as const;

/** The library, grouped for the "Add effect" menu. */
export const EFFECT_GROUPS: readonly (readonly [string, EffectType[]])[] = [
	["Basic", ["blur", "sharpen", "grayscale", "sepia", "vignette", "invert"]],
	[
		"Clean up",
		["denoise", "clarity", "dehaze", "skin-smooth", "relight", "letterbox"],
	],
	["Light", ["glow", "light-leak", "grain", "hue-cycle"]],
	[
		"Stylize",
		["rgb-split", "glitch", "mosaic", "mirror", "edge-detect", "shake"],
	],
	["Motion", ["motion-blur", "echo"]],
];

/** A new effect at full strength, with an id so its amount can be keyframed. */
export function newEffect(type: EffectType): Effect {
	return { amount: 1, enabled: true, id: crypto.randomUUID(), type };
}

/**
 * Patch that removes the effects at `indexes`, dropping `effectAmount`
 * keyframes that targeted them (a dangling target is invalid).
 */
export function removeEffectsPatch(
	segment: Segment,
	indexes: ReadonlySet<number>
): Partial<Segment> {
	const removedIds = new Set(
		segment.effects
			.filter((_, index) => indexes.has(index))
			.flatMap((effect) => (effect.id ? [effect.id] : []))
	);
	const effects = segment.effects.filter((_, index) => !indexes.has(index));
	const keyframes = segment.keyframes.filter(
		(frame) =>
			!(
				frame.property === "effectAmount" &&
				frame.target !== undefined &&
				removedIds.has(frame.target)
			)
	);
	return keyframes.length === segment.keyframes.length
		? { effects }
		: { effects, keyframes };
}

/** Patch that swaps the effect at `index` with its neighbour `offset` away. */
export function moveEffectPatch(
	segment: Segment,
	index: number,
	offset: -1 | 1
): Partial<Segment> | null {
	const target = index + offset;
	const current = segment.effects[index];
	const other = segment.effects[target];
	if (!(current && other)) {
		return null;
	}
	const effects = [...segment.effects];
	effects[index] = other;
	effects[target] = current;
	return { effects };
}

const MAX_SEED = 9999;

/**
 * Effect after a seed field edit: blank clears the seed (FFmpeg's own
 * default pattern), a whole number in range sets it, anything else is
 * ignored (undefined).
 */
export function seedEdit(effect: Effect, raw: string): Effect | undefined {
	const text = raw.trim();
	if (text === "") {
		if (effect.seed === undefined) {
			return;
		}
		const { seed: _cleared, ...rest } = effect;
		return rest;
	}
	const seed = Number(text);
	if (
		!Number.isInteger(seed) ||
		seed < 0 ||
		seed > MAX_SEED ||
		seed === effect.seed
	) {
		return;
	}
	return { ...effect, seed };
}

/**
 * Seed input that shows an unset seed as blank ("Default") rather than 0:
 * an unset seed and seed 0 draw different patterns.
 */
function SeedField({
	effect,
	label,
	onEdit,
}: {
	effect: Effect;
	label: string;
	onEdit: (next: Effect) => void;
}) {
	const commit = (raw: string) => {
		const next = seedEdit(effect, raw);
		if (next) {
			onEdit(next);
		}
	};
	return (
		<NumberField
			blank={effect.seed === undefined}
			label={label}
			max={MAX_SEED}
			min={0}
			onChange={(value) => commit(String(Math.round(value)))}
			onClear={() => commit("")}
			placeholder="Default"
			step={1}
			value={effect.seed ?? 0}
		/>
	);
}

interface EffectRowProps {
	count: number;
	effect: Effect;
	index: number;
	onChange: ClipSectionProps["onChange"];
	segment: Segment;
}

function EffectRow({
	count,
	effect,
	index,
	onChange,
	segment,
}: EffectRowProps) {
	const tl = useLiteralMessages();
	const label = tl(effectLabels[effect.type]);
	const replace = (next: Effect) =>
		onChange({
			effects: segment.effects.map((existing, existingIndex) =>
				existingIndex === index ? next : existing
			),
		});
	const update = (patch: Partial<Effect>) => replace({ ...effect, ...patch });
	const move = (offset: -1 | 1) => {
		const patch = moveEffectPatch(segment, index, offset);
		if (patch) {
			onChange(patch);
		}
	};
	return (
		<li className="studio-inline-fields">
			<Toggle
				aria-label={tl("Enable {effect}", { effect: label })}
				onPressedChange={(pressed) => update({ enabled: pressed })}
				pressed={effect.enabled}
				size="sm"
				variant="outline"
			>
				{label}
			</Toggle>
			<NumberField
				label={tl("{effect} amount (%)", { effect: label })}
				max={100}
				min={0}
				onChange={(value) => update({ amount: value / 100 })}
				step={1}
				value={Math.round(effect.amount * 1000) / 10}
			/>
			{seededEffectTypes.has(effect.type) ? (
				<SeedField
					effect={effect}
					label={tl("{effect} seed", { effect: label })}
					onEdit={replace}
				/>
			) : null}
			{effect.type === "relight" ? (
				<RelightControls effect={effect} onEdit={replace} />
			) : null}
			<Button
				aria-label={tl("Move {effect} up", { effect: label })}
				disabled={index === 0}
				onClick={() => move(-1)}
				size="sm"
				variant="ghost"
			>
				Up
			</Button>
			<Button
				aria-label={tl("Move {effect} down", { effect: label })}
				disabled={index === count - 1}
				onClick={() => move(1)}
				size="sm"
				variant="ghost"
			>
				Down
			</Button>
			<Button
				aria-label={tl("Remove {effect} effect", { effect: label })}
				onClick={() => onChange(removeEffectsPatch(segment, new Set([index])))}
				size="sm"
				variant="ghost"
			>
				Remove
			</Button>
			{temporalEffectTypes.has(effect.type) ? (
				<p className="text-muted-foreground text-xs">
					Shown in renders and exports only.
				</p>
			) : null}
		</li>
	);
}

/** Light preset and position of a relight effect. */
function RelightControls({
	effect,
	onEdit,
}: {
	effect: Effect;
	onEdit: (next: Effect) => void;
}) {
	const light = effect.light ?? { preset: "key" as const };
	const resolved = relightParams(effect.light);
	const percent = (value: number) => Math.round(value * 1000) / 10;
	return (
		<>
			<NativeSelect
				aria-label="Relight light"
				onChange={(event) => {
					const preset = relightPresetSchema.safeParse(event.target.value);
					if (preset.success) {
						// A new preset brings its own light position.
						onEdit({ ...effect, light: { preset: preset.data } });
					}
				}}
				value={light.preset}
			>
				{RELIGHT_PRESETS.map((preset) => (
					<NativeSelectOption key={preset} value={preset}>
						{relightPresetLabels[preset]}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<NumberField
				label="Light position X (%)"
				max={100}
				min={0}
				onChange={(value) =>
					onEdit({ ...effect, light: { ...light, x: value / 100 } })
				}
				step={1}
				value={percent(resolved.x)}
			/>
			<NumberField
				label="Light position Y (%)"
				max={100}
				min={0}
				onChange={(value) =>
					onEdit({ ...effect, light: { ...light, y: value / 100 } })
				}
				step={1}
				value={percent(resolved.y)}
			/>
		</>
	);
}

/** Visual effect, effect stack (the effects library), and entry transition. */
export function EffectsSection({
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	const tl = useLiteralMessages();
	if (!visualControls) {
		return null;
	}
	const full = segment.effects.length >= MAX_EFFECT_STACK;
	return (
		<>
			<RyuAppField label="Visual effect">
				<NativeSelect
					aria-label="Visual effect"
					onChange={(event) =>
						onChange({
							visualEffect: segmentSchema.shape.visualEffect.parse(
								event.target.value
							),
						})
					}
					value={segment.visualEffect ?? "none"}
				>
					<NativeSelectOption value="none">Original look</NativeSelectOption>
					<NativeSelectOption value="blur">Soft blur</NativeSelectOption>
					<NativeSelectOption value="grayscale">Grayscale</NativeSelectOption>
					<NativeSelectOption value="sepia">Sepia</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Effect stack">
				<NativeSelect
					aria-label="Add effect"
					disabled={full}
					onChange={(event) => {
						const parsed = effectTypeSchema.safeParse(event.target.value);
						if (parsed.success && !full) {
							onChange({
								effects: [...segment.effects, newEffect(parsed.data)],
							});
						}
					}}
					value=""
				>
					<NativeSelectOption value="">
						{full
							? tl("Stack full ({limit})", { limit: String(MAX_EFFECT_STACK) })
							: "Add effect…"}
					</NativeSelectOption>
					{EFFECT_GROUPS.map(([group, types]) => (
						<NativeSelectOptGroup key={group} label={group}>
							{types.map((type) => (
								<NativeSelectOption key={type} value={type}>
									{effectLabels[type]}
								</NativeSelectOption>
							))}
						</NativeSelectOptGroup>
					))}
				</NativeSelect>
				{segment.effects.length > 0 ? (
					<>
						<ol aria-label="Effects" className="grid gap-2">
							{segment.effects.map((effect, index) => (
								<EffectRow
									count={segment.effects.length}
									effect={effect}
									index={index}
									key={effect.id ?? `${effect.type}-${index}`}
									onChange={onChange}
									segment={segment}
								/>
							))}
						</ol>
						<Button
							onClick={() =>
								onChange(
									removeEffectsPatch(
										segment,
										new Set(segment.effects.map((_, index) => index))
									)
								)
							}
							size="sm"
							variant="ghost"
						>
							Clear effects
						</Button>
					</>
				) : null}
			</RyuAppField>
			<RyuAppField label="Entry transition">
				<NativeSelect
					aria-label="Entry transition"
					onChange={(event) =>
						onChange({
							entryOffset: 0,
							entryTransition: segmentSchema.shape.entryTransition.parse(
								event.target.value
							),
						})
					}
					value={segment.entryTransition}
				>
					{ENTRY_TRANSITIONS.map(([value, label]) => (
						<NativeSelectOption key={value} value={value}>
							{label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			{segment.entryTransition !== "none" && (
				<NumberField
					label="Transition seconds"
					max={30}
					min={0}
					onChange={(value) =>
						onChange({ entryDuration: value, entryOffset: 0 })
					}
					step={0.05}
					value={segment.entryDuration}
				/>
			)}
		</>
	);
}
