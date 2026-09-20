import { homedir } from "node:os";
import { join } from "node:path";
import {
	createSidecarHostClient,
	resolveSidecarDataDir,
	resolveSidecarPort,
	resolveSidecarToken,
} from "@ryu/sidecar-runtime";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const token = resolveSidecarToken(Bun.env);
if (!token) {
	throw new Error("Video Studio requires its Core-minted extension token.");
}
const directory = resolveSidecarDataDir(
	Bun.env,
	join(homedir(), ".ryu-video-studio")
);
const store = new StudioStore(join(directory, "video-studio"));
const corePort = Number(Bun.env.RYU_CORE_PORT);
const host =
	Number.isInteger(corePort) && corePort > 0
		? createSidecarHostClient({
				corePort,
				pluginId: Bun.env.RYU_EXT_PLUGIN_ID ?? "@ryu/video-studio",
				token,
			})
		: null;
const app = createStudioServer({
	store,
	token,
	port: resolveSidecarPort(Bun.env, "RYU_VIDEO_STUDIO_PORT", 8040),
	budgetSpend: host ? () => host.call("gateway.budgetSpend", {}) : undefined,
	budgetAudit: host
		? () => host.call("gateway.audit", { limit: 100 })
		: undefined,
});
process.once("SIGINT", () => app.stop());
process.once("SIGTERM", () => app.stop());
