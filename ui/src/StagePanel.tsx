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
import { useState } from "react";
import type { SpatialObject, StageCamera } from "../../shared/project.ts";
import {
	type StageCameraProperty,
	stageCameraPropertySchema,
	stageCameraValueBounds,
} from "../../shared/stage-camera.ts";
import { generateStageWorld } from "../../shared/stage-world.ts";

export function StagePanel({
	objects,
	camera,
	time,
	onChange,
	onCameraChange,
	onWorldChange,
	onWorldPromptChange,
	worldPrompt,
}: {
	camera: StageCamera;
	objects: SpatialObject[];
	worldPrompt: string;
	time: number;
	onChange: (objects: SpatialObject[]) => void;
	onCameraChange: (camera: StageCamera) => void;
	onWorldChange: (world: {
		camera: StageCamera;
		objects: SpatialObject[];
		prompt: string;
	}) => void;
	onWorldPromptChange: (prompt: string) => void;
}) {
	const [cameraProperty, setCameraProperty] =
		useState<StageCameraProperty>("x");
	const [cameraValue, setCameraValue] = useState(0);
	const [cameraPathTime, setCameraPathTime] = useState(time);
	const [worldStatus, setWorldStatus] = useState("");
	const add = () =>
		onChange([
			...objects,
			{
				animation: "float",
				depth: 0.24,
				end: Math.min(7200, time + 4),
				entryDuration: 0.4,
				fill: "#0ea5e9",
				height: 0.24,
				id: crypto.randomUUID(),
				start: time,
				width: 0.3,
				x: 0.1,
				y: -0.05,
				z: 0.35,
			},
		]);
	const change = (id: string, patch: Partial<SpatialObject>) =>
		onChange(
			objects.map((object) =>
				object.id === id ? { ...object, ...patch } : object
			)
		);
	const addCameraKeyframe = () => {
		const bounds = stageCameraValueBounds(cameraProperty);
		const value = Math.max(bounds.min, Math.min(bounds.max, cameraValue));
		const keyframe = {
			id: crypto.randomUUID(),
			property: cameraProperty,
			time: Number(Math.max(0, Math.min(7200, cameraPathTime)).toFixed(3)),
			value,
		};
		const keyframes = [
			...(camera.keyframes ?? []).filter(
				(item) =>
					!(item.property === keyframe.property && item.time === keyframe.time)
			),
			keyframe,
		].sort((left, right) => left.time - right.time);
		onCameraChange({ ...camera, keyframes });
	};
	const generateWorld = () => {
		const world = generateStageWorld(worldPrompt, time);
		onWorldChange(world);
		setWorldStatus(
			`Generated ${world.objects.length} editable blocks with a 12-second camera path.`
		);
	};
	return (
		<RyuAppSection title="3D stage">
			<RyuAppField label="World direction">
				<Input
					aria-label="3D world direction"
					maxLength={400}
					onChange={(event) => {
						onWorldPromptChange(event.target.value);
						setWorldStatus("");
					}}
					placeholder="A coastal mountain village with a river and a beacon"
					value={worldPrompt}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={time > 7188}
					onClick={generateWorld}
					variant="outline"
				>
					Generate local world
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground">
				The prompt creates a bounded, editable world of local depth blocks and a
				shared camera path. It runs on the node without an external renderer.
			</p>
			{worldStatus ? <small>{worldStatus}</small> : null}
			<RyuAppActions>
				<Button disabled={time > 7199} onClick={add} variant="outline">
					Add 3D block
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground">
				Compose local depth objects with perspective faces and a bounded camera
				orbit. The stage is rendered into the same export graph as the timeline.
			</p>
			<div className="studio-scene">
				<strong>Stage camera</strong>
				{(
					[
						["x", "Camera X", -1, 1],
						["y", "Camera Y", -1, 1],
						["zoom", "Zoom", 0.5, 2],
						["orbit", "Orbit", -1, 1],
						["tilt", "Tilt", -1, 1],
					] as const
				).map(([key, label, min, max]) => (
					<RyuAppField key={key} label={label}>
						<Input
							aria-label={`Stage camera ${label}`}
							defaultValue={camera[key]}
							key={camera[key]}
							max={max}
							min={min}
							onBlur={(event) => {
								const value = Number(event.target.value);
								if (Number.isFinite(value) && value >= min && value <= max) {
									onCameraChange({ ...camera, [key]: value });
								} else {
									event.target.value = String(camera[key]);
								}
							}}
							step={0.01}
							type="number"
						/>
					</RyuAppField>
				))}
				<RyuAppField label="Camera path time">
					<Input
						aria-label="Stage camera path time"
						max={7200}
						min={0}
						onChange={(event) => setCameraPathTime(Number(event.target.value))}
						step={0.01}
						type="number"
						value={cameraPathTime}
					/>
				</RyuAppField>
				<RyuAppField label="Camera path property">
					<NativeSelect
						aria-label="Stage camera path property"
						onChange={(event) => {
							const property = stageCameraPropertySchema.parse(
								event.target.value
							);
							setCameraProperty(property);
							const bounds = stageCameraValueBounds(property);
							setCameraValue(
								Math.max(bounds.min, Math.min(bounds.max, cameraValue))
							);
						}}
						value={cameraProperty}
					>
						<NativeSelectOption value="x">Camera X</NativeSelectOption>
						<NativeSelectOption value="y">Camera Y</NativeSelectOption>
						<NativeSelectOption value="zoom">Zoom</NativeSelectOption>
						<NativeSelectOption value="orbit">Orbit</NativeSelectOption>
						<NativeSelectOption value="tilt">Tilt</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
				<RyuAppField label="Camera path value">
					<Input
						aria-label="Stage camera path value"
						max={stageCameraValueBounds(cameraProperty).max}
						min={stageCameraValueBounds(cameraProperty).min}
						onChange={(event) => setCameraValue(Number(event.target.value))}
						step={0.01}
						type="number"
						value={cameraValue}
					/>
				</RyuAppField>
				<Button onClick={addCameraKeyframe} variant="outline">
					Add camera keyframe
				</Button>
				{camera.keyframes?.length ? (
					<small>
						{camera.keyframes.length} camera keyframe
						{camera.keyframes.length === 1 ? "" : "s"} saved
					</small>
				) : null}
			</div>
			{objects.map((object, index) => (
				<div className="studio-scene" key={object.id}>
					<strong>3D block {index + 1}</strong>
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Center X", -1, 1],
							["y", "Center Y", -1, 1],
							["z", "Depth Z", -1, 1],
							["width", "Width", 0.04, 1],
							["height", "Height", 0.04, 1],
							["depth", "Extrusion", 0.04, 1],
							["entryDuration", "Entry duration", 0, 10],
						] as const
					).map(([key, label, min, max]) => (
						<RyuAppField key={key} label={label}>
							<Input
								aria-label={`3D block ${index + 1} ${label}`}
								defaultValue={object[key]}
								key={object[key]}
								max={max}
								min={min}
								onBlur={(event) => {
									const value = Number(event.target.value);
									if (Number.isFinite(value) && value >= min && value <= max) {
										change(object.id, { [key]: value });
									} else {
										event.target.value = String(object[key]);
									}
								}}
								step={0.01}
								type="number"
							/>
						</RyuAppField>
					))}
					<RyuAppField label="Block color">
						<ColorPickerPopover
							onValueChange={(value) => change(object.id, { fill: value })}
							triggerAriaLabel={`3D block ${index + 1} color`}
							triggerClassName="w-full justify-start"
							value={object.fill}
						/>
					</RyuAppField>
					<RyuAppField label="Camera motion">
						<NativeSelect
							aria-label={`3D block ${index + 1} camera motion`}
							onChange={(event) =>
								change(object.id, {
									animation: event.target.value as SpatialObject["animation"],
								})
							}
							value={object.animation}
						>
							<NativeSelectOption value="none">None</NativeSelectOption>
							<NativeSelectOption value="float">Float</NativeSelectOption>
							<NativeSelectOption value="orbit-left">
								Orbit left
							</NativeSelectOption>
							<NativeSelectOption value="orbit-right">
								Orbit right
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<Button
						onClick={() =>
							onChange(objects.filter((item) => item.id !== object.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove 3D block
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
