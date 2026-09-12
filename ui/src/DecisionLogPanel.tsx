import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import type { Project } from "../../shared/project.ts";

export function DecisionLogPanel({
	onAppend,
	project,
}: {
	onAppend: (decision: Project["decisions"][number]) => void;
	project: Project;
}) {
	const [category, setCategory] = useState("render_runtime");
	const [subject, setSubject] = useState("");
	const [decision, setDecision] = useState("");
	const [rationale, setRationale] = useState("");
	const append = () => {
		const trimmedSubject = subject.trim();
		const trimmedDecision = decision.trim();
		if (!(trimmedSubject && trimmedDecision)) {
			return;
		}
		onAppend({
			category: category.trim() || "creative",
			createdAt: new Date().toISOString(),
			decision: trimmedDecision,
			id: crypto.randomUUID(),
			optionsConsidered: [],
			rationale: rationale.trim(),
			subject: trimmedSubject,
		});
		setSubject("");
		setDecision("");
		setRationale("");
	};
	return (
		<RyuAppSection title="Decision log">
			<p className="text-muted-foreground">
				Append the provider, model, runtime, or creative choice before a
				consequential production step. Existing entries stay immutable.
			</p>
			<RyuAppField label="Category">
				<Input
					aria-label="Decision category"
					onChange={(event) => setCategory(event.target.value)}
					value={category}
				/>
			</RyuAppField>
			<RyuAppField label="Subject">
				<Input
					aria-label="Decision subject"
					onChange={(event) => setSubject(event.target.value)}
					placeholder="Composition runtime"
					value={subject}
				/>
			</RyuAppField>
			<RyuAppField label="Decision">
				<Input
					aria-label="Decision choice"
					onChange={(event) => setDecision(event.target.value)}
					placeholder="Use FFmpeg for the local delivery render"
					value={decision}
				/>
			</RyuAppField>
			<RyuAppField label="Rationale">
				<Textarea
					aria-label="Decision rationale"
					onChange={(event) => setRationale(event.target.value)}
					placeholder="Why this path fits the brief"
					value={rationale}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={
						!(subject.trim() && decision.trim()) ||
						project.decisions.length >= 200
					}
					onClick={append}
					variant="outline"
				>
					Append decision
				</Button>
			</RyuAppActions>
			{project.decisions.length > 0 && (
				<div className="studio-activity-list">
					{project.decisions
						.slice()
						.reverse()
						.slice(0, 8)
						.map((entry) => (
							<div className="studio-activity-item" key={entry.id}>
								<div>
									<strong>{entry.subject}</strong>
									<small>
										{entry.category} · {entry.decision}
										{entry.rationale ? ` · ${entry.rationale}` : ""}
									</small>
								</div>
								<span className="studio-activity-status studio-activity-status-ready">
									logged
								</span>
							</div>
						))}
				</div>
			)}
		</RyuAppSection>
	);
}
