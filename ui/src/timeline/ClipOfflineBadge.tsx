import { useLiteralMessages } from "@ryu/i18n/react";
import { OFFLINE_REASON_LABELS } from "../../../shared/relink.ts";
import { useOfflineReport } from "../library/offline-media.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";

/**
 * Hatched overlay on a clip whose media file is offline. It is a visual
 * marker inside the clip button, so it is not itself interactive; relink
 * from the media library's relink dialog. The clip button keeps its own
 * accessible name, so the reason is carried by `title` and a hidden label.
 */
export function ClipOfflineBadge({ asset, segment }: ClipSlotProps) {
	const tl = useLiteralMessages();
	const report = useOfflineReport(asset?.id ?? segment.assetId);
	if (!report) {
		return null;
	}
	const reason = tl(OFFLINE_REASON_LABELS[report.reason]);
	return (
		<span
			className="pointer-events-none absolute inset-0 z-[2] bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--destructive)_45%,transparent)_0_4px,transparent_4px_9px)]"
			data-offline-reason={report.reason}
			data-testid="clip-offline-badge"
			title={tl("Media offline. {reason} Relink it from the media library.", {
				reason,
			})}
		>
			<span className="absolute right-1 bottom-px rounded-sm bg-destructive px-1 font-medium text-[0.6rem] text-white leading-tight">
				Offline
			</span>
			<span className="sr-only">
				{tl(", media offline: {reason}", { reason })}
			</span>
		</span>
	);
}
