import type { Project } from "../../../shared/project.ts";
import type { PreviewStyle } from "./preview-style.ts";

function StageObjectLayer({
	camera,
	object,
	time,
}: {
	camera: Project["stageCamera"];
	object: Project["spatialObjects"][number];
	time: number;
}) {
	const elapsed = time - object.start;
	const progress = object.entryDuration
		? Math.min(1, Math.max(0, elapsed / object.entryDuration))
		: 1;
	const orbit =
		object.animation === "orbit-left"
			? -Math.sin(elapsed * Math.PI * 2) * 0.18
			: object.animation === "orbit-right"
				? Math.sin(elapsed * Math.PI * 2) * 0.18
				: 0;
	const float =
		object.animation === "float" ? Math.cos(elapsed * Math.PI * 2) * 0.02 : 0;
	const depth = object.z + orbit + camera.orbit;
	const perspective = camera.zoom * (1 + depth * 0.18);
	const worldX = object.x - camera.x + depth * 0.12;
	const worldY =
		object.y - camera.y - depth * 0.08 + float + camera.tilt * depth * 0.08;
	const stageObjectStyle: PreviewStyle = {
		"--studio-stage-object-height": `${object.height * 100}%`,
		"--studio-stage-object-left": `${(0.5 + worldX * 0.5) * 100}%`,
		"--studio-stage-object-top": `${(0.5 + worldY * 0.5) * 100}%`,
		"--studio-stage-object-opacity": `${progress}`,
		"--studio-stage-object-transform": `translate(-50%, -50%) scale(${perspective}) rotateY(${depth * 18}deg)`,
		"--studio-stage-object-width": `${object.width * 100}%`,
	};
	const stageFrontStyle: PreviewStyle = {
		"--studio-stage-object-fill": object.fill,
	};
	const stageTopStyle: PreviewStyle = {
		"--studio-stage-object-fill": object.fill,
	};
	const stageSideStyle: PreviewStyle = {
		"--studio-stage-object-fill": object.fill,
	};
	return (
		<div
			aria-label="3D stage object"
			className="studio-stage-object"
			style={stageObjectStyle}
		>
			<div className="studio-stage-object-front" style={stageFrontStyle} />
			<div className="studio-stage-object-top" style={stageTopStyle} />
			<div className="studio-stage-object-side" style={stageSideStyle} />
		</div>
	);
}

/** 3D stage objects visible at `time`, seen through the stage camera. */
export function PreviewStageObjects({
	camera,
	project,
	time,
}: {
	camera: Project["stageCamera"];
	project: Project;
	time: number;
}) {
	return project.spatialObjects
		.filter((object) => time >= object.start && time < object.end)
		.map((object) => (
			<StageObjectLayer
				camera={camera}
				key={object.id}
				object={object}
				time={time}
			/>
		));
}
