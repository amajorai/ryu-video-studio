import { join } from "node:path";
import {
	createSidecarHostClient,
	resolvePluginDataDir,
	resolveSidecarPort,
	resolveSidecarToken,
} from "@ryu/sidecar-runtime";
import { capturePluginKeys, SEAL_ENV_VARS } from "@ryu/sidecar-runtime/seal";
import { setProbeScratchDirectory } from "./media.ts";
import { budgetPayloadSchema, createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

// Capture the content key before anything else runs, then drop every
// key-carrying variable so ffmpeg, probes and workers never inherit one.
const keys = capturePluginKeys("@ryu/video-studio", Bun.env);
for (const name of SEAL_ENV_VARS) {
	delete Bun.env[name];
}
const token = resolveSidecarToken(Bun.env);
if (!token) {
	throw new Error("Video Studio requires its Core-minted extension token.");
}
const dataDirectory = resolvePluginDataDir(Bun.env, "@ryu/video-studio");
const store = new StudioStore(dataDirectory, { keys });
setProbeScratchDirectory(join(dataDirectory, "tmp"));
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
	budgetSpend: host
		? async () =>
				budgetPayloadSchema.parse(await host.call("gateway.budgetSpend", {}))
		: undefined,
	budgetAudit: host
		? async () =>
				budgetPayloadSchema.parse(
					await host.call("gateway.audit", { limit: 100 })
				)
		: undefined,
});
process.once("SIGINT", () => app.stop());
process.once("SIGTERM", () => app.stop());
