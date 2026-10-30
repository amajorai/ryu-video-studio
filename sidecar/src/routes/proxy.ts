import {
	createProxy,
	proxiesFor,
	proxyRequestSchema,
	proxySettingsSchema,
	proxySweepRequestSchema,
	readProxySettings,
	sweepProxies,
	writeProxySettings,
} from "../proxy.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "proxy",
		method: "POST",
		operation: {
			id: "video_studio_create_proxy",
			description:
				"Create (or reuse) a hidden H.264 preview proxy of a video asset with a 12-frame keyframe interval. `standard` is 960 px wide; `half` and `quarter` scale the source width for the preview quality toggle. The source and every render stay on the original media.",
			body: proxyRequestSchema,
		},
		handle: async ({
			asset,
			json,
			mediaSignal,
			optionalBody,
			request,
			store,
		}) => {
			const input = proxyRequestSchema.parse(await optionalBody(request));
			const result = await createProxy(store, asset, input.variant, {
				signal: mediaSignal(request),
			});
			return json(result, result.created ? 201 : 200);
		},
	},
	{
		scope: "asset",
		action: "proxies",
		method: "GET",
		operation: {
			id: "video_studio_list_proxies",
			description:
				"List the preview proxies of an asset, narrowest first. Proxies are hidden from the media library and never used by renders.",
		},
		handle: ({ asset, json, store }) =>
			json({ proxies: proxiesFor(store.assets(), asset.id) }),
	},
	{
		scope: "root",
		path: "proxies",
		method: "POST",
		operation: {
			id: "video_studio_sweep_proxies",
			description:
				"Create missing 960 px preview proxies for heavy video (wider than 1920 px or above 30 Mb/s), optionally limited to `assetIds`, and remove proxies whose source was deleted. Returns `{created, pruned, skipped, failed, remaining}`: an asset whose proxy fails is listed in `failed` and the sweep continues; `remaining` counts heavy video left for a later sweep (50 per call). Creates nothing when automatic proxies are turned off in proxy settings.",
			body: proxySweepRequestSchema,
		},
		handle: async ({ json, mediaSignal, optionalBody, request, store }) => {
			const input = proxySweepRequestSchema.parse(await optionalBody(request));
			return json(
				await sweepProxies(store, input.assetIds, {
					signal: mediaSignal(request),
				})
			);
		},
	},
	{
		scope: "root",
		path: "proxy-settings",
		method: "GET",
		operation: {
			id: "video_studio_proxy_settings",
			description:
				"Read whether heavy video gets a preview proxy automatically at import (`autoProxy`, on by default).",
		},
		handle: async ({ json, store }) => json(await readProxySettings(store)),
	},
	{
		scope: "root",
		path: "proxy-settings",
		method: "PUT",
		operation: {
			id: "video_studio_update_proxy_settings",
			description:
				"Turn automatic import-time proxies on or off (`autoProxy`). On-demand proxies stay available either way.",
			body: proxySettingsSchema,
		},
		handle: async ({ json, request, store }) =>
			json(
				await writeProxySettings(
					store,
					proxySettingsSchema.parse(await request.json())
				)
			),
	},
];
