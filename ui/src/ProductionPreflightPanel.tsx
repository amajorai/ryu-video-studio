import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { productionPreflightSchema } from "../../shared/production-preflight.ts";
import { request } from "./bridge.ts";

const dollars = (microUsd: number) => (microUsd / 1_000_000).toFixed(2);

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
									{state.value.stages.completed}/{state.value.stages.total}{" "}
									stages complete · next {state.value.nextStage ?? "none"}
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
								${dollars(state.value.budget.reservedMicroUsd)} reserved
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
