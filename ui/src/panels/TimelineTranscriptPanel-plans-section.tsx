import { RyuAppActions, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { TimelineRange } from "../../../shared/filler-words.ts";
import {
	planBatch,
	planRanges,
	type TranscriptRemovalPlan,
} from "../../../shared/timeline-transcript.ts";
import { plural, rangesSeconds } from "./TimelineTranscriptPanel-model.ts";
import { PlanRow } from "./TimelineTranscriptPanel-plan-row.tsx";

/** Repeated phrases and retakes, with one-click removal. */
export function PlansSection({
	disabled,
	plans,
	remove,
	reveal,
	seek,
	timelineEnd,
}: {
	disabled: boolean;
	plans: TranscriptRemovalPlan[];
	remove: (
		ranges: TimelineRange[],
		description: string,
		remainder?: string
	) => Promise<void>;
	reveal: (index: number) => void;
	seek: (seconds: number) => void;
	timelineEnd: number;
}) {
	const tl = useLiteralMessages();
	const allPlans = planBatch(plans, timelineEnd);
	const allPlanRanges = allPlans.ranges;
	const partial = allPlans.covered < plans.length;
	return (
		<RyuAppSection title="Repeated phrases and retakes">
			{plans.length === 0 ? (
				<p className="text-muted-foreground">
					No repeated phrases or restarted sentences found.
				</p>
			) : (
				<>
					<p>
						Each suggestion removes the earlier take and keeps the later one.
					</p>
					<RyuAppActions>
						<Button
							disabled={disabled || allPlanRanges.length === 0}
							onClick={() =>
								void remove(
									allPlanRanges,
									"repeated-phrase",
									partial
										? `Removed ${plural(allPlans.covered, "suggestion")}; ${plans.length - allPlans.covered} more remain. Run Remove again to continue.`
										: ""
								)
							}
							size="sm"
						>
							{partial
								? tl(
										"Remove first {covered} of {count, plural, one {{countText} suggestion} other {{countText} suggestions}}",
										{
											count: plans.length,
											countText: String(plans.length),
											covered: String(allPlans.covered),
										}
									)
								: tl(
										"Remove all {count, plural, one {{countText} suggestion} other {{countText} suggestions}}",
										{
											count: plans.length,
											countText: String(plans.length),
										}
									)}{" "}
							({rangesSeconds(allPlanRanges)}s)
						</Button>
					</RyuAppActions>
					{plans.map((plan) => (
						<PlanRow
							disabled={disabled}
							key={plan.id}
							onRemove={() =>
								void remove(
									planRanges([plan], timelineEnd),
									plan.kind === "retake" ? "retake" : "repeated-phrase"
								)
							}
							onSeek={() => {
								seek(plan.range.start);
								reveal(plan.first);
							}}
							plan={plan}
						/>
					))}
				</>
			)}
		</RyuAppSection>
	);
}
