import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
	type GenerationJob,
	generationJobSchema,
	generationRequestLabel,
	requestInputImageIds,
} from "../../shared/generation.ts";
import type { Asset } from "../../shared/project.ts";
import { request } from "./bridge.ts";

const budgetSnapshotResponseSchema: z.ZodType<BudgetSnapshot> = z.object({
	agents: z.record(z.string(), z.number()).optional(),
	limits: z
		.object({
			users: z.record(z.string(), z.number()).optional(),
			agents: z.record(z.string(), z.number()).optional(),
			session: z.number().optional(),
		})
		.optional(),
	reachable: z.boolean(),
	sessions: z.record(z.string(), z.number()).optional(),
	unit: z.string().optional(),
	users: z.record(z.string(), z.number()).optional(),
});
const auditEntryResponseSchema: z.ZodType<AuditEntry> = z.object({
	cost_micro_usd: z.union([z.number(), z.null()]),
	error: z.union([z.string(), z.null()]),
	event_type: z.union([z.string(), z.null()]),
	feature: z.union([z.string(), z.null()]),
	id: z.string(),
	model: z.union([z.string(), z.null()]),
	provider: z.union([z.string(), z.null()]),
	request_id: z.string(),
	source: z.string().optional(),
	timestamp: z.string(),
});
const auditSnapshotResponseSchema: z.ZodType<AuditSnapshot> = z.object({
	entries: z.array(auditEntryResponseSchema),
	reachable: z.boolean(),
});

interface BudgetSnapshot {
	agents?: Record<string, number>;
	limits?: {
		users?: Record<string, number>;
		agents?: Record<string, number>;
		session?: number;
	};
	reachable: boolean;
	sessions?: Record<string, number>;
	unit?: string;
	users?: Record<string, number>;
}

interface AuditEntry {
	cost_micro_usd: number | null;
	error: string | null;
	event_type: string | null;
	feature: string | null;
	id: string;
	model: string | null;
	provider: string | null;
	request_id: string;
	source?: string;
	timestamp: string;
}

interface AuditSnapshot {
	entries: AuditEntry[];
	reachable: boolean;
}

/** Names of a request's input images (edited still first), or "" when none. */
export function inputImageNames(
	job: GenerationJob,
	assets: readonly Pick<Asset, "id" | "name">[]
): string {
	return requestInputImageIds(job.request)
		.map(
			(id) =>
				assets.find((asset) => asset.id === id)?.name ??
				"Media no longer available"
		)
		.join(", ");
}

export function GenerationHistory({
	projectId,
	revision,
	assets,
	onStatus,
}: {
	projectId: string;
	revision: number;
	assets: Asset[];
	onStatus: (message: string) => void;
}) {
	const tl = useLiteralMessages();
	const [jobs, setJobs] = useState<GenerationJob[]>([]);
	const [budget, setBudget] = useState<BudgetSnapshot | null>(null);
	const [audit, setAudit] = useState<AuditSnapshot | null>(null);

	useEffect(() => {
		let mounted = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending = false;
		let pendingIds = new Set<string>();
		let metadataPending = false;
		let metadataQueued = false;
		let lastMetadataAt = 0;
		setJobs([]);
		const refreshMetadata = async () => {
			if (!(mounted && isViewVisible())) {
				return;
			}
			if (metadataPending) {
				metadataQueued = true;
				return;
			}
			metadataPending = true;
			metadataQueued = false;
			lastMetadataAt = Date.now();
			try {
				const [budgetResult, auditResult] = await Promise.all([
					request(budgetSnapshotResponseSchema, "/budget").catch(() => null),
					request(auditSnapshotResponseSchema, "/budget/audit").catch(
						() => null
					),
				]);
				if (mounted) {
					setBudget(budgetResult);
					setAudit(auditResult);
				}
			} finally {
				metadataPending = false;
				if (metadataQueued && mounted && isViewVisible()) {
					void refreshMetadata();
				}
			}
		};
		const load = async () => {
			if (!mounted || pending || !isViewVisible()) {
				return;
			}
			clearTimeout(timer);
			pending = true;
			try {
				const result = await request(
					z.object({ jobs: z.array(z.json()) }),
					`/generations?projectId=${projectId}`
				);
				const next = result.jobs.map((job) => generationJobSchema.parse(job));
				if (!mounted) {
					return;
				}
				setJobs(next);
				const nextPending = new Set(
					next.filter((job) => job.status === "requested").map((job) => job.id)
				);
				if (
					[...pendingIds].some((id) => !nextPending.has(id)) ||
					Date.now() - lastMetadataAt >= 30_000
				) {
					void refreshMetadata();
				}
				pendingIds = nextPending;
			} catch (error) {
				if (mounted) {
					onStatus(
						error instanceof Error
							? error.message
							: "Generation history unavailable."
					);
				}
			} finally {
				pending = false;
				if (mounted && pendingIds.size > 0 && isViewVisible()) {
					timer = setTimeout(() => void load(), 2000);
				}
			}
		};
		const refreshVisible = () => {
			clearTimeout(timer);
			if (isViewVisible()) {
				void refreshMetadata();
				void load();
			}
		};
		const unsubscribe = subscribeViewVisibility(refreshVisible);
		refreshVisible();
		return () => {
			mounted = false;
			unsubscribe();
			clearTimeout(timer);
		};
	}, [projectId, revision, onStatus]);

	const gatewayCost = (micro: number | null) =>
		micro === null
			? tl("unavailable")
			: tl("{amount} micro-USD", { amount: String(micro) });

	return (
		<>
			<RyuAppSection title="Gateway budget">
				{budget?.reachable ? (
					<p>
						Charged spend is visible from the Gateway. Counters are node-wide
						and are not attributed to this project.
					</p>
				) : (
					<p>Gateway spend is unavailable on this host.</p>
				)}
				{budget?.reachable && (
					<p>
						{tl(
							"Tracked users: {users} · agents: {agents} · sessions: {sessions} · unit: {unit}",
							{
								agents: String(Object.keys(budget.agents ?? {}).length),
								sessions: String(Object.keys(budget.sessions ?? {}).length),
								unit: budget.unit ?? "micro_usd",
								users: String(Object.keys(budget.users ?? {}).length),
							}
						)}
					</p>
				)}
			</RyuAppSection>
			<RyuAppSection title="Gateway audit">
				<p>
					Recent redacted provider records from Gateway. These are node-wide and
					do not claim project attribution.
				</p>
				{audit?.reachable && audit.entries.length ? (
					audit.entries.slice(0, 8).map((entry) => (
						<div className="studio-scene" key={entry.id}>
							<strong>
								{entry.provider ?? "Unknown provider"} ·{" "}
								{entry.model ?? "Unknown model"}
							</strong>
							<small>
								{formatDateTime(entry.timestamp)} ·{" "}
								{entry.event_type ?? "event"}
							</small>
							<p>
								{entry.feature
									? tl("Actual Gateway cost: {cost} · feature {feature}", {
											cost: gatewayCost(entry.cost_micro_usd),
											feature: entry.feature,
										})
									: tl("Actual Gateway cost: {cost}", {
											cost: gatewayCost(entry.cost_micro_usd),
										})}
							</p>
						</div>
					))
				) : (
					<p>Gateway audit is unavailable or has no recent entries.</p>
				)}
			</RyuAppSection>
			<RyuAppSection title="Generation history">
				<p>
					Saved requests and outputs for this project. Exact Gateway receipts
					are shown only when the node returns a matching request ID.
				</p>
				{!jobs.length && (
					<p>No generation requests recorded for this project.</p>
				)}
				{jobs.map((job) => {
					const receipt = audit?.entries.find(
						(entry) => entry.request_id === job.id
					);
					return (
						<details className="studio-scene" key={job.id}>
							<summary>
								{generationRequestLabel(job.request)} ·{" "}
								{job.status === "completed"
									? "Saved"
									: job.status === "requested"
										? "Requested"
										: "Needs review"}{" "}
								· {formatDateTime(job.createdAt)}
							</summary>
							<p>{job.request.prompt}</p>
							<p>
								{tl("Requested provider: {provider}. Model: {model}.", {
									model: job.request.model || tl("Node default"),
									provider: job.request.provider || tl("Node default"),
								})}
							</p>
							<p>
								{tl(
									"Requested route: {route}. Core/Gateway may resolve a different provider.",
									{ route: job.request.route }
								)}
							</p>
							{inputImageNames(job, assets) && (
								<p>
									{tl("Input images: {names}", {
										names: inputImageNames(job, assets),
									})}
								</p>
							)}
							{job.request.rationale && (
								<p>
									{tl("Decision note: {rationale}", {
										rationale: job.request.rationale,
									})}
								</p>
							)}
							{audit?.reachable && (
								<p>
									{receipt
										? tl("Gateway receipt: {provider} · {cost}", {
												cost:
													receipt.cost_micro_usd === null
														? tl("cost unavailable")
														: tl("{amount} micro-USD", {
																amount: String(receipt.cost_micro_usd),
															}),
												provider:
													receipt.provider ?? tl("provider unavailable"),
											})
										: tl("Gateway receipt: no matching Gateway row")}
								</p>
							)}
							{job.request.kind === "audio" && (
								<p>
									{tl(
										"Voice: {voice} · Language: {language} · Rate: {speed}×",
										{
											language: job.request.language || tl("Engine default"),
											speed: String(job.request.speed),
											voice: job.request.voice || tl("Engine default"),
										}
									)}
								</p>
							)}
							{job.message && <p>{job.message}</p>}
							{(job.status === "incomplete" ||
								job.status === "interrupted") && (
								<p>
									Check the provider before retrying; this request may already
									have incurred a charge.
								</p>
							)}
							{job.assetIds.map((id) => (
								<p key={id}>
									{tl("Saved media: {name}", {
										name:
											assets.find((asset) => asset.id === id)?.name ||
											tl("Media no longer available"),
									})}
								</p>
							))}
						</details>
					);
				})}
			</RyuAppSection>
		</>
	);
}
