import type { Mesh, Project } from "../../shared/project.ts";
import { renderMeshPng } from "./mesh-render.ts";

export interface MeshWorkerInput {
	height: number;
	mesh: Mesh;
	pixelBudget: number;
	project: Project;
	time: number;
	width: number;
}
export type MeshWorkerResult =
	| { png: Uint8Array; processedPixels: number }
	| { error: string };

self.addEventListener(
	"message",
	(event: MessageEvent<MeshWorkerInput>) => {
		const { project, mesh, width, height, time, pixelBudget } = event.data;
		let result: MeshWorkerResult;
		try {
			const work = { remainingPixels: pixelBudget };
			result = {
				png: renderMeshPng(project, mesh, width, height, time, work),
				processedPixels: pixelBudget - work.remainingPixels,
			};
		} catch (error) {
			result = {
				error: error instanceof Error ? error.message : "Mesh render failed.",
			};
		}
		postMessage(result);
	},
	{ once: true }
);
