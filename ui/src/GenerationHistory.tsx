import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";
import { useEffect, useState } from "react";
import {
	type GenerationJob,
	generationJobSchema,
} from "../../shared/generation.ts";
import type { Asset } from "../../shared/project.ts";
import { request } from "./bridge.ts";

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
					request<BudgetSnapshot>("/budget").catch(() => null),
					request<AuditSnapshot>("/budget/audit").catch(() => null),
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
				const result = await request<{ jobs: unknown[] }>(
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
						Tracked users: {Object.keys(budget.users ?? {}).length} · agents:{" "}
						{Object.keys(budget.agents ?? {}).length} · sessions:{" "}
						{Object.keys(budget.sessions ?? {}).length} · unit:{" "}
						{budget.unit ?? "micro_usd"}
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
								Actual Gateway cost:{" "}
								{entry.cost_micro_usd === null
									? "unavailable"
									: `${entry.cost_micro_usd} micro-USD`}
								{entry.feature ? ` · feature ${entry.feature}` : ""}
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
								{job.request.kind === "audio"
									? "Narration"
									: job.request.kind === "image"
										? "Image"
										: "Video"}{" "}
								·{" "}
								{job.status === "completed"
									? "Saved"
									: job.status === "requested"
										? "Requested"
										: "Needs review"}{" "}
								· {formatDateTime(job.createdAt)}
							</summary>
							<p>{job.request.prompt}</p>
							<p>
								Requested provider: {job.request.provider || "Node default"}.
								Model: {job.request.model || "Node default"}.
							</p>
							<p>
								Requested route: {job.request.route}. Core/Gateway may resolve a
								different provider.
							</p>
							{job.request.rationale && (
								<p>Decision note: {job.request.rationale}</p>
							)}
							{audit?.reachable && (
								<p>
									Gateway receipt:{" "}
									{receipt
										? `${receipt.provider ?? "provider unavailable"} · ${receipt.cost_micro_usd === null ? "cost unavailable" : `${receipt.cost_micro_usd} micro-USD`}`
										: "no matching Gateway row"}
								</p>
							)}
							{job.request.kind === "audio" && (
								<p>
									Voice: {job.request.voice || "Engine default"} · Language:{" "}
									{job.request.language || "Engine default"} · Rate:{" "}
									{job.request.speed}×
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
									Saved media:{" "}
									{assets.find((asset) => asset.id === id)?.name ||
										"Media no longer available"}
								</p>
							))}
						</details>
					);
				})}
			</RyuAppSection>
		</>
	);
}
