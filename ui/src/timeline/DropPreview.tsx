import { useRef } from "react";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { useOsDrop } from "../import/os-drop.ts";
import { useTimelineDrop } from "./useTimelineDrop.ts";

/** Ghost inset inside its lane, in pixels (matches the clip's top offset). */
const GHOST_INSET = 6;

/**
 * Live preview for a library drop: a ghost of the clip where it would land,
 * shading over the clip ranges an overwrite would cut (linked partners
 * included), or an insertion line for a Cmd/Ctrl ripple insert. Mounted
 * inside the lanes container, whose drag events `useTimelineDrop` handles.
 * Operating-system file drops and media pastes anywhere on the window import
 * through the library while the timeline is shown.
 */
export function DropPreview({ zoom }: { zoom: number }) {
	const runtime = useEditorProject();
	const layerRef = useRef<HTMLDivElement>(null);
	const { target } = useTimelineDrop({ layerRef, runtime, zoom });
	useOsDrop(runtime);
	const lane = target ? target.lanes[target.track] : undefined;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[5]"
			data-drop-layer=""
			ref={layerRef}
		>
			{target?.impacts.map((impact) => {
				const box = target.lanes[impact.track];
				return (
					box && (
						<div
							className="absolute border-destructive border-x bg-destructive/25"
							data-drop-impact={impact.action}
							key={impact.id}
							style={{
								height: box.height,
								left: impact.start * zoom,
								top: box.top,
								width: Math.max(1, (impact.end - impact.start) * zoom),
							}}
						/>
					)
				);
			})}
			{target?.mode === "insert" && (
				<div
					className="absolute top-0 bottom-0 w-0.5 bg-primary"
					data-drop-insert=""
					style={{ left: target.at * zoom }}
				/>
			)}
			{target && lane && (
				<div
					className={`absolute flex items-center overflow-hidden whitespace-nowrap rounded-sm border-2 border-dashed px-1 text-[0.65rem] ${
						target.locked
							? "border-destructive bg-destructive/15 text-destructive"
							: "border-primary bg-primary/20 text-foreground"
					}`}
					data-drop-ghost={target.mode}
					data-locked={target.locked ? "true" : undefined}
					style={{
						height: Math.max(8, lane.height - GHOST_INSET * 2),
						left: target.at * zoom,
						top: lane.top + GHOST_INSET,
						width: Math.max(2, target.duration * zoom),
					}}
				>
					{target.locked
						? "Track locked"
						: `${target.mode === "insert" ? "Insert" : "Overwrite"} ${target.name} · ${clock(target.at)}`}
				</div>
			)}
		</div>
	);
}
