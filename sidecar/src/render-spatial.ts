import type { Project } from "../../shared/project.ts";
import { stageCameraExpression } from "../../shared/stage-camera.ts";
import type { OverlayChain } from "./render-graphics.ts";

/** `#rrggbb` scaled by `factor` per channel, as an FFmpeg `0xrrggbb` color. */
export function shadeHex(value: string, factor: number): string {
	const hex = value.replace("#", "");
	const channel = (offset: number) =>
		Math.max(
			0,
			Math.min(
				255,
				Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * factor)
			)
		);
	return `0x${[0, 2, 4]
		.map((offset) => channel(offset).toString(16).padStart(2, "0"))
		.join("")}`;
}

/**
 * Stage-world blocks projected through the stage camera: a front face, a lit
 * top and a shaded side, each a `drawbox`, in start order.
 */
export function spatialFilters(p: Project, input: string): OverlayChain {
	const filters: string[] = [];
	let last = input;
	const cameraOrbit = stageCameraExpression(p.stageCamera, "orbit");
	const cameraX = stageCameraExpression(p.stageCamera, "x");
	const cameraY = stageCameraExpression(p.stageCamera, "y");
	const cameraTilt = stageCameraExpression(p.stageCamera, "tilt");
	const cameraZoom = stageCameraExpression(p.stageCamera, "zoom");
	for (const [index, object] of [...p.spatialObjects]
		.sort((a, b) => a.start - b.start)
		.entries()) {
		const orbit =
			object.animation === "orbit-left"
				? `(-1)*sin((t-${object.start})*6.283185)*0.18`
				: object.animation === "orbit-right"
					? `sin((t-${object.start})*6.283185)*0.18`
					: "0";
		const float =
			object.animation === "float"
				? `cos((t-${object.start})*6.283185)*0.02`
				: "0";
		const z = `(${object.z}+${orbit}+${cameraOrbit})`;
		const centerX = `(0.5+(${object.x}-${cameraX}+${z}*0.12)*0.5)`;
		const centerY = `(0.5+(${object.y}-${cameraY}-${z}*0.08+${float}+${cameraTilt}*${z}*0.08)*0.5)`;
		const perspective = `(${cameraZoom}*(1+${z}*0.18))`;
		const width = `(${object.width}*${perspective})`;
		const height = `(${object.height}*${perspective})`;
		const extrusion = `(${object.depth}*0.08)`;
		const boxes = [
			{
				color: shadeHex(object.fill, 1),
				height,
				width,
				x: `${centerX}-${width}/2`,
				y: `${centerY}-${height}/2`,
			},
			{
				color: shadeHex(object.fill, 1.22),
				height: extrusion,
				width: `(${width}*0.92)`,
				x: `${centerX}-${width}/2+${width}*0.08`,
				y: `${centerY}-${height}/2-${extrusion}`,
			},
			{
				color: shadeHex(object.fill, 0.68),
				height,
				width: extrusion,
				x: `${centerX}+${width}/2`,
				y: `${centerY}-${height}/2`,
			},
		];
		for (const [part, box] of boxes.entries()) {
			const output = `stage${index}part${part}`;
			filters.push(
				`[${last}]drawbox=x='iw*(${box.x})':y='ih*(${box.y})':w='iw*${box.width}':h='ih*${box.height}':color=${box.color}:t=fill:enable='between(t,${object.start},${object.end})'[${output}]`
			);
			last = output;
		}
	}
	return { filters, last };
}
