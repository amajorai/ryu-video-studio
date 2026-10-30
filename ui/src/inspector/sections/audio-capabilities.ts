/**
 * Which optional FFmpeg audio filters the sidecar has, read once from
 * `GET /capabilities`. Unknown (still loading or unreachable) counts as
 * available, so controls are only disabled on a confirmed absence.
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import { request } from "../../bridge.ts";

const audioCapabilitiesSchema = z.object({
	filters: z.object({
		arnndn: z.boolean().optional(),
		rubberband: z.boolean().optional(),
	}),
});

export interface AudioFilterSupport {
	arnndn: boolean | undefined;
	rubberband: boolean | undefined;
}

const unknownSupport: AudioFilterSupport = {
	arnndn: undefined,
	rubberband: undefined,
};

let pending: Promise<AudioFilterSupport> | undefined;

export function loadAudioFilterSupport(
	fetchCapabilities: () => Promise<
		z.infer<typeof audioCapabilitiesSchema>
	> = () => request(audioCapabilitiesSchema, "/capabilities")
): Promise<AudioFilterSupport> {
	pending ??= fetchCapabilities()
		.then(({ filters }) => ({
			arnndn: filters.arnndn,
			rubberband: filters.rubberband,
		}))
		.catch(() => {
			pending = undefined;
			return unknownSupport;
		});
	return pending;
}

/** Forget the cached probe (tests). */
export function resetAudioFilterSupport() {
	pending = undefined;
}

export function useAudioFilterSupport(): AudioFilterSupport {
	const [support, setSupport] = useState(unknownSupport);
	useEffect(() => {
		let active = true;
		loadAudioFilterSupport().then((value) => {
			if (active) {
				setSupport(value);
			}
		});
		return () => {
			active = false;
		};
	}, []);
	return support;
}
