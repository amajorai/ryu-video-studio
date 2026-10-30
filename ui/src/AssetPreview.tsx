import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Asset } from "../../shared/project.ts";
import { clock } from "./editor/format.ts";
import { studioFormat } from "./i18n/format.ts";
import { SKIM_BUCKETS, skimTime, useHoverSkim } from "./library/hover-skim.ts";
import {
	canMarkSource,
	markedRange,
	markSourceIn,
	markSourceOut,
	type SourceMarks,
} from "./library/source-marks.ts";

/** Frame height of the source viewer (the sidecar allows up to 360). */
const VIEWER_HEIGHT = 360;
/**
 * Distinct frames the scrubber fetches: finer than tile skimming, still
 * cache-friendly. Marks use the exact scrubber time, not the frame bucket.
 */
const VIEWER_FRAME_STEPS = SKIM_BUCKETS * 32;

function isTextField(target: EventTarget) {
	return (
		target instanceof HTMLElement &&
		Boolean(target.closest("input:not([type='range']), textarea, select"))
	);
}

/**
 * Source viewer for one library asset: a frame scrubber and, for video and
 * audio, I/O source marks that feed the tile's drag payload, "Add" and
 * "Insert at playhead".
 */
export function AssetPreview({
	asset,
	marks,
	onError,
	onMarksChange,
}: {
	asset: Asset;
	marks: SourceMarks;
	onError: (message: string) => void;
	onMarksChange: (marks: SourceMarks) => void;
}) {
	const tl = useLiteralMessages();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState(0);
	const skim = useHoverSkim(asset, { height: VIEWER_HEIGHT });
	const markable = canMarkSource(asset);
	const hasFrames = asset.kind !== "audio";
	const time =
		asset.kind === "video" ? skimTime(position, asset, VIEWER_FRAME_STEPS) : 0;
	const playheadTime = Math.round(position * asset.duration * 1000) / 1000;
	const range = markedRange(marks, asset);

	const show = () => {
		setOpen(true);
		if (hasFrames) {
			skim.showTime(time);
		}
	};
	const seek = (fraction: number) => {
		setPosition(fraction);
		if (asset.kind === "video") {
			skim.showTime(skimTime(fraction, asset, VIEWER_FRAME_STEPS));
		}
	};
	const markIn = () => onMarksChange(markSourceIn(marks, playheadTime, asset));
	const markOut = () =>
		onMarksChange(markSourceOut(marks, playheadTime, asset));
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			!markable ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			isTextField(event.target)
		) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key === "i" || key === "o") {
			event.preventDefault();
			event.stopPropagation();
			if (key === "i") {
				markIn();
			} else {
				markOut();
			}
		}
	};
	const reportError = useRef(onError);
	reportError.current = onError;
	useEffect(() => {
		if (skim.unavailable && hasFrames) {
			reportError.current("The source preview is unavailable.");
		}
	}, [hasFrames, skim.unavailable]);

	return (
		<>
			<Button
				aria-label={tl("Preview {name}", { name: asset.name })}
				onClick={show}
				ref={trigger}
				size="sm"
				variant="ghost"
			>
				{markable ? "Preview and mark" : "Preview"}
			</Button>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent
					className="sm:max-w-2xl"
					finalFocus={trigger}
					onKeyDown={onKeyDown}
				>
					<DialogHeader>
						<DialogTitle>
							<span className="inline-block pe-8">{asset.name}</span>
						</DialogTitle>
						<DialogDescription>
							{markable
								? "Scrub the source and press I or O to mark the range that Add, Insert at playhead and dragging place."
								: "Source preview. Timeline edits and exports use the original media."}
						</DialogDescription>
					</DialogHeader>
					{hasFrames &&
						(skim.frame ? (
							<img
								alt={tl("Frame of {name} at {time}", {
									name: asset.name,
									time: clock(time),
								})}
								className="max-h-[60vh] w-full object-contain"
								height={asset.height}
								src={skim.frame}
								width={asset.width}
							/>
						) : (
							<div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
								{skim.unavailable ? "Preview unavailable" : "Loading frame…"}
							</div>
						))}
					{markable && (
						<div className="flex flex-col gap-2">
							<input
								aria-label={tl("Source position in {name}", {
									name: asset.name,
								})}
								aria-valuetext={clock(playheadTime)}
								className="w-full accent-primary"
								max={1}
								min={0}
								onChange={(event) => seek(Number(event.target.value))}
								step="any"
								type="range"
								value={position}
							/>
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span className="tabular-nums">{clock(playheadTime)}</span>
								<Button onClick={markIn} size="sm" variant="outline">
									Mark in (I)
								</Button>
								<Button onClick={markOut} size="sm" variant="outline">
									Mark out (O)
								</Button>
								<Button
									disabled={marks.in === undefined && marks.out === undefined}
									onClick={() => onMarksChange({})}
									size="sm"
									variant="ghost"
								>
									Clear marks
								</Button>
								<output
									aria-live="polite"
									className="text-muted-foreground tabular-nums"
								>
									{range
										? studioFormat("Marked {range}", {
												range: `${clock(range.start)}–${clock(range.end)}`,
											})
										: "No range marked: the whole source is placed."}
								</output>
							</div>
						</div>
					)}
					<DialogFooter>
						<Button onClick={() => setOpen(false)} variant="outline">
							Close preview
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
