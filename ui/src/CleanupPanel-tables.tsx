import { Badge, Button, Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import type { Dispatch, SetStateAction } from "react";
import type { FillerHit, TimelineRange } from "../../shared/filler-words.ts";
import { hitKey, kindLabels, rangeKey } from "./CleanupPanel-plan.ts";
import { timelineClock } from "./editing-ui.ts";

/** Filler hits found by the plan, each selectable for removal. */
export function FillerHitsTable({
	disabled,
	hits,
	onSeek,
	selectedHits,
	setSelectedHits,
}: {
	disabled: boolean;
	hits: FillerHit[];
	onSeek: (time: number) => void;
	selectedHits: Set<string>;
	setSelectedHits: Dispatch<SetStateAction<Set<string>>>;
}) {
	const tl = useLiteralMessages();
	return (
		<Table aria-label="Filler words found">
			<TableHeader>
				<TableRow>
					<TableHead>Remove</TableHead>
					<TableHead>Time</TableHead>
					<TableHead>Word</TableHead>
					<TableHead>Kind</TableHead>
					<TableHead>
						<span className="sr-only">Seek</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{hits.map((hit) => {
					const key = hitKey(hit);
					const label = `“${hit.text}” at ${timelineClock(hit.start)}`;
					return (
						<TableRow key={key}>
							<TableCell>
								<Checkbox
									aria-label={tl("Remove {label}", { label })}
									checked={selectedHits.has(key)}
									disabled={disabled}
									onCheckedChange={(checked) =>
										setSelectedHits((current) => {
											const next = new Set(current);
											if (checked) {
												next.add(key);
											} else {
												next.delete(key);
											}
											return next;
										})
									}
								/>
							</TableCell>
							<TableCell className="font-mono">
								{timelineClock(hit.start)}
							</TableCell>
							<TableCell>{hit.text}</TableCell>
							<TableCell>
								<Badge variant="secondary">{kindLabels[hit.kind]}</Badge>
							</TableCell>
							<TableCell>
								<Button
									aria-label={tl("Seek to {label}", { label })}
									onClick={() => onSeek(Math.max(0, hit.start - 1))}
									size="sm"
									variant="ghost"
								>
									Seek
								</Button>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

/** Dead-air pauses found by the plan, each selectable for removal. */
export function PausesTable({
	deadAir,
	disabled,
	onSeek,
	selectedGaps,
	setSelectedGaps,
}: {
	deadAir: TimelineRange[];
	disabled: boolean;
	onSeek: (time: number) => void;
	selectedGaps: Set<string>;
	setSelectedGaps: Dispatch<SetStateAction<Set<string>>>;
}) {
	const tl = useLiteralMessages();
	return (
		<Table aria-label="Pauses found">
			<TableHeader>
				<TableRow>
					<TableHead>Remove</TableHead>
					<TableHead>From</TableHead>
					<TableHead>Length</TableHead>
					<TableHead>
						<span className="sr-only">Seek</span>
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{deadAir.map((range) => {
					const key = rangeKey(range);
					const label = tl("pause at {time}", {
						time: timelineClock(range.start),
					});
					return (
						<TableRow key={key}>
							<TableCell>
								<Checkbox
									aria-label={tl("Remove {label}", { label })}
									checked={selectedGaps.has(key)}
									disabled={disabled}
									onCheckedChange={(checked) =>
										setSelectedGaps((current) => {
											const next = new Set(current);
											if (checked) {
												next.add(key);
											} else {
												next.delete(key);
											}
											return next;
										})
									}
								/>
							</TableCell>
							<TableCell className="font-mono">
								{timelineClock(range.start)}
							</TableCell>
							<TableCell className="font-mono">
								{(range.end - range.start).toFixed(2)}s
							</TableCell>
							<TableCell>
								<Button
									aria-label={tl("Seek to {label}", { label })}
									onClick={() => onSeek(Math.max(0, range.start - 1))}
									size="sm"
									variant="ghost"
								>
									Seek
								</Button>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
