import type { Mesh, Project } from "../../shared/project.ts";
import type {
	MeshWorkerInput,
	MeshWorkerResult,
} from "./mesh-render-worker.ts";

// The caller retains its media-operation admission until this worker closes.
export async function renderMeshPngAsync(
	project: Project,
	mesh: Mesh,
	width: number,
	height: number,
	time = mesh.start,
	signal?: AbortSignal,
	work = { remainingPixels: 1_000_000_000 }
): Promise<Uint8Array> {
	signal?.throwIfAborted();
	const pixelBudget = Math.min(100_000_000, work.remainingPixels);
	if (pixelBudget <= 0) {
		throw new Error(
			"Mesh rasterization exceeds the supported pixel-work budget."
		);
	}
	const moduleUrl = decodeURI(import.meta.url);
	const bundled =
		moduleUrl.includes("/~BUN/") || moduleUrl.includes("/$bunfs/");
	const extension = bundled || import.meta.url.endsWith(".js") ? "js" : "ts";
	const worker = new Worker(
		bundled
			? "./mesh-render-worker.ts"
			: new URL(`./mesh-render-worker.${extension}`, import.meta.url).href
	);
	const closed = Promise.withResolvers<void>();
	worker.addEventListener("close", () => closed.resolve(), { once: true });
	let abort: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await new Promise<Uint8Array>((resolve, reject) => {
			abort = () =>
				reject(
					new Error("Mesh render canceled or exceeded its 30-second deadline.")
				);
			signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(abort, 30_000);
			worker.addEventListener("error", (event) =>
				reject(new Error(event.message))
			);
			worker.addEventListener("close", () =>
				reject(
					new Error("Mesh render worker stopped before returning a result.")
				)
			);
			worker.addEventListener(
				"message",
				(event: MessageEvent<MeshWorkerResult>) => {
					if ("error" in event.data) {
						reject(new Error(event.data.error));
					} else {
						work.remainingPixels -= event.data.processedPixels;
						resolve(event.data.png);
					}
				}
			);
			worker.postMessage({
				project,
				mesh,
				width,
				height,
				time,
				pixelBudget,
			} satisfies MeshWorkerInput);
			if (signal?.aborted) {
				abort();
			}
		});
	} finally {
		clearTimeout(timer);
		if (abort) {
			signal?.removeEventListener("abort", abort);
		}
		worker.terminate();
		await closed.promise;
	}
}
