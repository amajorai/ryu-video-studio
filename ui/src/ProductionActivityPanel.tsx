import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useEffect, useState } from "react";
import { productionActivitySchema } from "../../shared/production-activity.ts";
import { request } from "./bridge.ts";

export function ProductionActivityPanel({
	projectId,
	revision,
}: {
	projectId: string;
	revision: number;
}) {
	const [state, setState] = useState<
		| { kind: "loading" }
		| {
				kind: "ready";
				events: ReturnType<typeof productionActivitySchema.parse>["events"];
		  }
		| { kind: "error"; message: string }
	>({ kind: "loading" });
	useEffect(() => {
		let mounted = true;
		setState({ kind: "loading" });
		void request<unknown>(`/projects/${projectId}/activity`)
			.then((value) => {
				if (mounted) {
					setState({
						kind: "ready",
						events: productionActivitySchema.parse(value).events,
					});
				}
			})
			.catch((error) => {
				if (mounted) {
					setState({
						kind: "error",
						message:
							error instanceof Error ? error.message : "Activity unavailable.",
					});
				}
			});
		return () => {
			mounted = false;
		};
	}, [projectId, revision]);
	return (
		<RyuAppSection title="Production activity">
			<p className="text-muted-foreground">
				A saved run ledger for this project. It reports app-owned state and
				export reviews; provider spend remains Gateway-owned.
			</p>
			{state.kind === "loading" && <p>Loading activity…</p>}
			{state.kind === "error" && <p>{state.message}</p>}
			{state.kind === "ready" && !state.events.length && (
				<p>No production activity has been recorded yet.</p>
			)}
			{state.kind === "ready" && state.events.length > 0 && (
				<div className="studio-activity-list">
					{state.events.slice(0, 12).map((event) => (
						<div className="studio-activity-item" key={event.id}>
							<div>
								<strong>{event.title}</strong>
								<small>{event.detail}</small>
							</div>
							<span
								className={`studio-activity-status studio-activity-status-${event.status}`}
							>
								{event.status}
							</span>
						</div>
					))}
				</div>
			)}
		</RyuAppSection>
	);
}
