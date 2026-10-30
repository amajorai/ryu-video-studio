/**
 * Whether the sidecar has the assets it ships inside its binary (the bundled
 * title fonts and the RNNoise voice isolation model), read once from
 * `GET /capabilities`. Unknown (loading, unreachable, or an older sidecar)
 * counts as available, so notices appear only on a confirmed absence.
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import { request } from "./bridge.ts";

const capabilitiesSchema = z.object({
	bundledAssets: z
		.object({
			fonts: z.boolean().optional(),
			voiceIsolationModel: z.boolean().optional(),
		})
		.optional(),
});

export interface BundledAssets {
	fonts: boolean | undefined;
	voiceIsolationModel: boolean | undefined;
}

const unknownAssets: BundledAssets = {
	fonts: undefined,
	voiceIsolationModel: undefined,
};

let pending: Promise<BundledAssets> | undefined;

export function loadBundledAssets(
	fetchCapabilities: () => Promise<z.infer<typeof capabilitiesSchema>> = () =>
		request(capabilitiesSchema, "/capabilities")
): Promise<BundledAssets> {
	pending ??= fetchCapabilities()
		.then(({ bundledAssets }) => ({
			fonts: bundledAssets?.fonts,
			voiceIsolationModel: bundledAssets?.voiceIsolationModel,
		}))
		.catch(() => {
			pending = undefined;
			return unknownAssets;
		});
	return pending;
}

/** Forget the cached probe (tests). */
export function resetBundledAssets() {
	pending = undefined;
}

export function useBundledAssets(): BundledAssets {
	const [assets, setAssets] = useState(unknownAssets);
	useEffect(() => {
		let active = true;
		loadBundledAssets().then((value) => {
			if (active) {
				setAssets(value);
			}
		});
		return () => {
			active = false;
		};
	}, []);
	return assets;
}

/** The notice under the font picker when exports cannot use bundled fonts. */
export const MISSING_FONTS_NOTICE =
	"This Video Studio install is missing its bundled fonts, so exported titles and captions use system fonts. Reinstall or update Video Studio to restore them.";

/** Shown instead of the voice isolation control when the model is missing. */
export const MISSING_VOICE_MODEL_NOTICE =
	"Voice isolation is unavailable: this Video Studio install is missing its RNNoise model. Reinstall or update Video Studio to restore it.";
