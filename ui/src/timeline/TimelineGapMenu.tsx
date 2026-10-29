import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef, useState } from "react";
import { trackSettingFor } from "../../../shared/project.ts";
import { gapAt, type TimeSpan } from "../../../shared/ripple-edits.ts";
import { rippleDeleteGapAt } from "../editor/actions/ripple.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { useRazorClicks } from "./clip-click.ts";

interface GapMenuState {
	gap: TimeSpan;
	/** Pointer position from the lane's left edge, in pixels. */
	left: number;
	time: number;
}

/**
 * Right-click menu on empty lane space ("Ripple delete gap"). Mounted once
 * per track inside its lane: it listens for context menus whose target is
 * the lane itself (not a clip or the track header) and opens at the
 * pointer when the click falls in a gap between clips. The timeline's
 * razor clicks are connected here too, since this is the lane-level slot
 * the timeline mounts.
 */
export function TimelineGapMenu({ track }: { track: number }) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	useRazorClicks(runtime);
	const latest = useRef(runtime);
	latest.current = runtime;
	const anchorRef = useRef<HTMLSpanElement>(null);
	const [menu, setMenu] = useState<GapMenuState | null>(null);
	useEffect(() => {
		const lane = anchorRef.current?.parentElement;
		if (!lane) {
			return;
		}
		const onContextMenu = (event: MouseEvent) => {
			if (event.target !== lane) {
				return;
			}
			const { project, zoom } = latest.current;
			if (!project || zoom <= 0) {
				return;
			}
			const left = event.clientX - lane.getBoundingClientRect().left;
			const time = Math.max(0, left / zoom);
			const gap = gapAt(project, track, time);
			if (!gap) {
				return;
			}
			event.preventDefault();
			setMenu({ gap, left, time });
		};
		lane.addEventListener("contextmenu", onContextMenu);
		return () => {
			lane.removeEventListener("contextmenu", onContextMenu);
		};
	}, [track]);
	const locked = trackSettingFor(runtime.project, track).locked;
	return (
		<span className="contents" data-gap-menu={track} ref={anchorRef}>
			{menu && (
				<DropdownMenu
					onOpenChange={(open) => {
						if (!open) {
							setMenu(null);
						}
					}}
					open
				>
					<DropdownMenuTrigger
						aria-label={tl("Gap actions on track {trackNumber}", {
							trackNumber: track + 1,
						})}
						className="pointer-events-none absolute top-1/2 size-px opacity-0"
						style={{ left: menu.left }}
						tabIndex={-1}
					/>
					<DropdownMenuContent>
						<DropdownMenuItem
							disabled={locked}
							onClick={() => {
								rippleDeleteGapAt(latest.current, track, menu.time);
								setMenu(null);
							}}
							title={
								locked
									? "Unlock this track to delete its gap."
									: "Close this gap and move later content left."
							}
						>
							{tl("Ripple delete gap ({duration})", {
								duration: clock(menu.gap.end - menu.gap.start),
							})}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</span>
	);
}
