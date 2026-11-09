import { afterEach, describe, expect, test } from "bun:test";
import { loadBundledAssets, resetBundledAssets } from "./bundled-assets.ts";

afterEach(resetBundledAssets);

describe("bundled sidecar assets", () => {
	test("reads the sidecar's bundledAssets flags", async () => {
		expect(
			await loadBundledAssets(async () => ({
				bundledAssets: { fonts: false, voiceIsolationModel: true },
			}))
		).toEqual({ fonts: false, voiceIsolationModel: true });
	});

	test("an older sidecar without the flags counts as unknown, not missing", async () => {
		expect(await loadBundledAssets(async () => ({}))).toEqual({
			fonts: undefined,
			voiceIsolationModel: undefined,
		});
	});

	test("a failed probe is retried on the next read", async () => {
		expect(
			await loadBundledAssets(() => Promise.reject(new Error("offline")))
		).toEqual({ fonts: undefined, voiceIsolationModel: undefined });
		expect(
			await loadBundledAssets(async () => ({
				bundledAssets: { fonts: true, voiceIsolationModel: false },
			}))
		).toEqual({ fonts: true, voiceIsolationModel: false });
	});
});
