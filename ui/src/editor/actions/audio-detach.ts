import { detachedAudioPairs } from "../../../../shared/detach-audio.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandler, ActionHandlers } from "./types.ts";

const clipCount = (count: number) => `${count} clip${count === 1 ? "" : "s"}`;

/** Extract camera audio from clips into linked audio clips (sidecar edit). */
export const detachAudio = (runtime: EditorRuntime, clipIds: string[]) =>
	runtime.routeEdit(
		"detach-audio",
		{ clipIds },
		() =>
			`Detached camera audio from ${clipCount(clipIds.length)} into linked audio clips.`,
		{ refreshAssets: true }
	);

/**
 * Recover detached camera audio: the extracted audio clip is removed and its
 * volume and volume keyframes return to the camera clip (sidecar edit).
 */
export const recoverAudio = (runtime: EditorRuntime, clipIds: string[]) =>
	runtime.routeEdit(
		"reattach-audio",
		{ clipIds },
		() =>
			`Recovered camera audio for ${clipCount(clipIds.length)}; the detached audio clip was removed.`
	);

/**
 * Selected clips (camera clip or extracted audio) whose detached audio can be
 * recovered, one id per detached pair so a pair is never named twice.
 */
export function recoverableSelection(runtime: EditorRuntime): string[] {
	const { assets, project } = runtime;
	if (!project) {
		return [];
	}
	const ids = runtime.selectedIds.length
		? runtime.selectedIds
		: [runtime.selectedId].filter((id): id is string => Boolean(id));
	const seenAudio = new Set<string>();
	const clipIds: string[] = [];
	for (const id of ids) {
		const pairs = detachedAudioPairs(project, assets, id).filter(
			(pair) => !seenAudio.has(pair.audio.id)
		);
		if (pairs.length) {
			for (const pair of pairs) {
				seenAudio.add(pair.audio.id);
			}
			clipIds.push(id);
		}
	}
	return clipIds;
}

/**
 * Recover the selection's detached audio. Declines (returns false) when no
 * selected clip has detached audio, so a shared binding can fall through.
 */
export const recoverSelectedAudio: ActionHandler = (runtime) => {
	if (runtime.selectedTrackLocked) {
		runtime.setStatus("Unlock this track before recovering clip audio.");
		return;
	}
	const clipIds = recoverableSelection(runtime);
	if (!clipIds.length) {
		return false;
	}
	void recoverAudio(runtime, clipIds);
};

/**
 * Action id the clip context menu dispatches for Recover audio. It is not in
 * `shortcuts/defaults.ts` yet, so it cannot be keyed into `ActionHandlers`
 * until that table gains it; integration registers this handler under it.
 */
export const RECOVER_AUDIO_ACTION = "audio.recoverSelected";

/** Handlers keyed by planned action ids that the binding table lacks today. */
export const pendingAudioDetachActions: Readonly<
	Record<typeof RECOVER_AUDIO_ACTION, ActionHandler>
> = { [RECOVER_AUDIO_ACTION]: recoverSelectedAudio };

/** Detach handlers. */
export const audioDetachActions: ActionHandlers = {
	"audio.detachSelected": (runtime) => {
		if (!runtime.selectedSegment) {
			return false;
		}
		void detachAudio(runtime, [runtime.selectedSegment.id]);
	},
};
