import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { meshBounds } from "../../../shared/mesh.ts";
import {
	meshPoseAtTime,
	meshVerticesAtTime,
} from "../../../shared/mesh-animation.ts";
import type { Project } from "../../../shared/project.ts";
import type { PreviewStyle } from "./preview-style.ts";

function MeshLayer({
	camera,
	mesh,
	time,
}: {
	camera: Project["stageCamera"];
	mesh: Project["meshes"][number];
	time: number;
}) {
	const safeTexture = safeMediaUrl(mesh.texture);
	const bounds = meshBounds(mesh);
	const center = {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
		z: (bounds.minZ + bounds.maxZ) / 2,
	};
	const span = Math.max(
		bounds.maxX - bounds.minX,
		bounds.maxY - bounds.minY,
		bounds.maxZ - bounds.minZ,
		0.001
	);
	const pose = meshPoseAtTime(mesh, time);
	const rotate = (vertex: readonly [number, number, number]) => {
		let x = ((vertex[0] - center.x) / span) * mesh.scale;
		let y = ((vertex[1] - center.x) / span) * mesh.scale;
		let z = ((vertex[2] - center.x) / span) * mesh.scale;
		const rotateAxis = (angle: number, a: "x" | "y" | "z") => {
			const radians = (angle * Math.PI) / 180;
			const sin = Math.sin(radians);
			const cos = Math.cos(radians);
			if (a === "x") {
				[y, z] = [y * cos - z * sin, y * sin + z * cos];
			} else if (a === "y") {
				[x, z] = [x * cos + z * sin, -x * sin + z * cos];
			} else {
				[x, y] = [x * cos - y * sin, x * sin + y * cos];
			}
		};
		rotateAxis(pose.rotationX, "x");
		rotateAxis(pose.rotationY, "y");
		rotateAxis(pose.rotationZ, "z");
		return [x, y, z] as const;
	};
	const points = meshVerticesAtTime(mesh, time).map(rotate);
	const faces = [...mesh.faces].sort(
		(a, b) =>
			b.reduce((sum, index) => sum + (points[index]?.[2] ?? 0), 0) / b.length -
			a.reduce((sum, index) => sum + (points[index]?.[2] ?? 0), 0) / a.length
	);
	const progress = Math.min(1, Math.max(0, (time - mesh.start) / 0.35));
	const meshStyle: PreviewStyle = { "--studio-mesh-opacity": `${progress}` };
	return (
		<svg
			aria-label="Imported 3D mesh"
			className="studio-mesh-layer"
			style={meshStyle}
			viewBox="0 0 1000 1000"
		>
			{safeTexture && (
				<defs>
					<pattern
						height="1"
						id={`mesh-texture-${mesh.id}`}
						patternContentUnits="objectBoundingBox"
						patternUnits="objectBoundingBox"
						width="1"
						x="0"
						y="0"
					>
						<image
							height="1"
							href={safeTexture}
							preserveAspectRatio="xMidYMid slice"
							width="1"
							x="0"
							y="0"
						/>
					</pattern>
				</defs>
			)}
			{faces.map((face, index) => {
				const projected = face
					.map((vertexIndex) => points[vertexIndex])
					.filter((vertex): vertex is readonly [number, number, number] =>
						Boolean(vertex)
					)
					.map(([x, y, z]) => {
						const depth = pose.z + z + camera.orbit;
						const worldX = pose.x - camera.x + depth * 0.12;
						const worldY =
							pose.y - camera.y - depth * 0.08 + camera.tilt * depth * 0.08;
						return `${(0.5 + (worldX + x) * 0.5 * camera.zoom) * 1000},${(0.5 + (worldY + y) * 0.5 * camera.zoom) * 1000}`;
					})
					.join(" ");
				return (
					<polygon
						fill={safeTexture ? `url(#mesh-texture-${mesh.id})` : mesh.fill}
						key={`${mesh.id}:${index}`}
						points={projected}
						stroke="var(--border)"
						strokeWidth="3"
					/>
				);
			})}
		</svg>
	);
}

/** Imported meshes visible at `time`, seen through the stage camera. */
export function PreviewMesh({
	camera,
	project,
	time,
}: {
	camera: Project["stageCamera"];
	project: Project;
	time: number;
}) {
	return project.meshes
		.filter((mesh) => time >= mesh.start && time < mesh.end)
		.map((mesh) => (
			<MeshLayer camera={camera} key={mesh.id} mesh={mesh} time={time} />
		));
}
