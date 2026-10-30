import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	detachAudioState,
	extractableAudioRefusal,
	recoverBlockingTrack,
} from "../../../../shared/detach-audio.ts";
import {
	detachAudio,
	recoverAudio,
} from "../../editor/actions/audio-detach.ts";
import { useEditorProject } from "../../editor/context.tsx";
import type { ClipSectionProps } from "../section-props.ts";

/**
 * Detach or recover clip audio. A camera clip with embedded audio offers
 * Detach; either member of a detached pair offers Recover, which removes the
 * extracted audio clip and returns its volume to the camera clip.
 */
export function DetachSection({ segment }: ClipSectionProps) {
	const runtime = useEditorProject();
	const { assets, busy, project, selectedTrackLocked } = runtime;
	const tl = useLiteralMessages();
	const asset = assets.find((item) => item.id === segment.assetId);
	const state = detachAudioState(project, assets, segment.id);
	if (state === "unavailable" && !(asset?.kind === "video" && asset.hasAudio)) {
		return null;
	}
	const refusal =
		state === "unavailable" && asset
			? (extractableAudioRefusal(asset) ??
				"Unlink the clip or unlock its track to detach its audio.")
			: undefined;
	const recover = state === "recover";
	const blockingTrack = recover
		? recoverBlockingTrack(project, assets, segment.id)
		: undefined;
	let reason = refusal;
	if (blockingTrack !== undefined) {
		reason = tl("Unlock track {trackNumber} to recover its audio.", {
			trackNumber: String(blockingTrack + 1),
		});
	} else if (selectedTrackLocked) {
		reason = "Unlock this track to change its audio.";
	}
	return (
		<RyuAppActions>
			<Button
				aria-label={recover ? "Recover detached audio" : "Detach audio"}
				data-detach-state={state}
				disabled={busy || Boolean(reason)}
				onClick={() => {
					if (recover) {
						void recoverAudio(runtime, [segment.id]);
					} else {
						void detachAudio(runtime, [segment.id]);
					}
				}}
				size="sm"
				title={reason}
				variant="outline"
			>
				{recover ? "Recover audio" : "Detach audio"}
			</Button>
		</RyuAppActions>
	);
}
