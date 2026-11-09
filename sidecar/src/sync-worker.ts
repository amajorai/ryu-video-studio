import { syncClips } from "../../shared/sync.ts";
import type { SyncWorkerInput, SyncWorkerResult } from "./sync-runner.ts";

self.addEventListener(
	"message",
	(event: MessageEvent<SyncWorkerInput>) => {
		const data = event.data;
		let message: SyncWorkerResult;
		try {
			message = {
				result: syncClips(
					data.project,
					data.assets,
					new Map(data.analyses),
					data.input
				),
			};
		} catch (error) {
			message = {
				error: error instanceof Error ? error.message : "Audio sync failed.",
			};
		}
		postMessage(message);
	},
	{ once: true }
);
