import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	resolveTimelineColors,
	TIMELINE_CLIP_KIND_LABELS,
	TIMELINE_CLIP_KINDS,
} from "../../../shared/timeline-colors.ts";
import {
	type TimelineColorStore,
	timelineColorStore,
	useTimelineColors,
} from "../timeline/timeline-colors.ts";

/**
 * Timeline colors: one swatch per clip kind plus Reset all. The colors are
 * this viewer's preference; a clip's own color tag still wins over them.
 */
export function TimelineColorsPane({
	store = timelineColorStore,
}: {
	store?: TimelineColorStore;
}) {
	const overrides = useTimelineColors(store);
	const colors = resolveTimelineColors(overrides);
	const changed = Object.keys(overrides).length > 0;
	return (
		<section aria-label="Timeline colors" className="flex flex-col gap-2">
			<strong className="text-sm">Timeline colors</strong>
			<small className="text-muted-foreground">
				Default fill for clips without a color tag. Saved for this viewer.
			</small>
			<ul className="flex flex-col gap-1">
				{TIMELINE_CLIP_KINDS.map((kind) => (
					<li
						className="flex items-center justify-between gap-2 text-xs"
						data-timeline-color-kind={kind}
						key={kind}
					>
						<span>{TIMELINE_CLIP_KIND_LABELS[kind]}</span>
						<span className="flex items-center gap-1">
							{overrides[kind] ? (
								<span className="text-muted-foreground">Custom</span>
							) : null}
							<Input
								aria-label={`${TIMELINE_CLIP_KIND_LABELS[kind]} color`}
								className="h-7 w-10 p-0.5"
								onChange={(event) => store.setColor(kind, event.target.value)}
								type="color"
								value={colors[kind]}
							/>
						</span>
					</li>
				))}
			</ul>
			<RyuAppActions>
				<Button
					disabled={!changed}
					onClick={store.reset}
					size="sm"
					variant="outline"
				>
					Reset all
				</Button>
			</RyuAppActions>
		</section>
	);
}

/** Workspace bar button that opens the Timeline colors pane. */
export function TimelineColorsButton() {
	return (
		<Popover>
			<PopoverTrigger
				render={<Button size="sm" title="Timeline colors" variant="ghost" />}
			>
				Timeline colors
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72">
				<TimelineColorsPane />
			</PopoverContent>
		</Popover>
	);
}
