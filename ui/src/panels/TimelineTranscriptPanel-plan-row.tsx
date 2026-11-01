import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Badge, Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { TranscriptRemovalPlan } from "../../../shared/timeline-transcript.ts";
import { timelineClock } from "../editing-ui.ts";

const KIND_LABELS: Record<TranscriptRemovalPlan["kind"], string> = {
	repeat: "Repeat",
	retake: "Retake",
};

export function PlanRow({
	disabled,
	onRemove,
	onSeek,
	plan,
}: {
	disabled: boolean;
	onRemove: () => void;
	onSeek: () => void;
	plan: TranscriptRemovalPlan;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="studio-scene" data-plan-id={plan.id}>
			<div className="flex items-center gap-2">
				<Badge variant="outline">{KIND_LABELS[plan.kind]}</Badge>
				<small className="text-muted-foreground tabular-nums">
					{timelineClock(plan.range.start)}–{timelineClock(plan.range.end)}
				</small>
			</div>
			<p>
				<s>{plan.text}</s>
			</p>
			<small className="text-muted-foreground">
				{tl("Keeps “{keeps}”", { keeps: plan.keeps })}
			</small>
			<RyuAppActions>
				<Button onClick={onSeek} size="sm" variant="ghost">
					Go to
				</Button>
				<Button
					disabled={disabled}
					onClick={onRemove}
					size="sm"
					variant="outline"
				>
					Remove
				</Button>
			</RyuAppActions>
		</div>
	);
}
