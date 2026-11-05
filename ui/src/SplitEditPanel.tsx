import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Checkbox,
	Input,
	Switch,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { useEffect, useEffectEvent, useState } from "react";
import { z } from "zod";
import { detachableClipIds } from "../../shared/detach-audio.ts";
import type { Asset, Project } from "../../shared/project.ts";
import { request } from "./bridge.ts";
import {
	detachBatches,
	formatSplitOffset,
	timelineClock,
} from "./editing-ui.ts";
import { NumberField } from "./NumberField.tsx";

export type RouteEditOutcome =
	| { extras: Record<string, unknown>; status: "ok" }
	| { status: "conflict" | "error" };

/** Dashed timeline overlays previewing proposed edit points or removal ranges. */
export interface TimelineGuide {
	end?: number;
	id: string;
	kind: "split" | "remove" | "highlight";
	label: string;
	start: number;
}

const proposalSchema = z.object({
	confidence: z.number(),
	cutTime: z.number(),
	evidence: z
		.object({
			inWords: z.number(),
			outWords: z.number(),
			source: z.string(),
		})
		.partial()
		.optional(),
	key: z.string(),
	kind: z.enum(["j", "l", "none"]),
	offset: z.number(),
	reason: z.string(),
});
type Proposal = z.infer<typeof proposalSchema>;
const planSchema = z.object({
	proposals: z.array(proposalSchema),
	revision: z.number(),
	skipped: z
		.array(z.object({ key: z.string(), reason: z.string() }))
		.default([]),
});
type Plan = z.infer<typeof planSchema>;

const reasonLabels: Record<string, string> = {
	"already-split": "Already a split edit",
	"both-sides-speaking": "Both sides are speaking",
	"clipped-incoming-speech": "Incoming speech starts before the picture",
	"clipped-outgoing-speech": "Outgoing speech runs past the picture",
	"complex-group": "Link group has more than one audio and picture clip",
	"continuous-source": "Same take continues across the cut",
	"energy-lead": "Incoming sound leads",
	"energy-tail": "Outgoing sound trails",
	"locked-track": "A track is locked",
	"missing-cut": "The cut no longer exists",
	"no-evidence": "No speech or sound evidence",
	"no-handle": "No spare source media",
	"unaligned-audio": "Audio is not aligned with its picture",
};
const reasonLabel = (reason: string) => reasonLabels[reason] ?? reason;

/** Rows are preselected only when the evidence is strong. */
export const AUTO_SELECT_CONFIDENCE = 0.6;

interface Row {
	checked: boolean;
	/** Unsigned seconds; the proposal kind supplies the sign. */
	offset: number;
}

export function initialSplitRows(
	proposals: readonly Proposal[]
): Record<string, Row> {
	return Object.fromEntries(
		proposals.map((proposal) => [
			proposal.key,
			{
				checked:
					proposal.kind !== "none" &&
					proposal.confidence >= AUTO_SELECT_CONFIDENCE,
				offset: Math.abs(proposal.offset),
			},
		])
	);
}

/** Accepted rows as signed `{ key, offset }` pairs for the apply route. */
export function acceptedSplitEdits(
	proposals: readonly Proposal[],
	rows: Record<string, Row>
): { key: string; offset: number }[] {
	return proposals.flatMap((proposal) => {
		const row = rows[proposal.key];
		if (!row?.checked || proposal.kind === "none" || row.offset <= 0) {
			return [];
		}
		const offset = Number(row.offset.toFixed(6));
		return [
			{ key: proposal.key, offset: proposal.kind === "j" ? -offset : offset },
		];
	});
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : "The split-edit plan failed.";

export function SplitEditPanel({
	assets,
	busy,
	ensureSaved,
	onApply,
	onDetach,
	onError,
	onGuides,
	onSeek,
	project,
}: {
	assets: readonly Asset[];
	busy: boolean;
	ensureSaved: () => Promise<Project | undefined>;
	onApply: (input: {
		crossfade: number;
		proposals: { key: string; offset: number }[];
	}) => Promise<RouteEditOutcome>;
	onDetach: (clipIds: string[]) => Promise<RouteEditOutcome>;
	onError: (text: string) => void;
	onGuides: (guides: TimelineGuide[]) => void;
	onSeek: (time: number) => void;
	project: Project;
}) {
	const tl = useLiteralMessages();
	const [plan, setPlan] = useState<Plan | null>(null);
	const [rows, setRows] = useState<Record<string, Row>>({});
	const [working, setWorking] = useState(false);
	const [detachFirst, setDetachFirst] = useState(true);
	const [replaceExisting, setReplaceExisting] = useState(false);
	const [maxOffset, setMaxOffset] = useState(1.5);
	const [crossfade, setCrossfade] = useState(0.08);
	const detachable = detachableClipIds(project, assets);
	const accepted = plan ? acceptedSplitEdits(plan.proposals, rows) : [];
	const stale = plan !== null && plan.revision !== project.revision;

	const publishGuides = useEffectEvent(() => {
		onGuides(
			plan
				? plan.proposals.flatMap((proposal) => {
						const row = rows[proposal.key];
						if (!row?.checked || proposal.kind === "none") {
							return [];
						}
						const signed = proposal.kind === "j" ? -row.offset : row.offset;
						return [
							{
								id: proposal.key,
								kind: "split" as const,
								label: tl("Proposed audio edit · {offset}", {
									offset: formatSplitOffset({
										kind: proposal.kind === "j" ? "J" : "L",
										offset: signed,
									}),
								}),
								start: Math.max(0, proposal.cutTime + signed),
							},
						];
					})
				: []
		);
	});
	useEffect(() => {
		publishGuides();
	}, [plan, rows]);
	const clearGuides = useEffectEvent(() => onGuides([]));
	useEffect(() => () => clearGuides(), []);

	const analyze = async () => {
		setWorking(true);
		try {
			// Detaching is a saved, undoable edit that runs before planning:
			// proposals can only reference cuts between linked audio and video.
			if (detachFirst) {
				for (const batch of detachBatches(project, detachable)) {
					const detached = await onDetach(batch);
					if (detached.status !== "ok") {
						return;
					}
				}
			}
			const saved = await ensureSaved();
			if (!saved) {
				return;
			}
			const next = planSchema.parse(
				await request(
					planSchema,
					`/projects/${saved.id}/split-edit-plan`,
					"POST",
					{ options: { maxOffset, replaceExisting } }
				)
			);
			setPlan(next);
			setRows(initialSplitRows(next.proposals));
		} catch (error) {
			onError(errorText(error));
		} finally {
			setWorking(false);
		}
	};

	const apply = async () => {
		if (!accepted.length) {
			return;
		}
		setWorking(true);
		try {
			const outcome = await onApply({ crossfade, proposals: accepted });
			if (outcome.status === "conflict") {
				setWorking(false);
				await analyze();
				return;
			}
			if (outcome.status === "ok") {
				setPlan(null);
				setRows({});
			}
		} finally {
			setWorking(false);
		}
	};

	const disabled = busy || working;
	const actionable = plan?.proposals.filter((p) => p.kind !== "none") ?? [];
	return (
		<RyuAppSection title="Auto J/L cuts">
			<p>
				Find picture cuts between linked audio and video and propose J-cuts
				(incoming audio leads) or L-cuts (outgoing audio trails) from measured
				word timings, falling back to the waveform. Offsets never exceed the
				source media on either side.
			</p>
			{detachable.length > 0 && (
				<RyuAppField label="Detach camera audio when analyzing">
					<Switch
						aria-label="Detach camera audio when analyzing"
						checked={detachFirst}
						disabled={disabled}
						onCheckedChange={setDetachFirst}
					/>
					<small>
						{tl(
							"{count, plural, one {{countText} video clip} other {{countText} video clips}} with camera audio are not linked to an audio clip yet. Analyzing detaches them first as an undoable edit.",
							{ count: detachable.length, countText: String(detachable.length) }
						)}
					</small>
				</RyuAppField>
			)}
			<RyuAppField label="Replace existing split edits">
				<Switch
					aria-label="Replace existing split edits"
					checked={replaceExisting}
					disabled={disabled}
					onCheckedChange={setReplaceExisting}
				/>
			</RyuAppField>
			<NumberField
				label="Longest split offset (seconds)"
				max={4}
				min={0.12}
				onChange={setMaxOffset}
				value={maxOffset}
			/>
			<NumberField
				label="Split crossfade (seconds)"
				max={0.5}
				min={0}
				onChange={setCrossfade}
				step={0.01}
				value={crossfade}
			/>
			<RyuAppActions>
				<Button disabled={disabled} onClick={() => void analyze()}>
					{plan ? "Analyze again" : "Analyze cuts"}
				</Button>
				{plan && (
					<Button
						disabled={disabled || accepted.length === 0}
						onClick={() => void apply()}
						variant="outline"
					>
						{tl(
							"Apply {count, plural, one {# split edit} other {# split edits}}",
							{ count: accepted.length }
						)}
					</Button>
				)}
			</RyuAppActions>
			{stale && (
				<small>
					The timeline changed since this analysis. Applying re-checks each cut;
					analyze again to refresh the proposals.
				</small>
			)}
			{plan && plan.proposals.length === 0 && (
				<small>
					No editable cuts found. Link or detach each clip's audio, then place
					the clips back to back on one video track.
				</small>
			)}
			{plan && plan.proposals.length > 0 && (
				<Table aria-label="Proposed split edits">
					<TableHeader>
						<TableRow>
							<TableHead>Use</TableHead>
							<TableHead>Cut</TableHead>
							<TableHead>Offset (s)</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{plan.proposals.map((proposal) => {
							const row = rows[proposal.key] ?? { checked: false, offset: 0 };
							const time = timelineClock(proposal.cutTime);
							return (
								<TableRow key={proposal.key}>
									<TableCell>
										<Checkbox
											aria-label={tl("Apply split edit at cut at {time}", {
												time,
											})}
											checked={row.checked}
											disabled={disabled || proposal.kind === "none"}
											onCheckedChange={(checked) =>
												setRows((current) => ({
													...current,
													[proposal.key]: { ...row, checked },
												}))
											}
										/>
									</TableCell>
									<TableCell className="studio-split-cut">
										<span className="font-mono">
											{timelineClock(proposal.cutTime)}
										</span>{" "}
										<Badge
											variant={
												proposal.kind === "none" ? "outline" : "secondary"
											}
										>
											{proposal.kind === "none"
												? "Straight"
												: proposal.kind.toUpperCase()}
										</Badge>
										<small>
											{tl(
												proposal.evidence?.source &&
													proposal.evidence.source !== "none"
													? "{reason} · {source} · {confidence}% confidence"
													: "{reason} · {confidence}% confidence",
												{
													confidence: String(
														Math.round(proposal.confidence * 100)
													),
													reason: reasonLabel(proposal.reason),
													source: proposal.evidence?.source ?? "",
												}
											)}
										</small>
										<Button
											aria-label={tl("Seek to cut at {time}", { time })}
											onClick={() => onSeek(Math.max(0, proposal.cutTime - 2))}
											size="sm"
											variant="ghost"
										>
											Seek
										</Button>
									</TableCell>
									<TableCell>
										<Input
											aria-label={tl("Offset for cut at {time}", { time })}
											className="studio-split-offset"
											defaultValue={row.offset.toFixed(2)}
											disabled={disabled || proposal.kind === "none"}
											key={`${proposal.key}:${row.offset}`}
											max={4}
											min={0}
											onBlur={(event) => {
												const value = Number(event.target.value);
												if (
													Number.isFinite(value) &&
													value >= 0 &&
													value <= 4
												) {
													setRows((current) => ({
														...current,
														[proposal.key]: { ...row, offset: value },
													}));
												} else {
													event.target.value = row.offset.toFixed(2);
												}
											}}
											step={1 / Math.max(1, project.fps)}
											type="number"
										/>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
			{plan && (
				<small>
					{tl(
						plan.skipped.length
							? "{actionable} of {total, plural, one {{totalText} cut} other {{totalText} cuts}} have a proposal · skipped: {reasons}. Shortcuts: Alt+J / Alt+L at the selected clip's cut, or the cut nearest the playhead; Shift+Alt+J opens this panel."
							: "{actionable} of {total, plural, one {{totalText} cut} other {{totalText} cuts}} have a proposal. Shortcuts: Alt+J / Alt+L at the selected clip's cut, or the cut nearest the playhead; Shift+Alt+J opens this panel.",
						{
							actionable: String(actionable.length),
							reasons: plan.skipped
								.map((skip) => reasonLabel(skip.reason))
								.join(", "),
							total: plan.proposals.length,
							totalText: String(plan.proposals.length),
						}
					)}
				</small>
			)}
		</RyuAppSection>
	);
}
