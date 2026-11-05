import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { productionPreflightSchema } from "../../shared/production-preflight.ts";
import { request } from "./bridge.ts";
import { formatUsd } from "./i18n/units.ts";

export function ProductionPreflightPanel({
	projectId,
	revision,
}: {
	projectId: string;
	revision: number;
}) {
	const tl = useLiteralMessages();
	const [state, setState] = useState<
		| { kind: "loading" }
		| {
				kind: "ready";
				value: ReturnType<typeof productionPreflightSchema.parse>;
		  }
		| { kind: "error"; message: string }
	>({ kind: "loading" });
	useEffect(() => {
		let mounted = true;
		setState({ kind: "loading" });
		void request(z.json(), `/projects/${projectId}/preflight`)
			.then((value) => {
				if (mounted) {
					setState({
						kind: "ready",
						value: productionPreflightSchema.parse(value),
					});
				}
			})
			.catch((error) => {
				if (mounted) {
					setState({
						kind: "error",
						message:
							error instanceof Error
								? error.message
								: "Production preflight unavailable.",
					});
				}
			});
		return () => {
			mounted = false;
		};
	}, [projectId, revision]);
	return (
		<RyuAppSection title="Production preflight">
			<p className="text-muted-foreground">
				One saved snapshot for the next production action. It combines gates,
				stage progress, generation review, decisions, and budget admission.
			</p>
			{state.kind === "loading" && <p>Checking preflight…</p>}
			{state.kind === "error" && <p>{state.message}</p>}
			{state.kind === "ready" && (
				<>
					<strong>
						{state.value.ready
							? "Ready for delivery"
							: state.value.exportReady
								? "Ready to render; delivery review is still required"
								: "Resolve the blocked gates before rendering"}
					</strong>
					<div className="studio-activity-list">
						<div className="studio-activity-item">
							<div>
								<strong>Pipeline</strong>
								<small>
									{state.value.nextStage
										? tl("{completed}/{total} stages complete · next {stage}", {
												completed: state.value.stages.completed,
												stage: state.value.nextStage,
												total: state.value.stages.total,
											})
										: tl("{completed}/{total} stages complete · next none", {
												completed: state.value.stages.completed,
												total: state.value.stages.total,
											})}
								</small>
							</div>
							<span className="studio-activity-status">
								{tl("{decisions} decisions", {
									decisions: state.value.decisions,
								})}
							</span>
						</div>
						<div className="studio-activity-item">
							<div>
								<strong>Generation review</strong>
								<small>
									{tl("{pending} pending · {needsReview} need review", {
										needsReview: state.value.generations.needsReview,
										pending: state.value.generations.pending,
									})}
								</small>
							</div>
							<span className="studio-activity-status">
								{tl("{amount} reserved", {
									amount: formatUsd(state.value.budget.reservedMicroUsd),
								})}
							</span>
						</div>
					</div>
					{state.value.blockers.length > 0 && (
						<ul>
							{state.value.blockers.map((blocker) => (
								<li key={blocker.id}>
									<strong>{blocker.label}:</strong> {blocker.detail}
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</RyuAppSection>
	);
}
