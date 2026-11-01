import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { DragEvent } from "react";
import type { Asset } from "../../shared/project.ts";
import type { ShotColor } from "../../shared/shot-index.ts";
import {
	clearActiveAssetDrag,
	setActiveAssetDrag,
} from "./library/drag-source.ts";
import { writeAssetDrag } from "./search-bridge.ts";

function dragRange(
	event: DragEvent<HTMLElement>,
	asset: Asset,
	start: number,
	end: number
) {
	const payload = { assetId: asset.id, sourceIn: start, sourceOut: end };
	writeAssetDrag(event.dataTransfer, payload);
	// The timeline drop preview reads the in-flight drag during dragover.
	setActiveAssetDrag({ asset, payload });
}

/** One found source range; drag it to the timeline or add it at the end. */
export function SourceRangeResult({
	asset,
	colors = [],
	end,
	labels,
	onRange,
	start,
	text,
}: {
	asset: Asset;
	colors?: ShotColor[];
	end: number;
	labels: string[];
	onRange: (assetId: string, start: number, end: number) => void;
	start: number;
	text?: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			aria-label={tl("{name} {start} to {end} seconds", {
				name: asset.name,
				start: start.toFixed(1),
				end: end.toFixed(1),
			})}
			className="studio-scene cursor-grab"
			draggable
			onDragEnd={clearActiveAssetDrag}
			onDragStart={(event) => dragRange(event, asset, start, end)}
			role="group"
		>
			<strong>{asset.name}</strong>
			<small>
				{start.toFixed(1)}–{end.toFixed(1)}s
			</small>
			{colors.length > 0 && (
				<div className="flex items-center gap-1">
					{colors.map((color) => (
						<span
							className="inline-block size-3 rounded-sm border border-border"
							key={color.hex}
							style={{ backgroundColor: color.hex }}
							title={`${color.name} ${Math.round(color.weight * 100)}%`}
						/>
					))}
				</div>
			)}
			{labels.length > 0 && <small>{labels.join(" · ")}</small>}
			{text && <p>{text}</p>}
			<Button
				onClick={() => onRange(asset.id, start, end)}
				size="sm"
				variant="outline"
			>
				Add source range
			</Button>
		</div>
	);
}
