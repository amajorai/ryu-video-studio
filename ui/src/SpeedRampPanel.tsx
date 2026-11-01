import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Button,
	Switch,
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import { curvePreservesPitch } from "../../shared/schema/speed-curve.ts";
import { curveUnitDuration, hasSpeedCurve } from "../../shared/speed-curve.ts";
import {
	applySpeedCurve,
	bakeSpeedCurve,
	planSpeedRamp,
	removeSpeedCurve,
	resetSpeedRamp,
	SPEED_RAMP_LIMITS,
	type SpeedRampPoint,
	type SpeedRampPreset,
	setSpeedCurvePitch,
	speedRamp,
	speedRampCurve,
	speedRampRippleSchema,
} from "../../shared/speed-ramp.ts";
import { NumberField } from "./NumberField.tsx";
import { SpeedCurveEditor } from "./SpeedCurveEditor.tsx";

type PresetName = Exclude<SpeedRampPreset, "custom">;
type Ripple = "track" | "timeline" | "none";
/** `smooth` keeps one time-remapped clip; `steps` cuts constant-speed clips. */
type RampMode = "smooth" | "steps";

export const SPEED_RAMP_PRESET_LABELS: Record<SpeedRampPreset, string> = {
	bullet: "Bullet time",
	custom: "Custom",
	"flash-in": "Flash in",
	"flash-out": "Flash out",
	hero: "Hero",
	"jump-cut": "Jump cut",
	montage: "Montage",
};
const presetNames = Object.keys(SPEED_RAMP_PRESET_LABELS) as SpeedRampPreset[];
const isPreset = (value: string | undefined): value is SpeedRampPreset =>
	presetNames.some((name) => name === value);

/** Points as y-down SVG coordinates: x is source position, y is log10 speed (0.1×–10×). */
export function speedCurveCoordinates(
	points: readonly SpeedRampPoint[],
	width = 120,
	height = 40
): { x: number; y: number }[] {
	return points.map((point) => ({
		x: point.t * width,
		y: height - ((Math.log10(point.speed) + 1) / 2) * height,
	}));
}

/** SVG polyline points for a preset curve, or for custom points. */
export function speedCurvePath(
	curve: PresetName | readonly SpeedRampPoint[],
	width = 120,
	height = 40
) {
	const points = typeof curve === "string" ? speedRampCurve(curve) : curve;
	return speedCurveCoordinates(
		[...points].sort((a, b) => a.t - b.t),
		width,
		height
	)
		.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
		.join(" ");
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : "The speed ramp failed.";

/** The curve the panel ramps with, or an error message for an invalid custom curve. */
function panelCurve(
	preset: SpeedRampPreset,
	points: readonly SpeedRampPoint[]
): SpeedRampPoint[] | string {
	try {
		return speedRampCurve(preset, points);
	} catch (error) {
		return errorText(error);
	}
}

export function SpeedRampPanel({
	assets,
	busy,
	onEdit,
	onError,
	project,
	segment,
}: {
	assets: readonly Asset[];
	busy: boolean;
	onEdit: (next: Project, status: string) => void;
	onError: (text: string) => void;
	project: Project;
	segment: Segment | undefined;
}) {
	const tl = useLiteralMessages();
	const [preset, setPreset] = useState<SpeedRampPreset>("montage");
	const [customPoints, setCustomPoints] = useState<SpeedRampPoint[]>(() =>
		speedRampCurve("montage").map((point) => ({ ...point }))
	);
	const curve = panelCurve(preset, customPoints);
	const curveError = typeof curve === "string" ? curve : undefined;
	const [steps, setSteps] = useState(12);
	const [mode, setMode] = useState<RampMode>("smooth");
	const [ripple, setRipple] = useState<Ripple>("track");
	const asset = assets.find((candidate) => candidate.id === segment?.assetId);
	const rampable =
		segment !== undefined &&
		(asset?.kind === "video" || asset?.kind === "audio");
	const curved = segment !== undefined && hasSpeedCurve(segment);
	let preview: { after: number; before: number } | undefined;
	if (segment && rampable && typeof curve !== "string") {
		const source = segment.sourceOut - segment.sourceIn;
		try {
			preview = {
				after:
					mode === "smooth"
						? source * curveUnitDuration(curve)
						: planSpeedRamp(source, curve, steps).duration,
				before: segmentDuration(segment),
			};
		} catch {
			preview = undefined;
		}
	}
	const edit = (run: () => Project, status: string) => {
		try {
			onEdit(run(), status);
		} catch (error) {
			onError(errorText(error));
		}
	};
	const apply = () => {
		if (!segment) {
			return;
		}
		const points = preset === "custom" ? { points: customPoints } : {};
		const label = SPEED_RAMP_PRESET_LABELS[preset];
		if (mode === "smooth") {
			edit(
				() =>
					applySpeedCurve(project, assets, {
						clipId: segment.id,
						preset,
						...points,
						revision: project.revision,
						ripple,
					}),
				`${label} speed curve applied as one smooth clip.`
			);
			return;
		}
		edit(
			() =>
				speedRamp(project, assets, {
					clipId: segment.id,
					preset,
					...points,
					revision: project.revision,
					ripple,
					steps,
				}),
			`${label} speed ramp applied in ${steps} steps.`
		);
	};
	const bake = () => {
		if (!segment) {
			return;
		}
		edit(
			() =>
				bakeSpeedCurve(project, assets, {
					clipId: segment.id,
					revision: project.revision,
					ripple,
					steps,
				}),
			`Speed curve baked into ${steps} constant-speed clips.`
		);
	};
	const setPitch = (preservePitch: boolean) => {
		if (!segment) {
			return;
		}
		edit(
			() =>
				setSpeedCurvePitch(project, {
					clipId: segment.id,
					preservePitch,
					revision: project.revision,
				}),
			preservePitch
				? "Speed curve audio keeps its pitch."
				: "Speed curve audio plays tape-style: pitch follows speed."
		);
	};
	const reset = () => {
		if (!segment) {
			return;
		}
		if (curved) {
			edit(
				() =>
					removeSpeedCurve(project, assets, {
						clipId: segment.id,
						revision: project.revision,
						ripple,
					}),
				"Speed curve removed; the clip plays at one constant speed."
			);
			return;
		}
		edit(
			() =>
				resetSpeedRamp(project, assets, {
					clipId: segment.id,
					revision: project.revision,
					ripple,
				}),
			"Speed ramp merged back into one constant-speed clip."
		);
	};
	return (
		<RyuAppSection title="Speed curve">
			<p>
				Change a clip's speed along a curve from 0.1× to 10×. Smooth keeps one
				clip that glides between speeds; Steps cuts it into constant-speed
				clips. Linked audio follows, and the source plays without gaps.
			</p>
			{rampable ? (
				<>
					{curved && (
						<small role="status">
							{tl(
								"This clip plays a smooth speed curve ({count} points). Bake it to clips or reset it to one constant speed.",
								{ count: String(segment.speedCurve?.points.length ?? "") }
							)}
						</small>
					)}
					<RyuAppField label="Ramp">
						<ToggleGroup
							aria-label="Speed curve mode"
							disabled={busy}
							onValueChange={(values: string[]) => {
								const next = values[0];
								if (next === "smooth" || next === "steps") {
									setMode(next);
								}
							}}
							size="sm"
							spacing={1}
							value={[mode]}
							variant="outline"
						>
							<ToggleGroupItem value="smooth">Smooth</ToggleGroupItem>
							<ToggleGroupItem value="steps">Steps</ToggleGroupItem>
						</ToggleGroup>
					</RyuAppField>
					<RyuAppField label="Curve">
						<ToggleGroup
							aria-label="Speed ramp curve"
							className="flex-wrap"
							disabled={busy}
							onValueChange={(values: string[]) => {
								const next = values[0];
								if (!isPreset(next)) {
									return;
								}
								if (next === "custom" && preset !== "custom") {
									// Start the custom curve from the curve on screen.
									setCustomPoints(
										speedRampCurve(preset).map((point) => ({ ...point }))
									);
								}
								setPreset(next);
							}}
							size="sm"
							spacing={1}
							value={[preset]}
							variant="outline"
						>
							{presetNames.map((name) => (
								<ToggleGroupItem key={name} value={name}>
									{SPEED_RAMP_PRESET_LABELS[name]}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</RyuAppField>
					{preset === "custom" ? (
						<SpeedCurveEditor
							disabled={busy}
							limits={SPEED_RAMP_LIMITS}
							onChange={setCustomPoints}
							points={customPoints}
						/>
					) : (
						<svg
							aria-label={tl("{preset} speed curve from 0.1× to 10×", {
								preset: SPEED_RAMP_PRESET_LABELS[preset],
							})}
							className="studio-speed-curve"
							role="img"
							viewBox="0 0 120 40"
						>
							<line
								className="studio-speed-curve-baseline"
								x1="0"
								x2="120"
								y1="20"
								y2="20"
							/>
							<polyline
								className="studio-speed-curve-line"
								points={speedCurvePath(preset)}
							/>
						</svg>
					)}
					{curveError && <small role="alert">{curveError}</small>}
					{curved && (
						<RyuAppField label="Preserve pitch">
							<Switch
								aria-label="Preserve pitch on the speed curve"
								checked={curvePreservesPitch(segment.speedCurve)}
								disabled={busy}
								onCheckedChange={setPitch}
							/>
							<small>
								Off plays the curve tape-style: audio rises in pitch as it
								speeds up and falls as it slows down.
							</small>
						</RyuAppField>
					)}
					{(mode === "steps" || curved) && (
						<NumberField
							label="Ramp steps"
							max={24}
							min={4}
							onChange={(value) => setSteps(Math.round(value))}
							step={1}
							value={steps}
						/>
					)}
					<RyuAppField label="Later clips">
						<NativeSelect
							aria-label="Speed ramp ripple"
							disabled={busy}
							onChange={(event) =>
								setRipple(speedRampRippleSchema.parse(event.target.value))
							}
							value={ripple}
						>
							<NativeSelectOption value="track">
								Shift later clips on this track
							</NativeSelectOption>
							<NativeSelectOption value="timeline">
								Shift everything later
							</NativeSelectOption>
							<NativeSelectOption value="none">
								Do not shift (refuse overlaps)
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					{preview && (
						<small className="font-mono">
							{preview.before.toFixed(2)}s → {preview.after.toFixed(2)}s
						</small>
					)}
					<RyuAppActions>
						<Button disabled={busy || Boolean(curveError)} onClick={apply}>
							{mode === "smooth" ? "Apply speed curve" : "Apply speed ramp"}
						</Button>
						{curved && (
							<Button disabled={busy} onClick={bake} variant="outline">
								Bake to clips
							</Button>
						)}
						<Button disabled={busy} onClick={reset} variant="outline">
							Reset to constant
						</Button>
					</RyuAppActions>
				</>
			) : (
				<small>Select a video or audio clip on the timeline.</small>
			)}
		</RyuAppSection>
	);
}
