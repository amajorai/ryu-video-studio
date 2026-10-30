import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import {
	formatMicroUsd,
	generationCostPreview,
} from "../../../shared/generation-assist.ts";
import {
	type ProductionBudgetStatus,
	type ProductionKind,
	productionBudgetStatusSchema,
} from "../../../shared/production-budget.ts";
import { request } from "../bridge.ts";

const KIND_NOUN: Record<ProductionKind, string> = {
	audio: "narration",
	image: "image",
	video: "video",
};

/**
 * The project's planning estimate for one request and what its generation
 * budget has left, shown before Generate. Uses the same admission rule as
 * the sidecar; the provider's receipt (in Generation history) is the real
 * charge.
 */
export function GenerationCostEstimate({
	kind,
	productionBudget,
	projectId,
	revision,
}: {
	kind: ProductionKind;
	productionBudget: unknown;
	projectId: string;
	/** Refreshes the budget status (bump after each generation). */
	revision: number;
}) {
	const tl = useLiteralMessages();
	const [status, setStatus] = useState<ProductionBudgetStatus | null>(null);
	useEffect(() => {
		let active = true;
		request(productionBudgetStatusSchema, `/projects/${projectId}/budget`)
			.then((value) => {
				if (active) {
					setStatus(value);
				}
			})
			.catch(() => {
				if (active) {
					setStatus(null);
				}
			});
		return () => {
			active = false;
		};
	}, [projectId, revision]);
	const preview = generationCostPreview(productionBudget, status, kind);
	const estimate = formatMicroUsd(preview.estimateMicroUsd);
	const item = tl(KIND_NOUN[kind]);
	return (
		<div
			aria-live="polite"
			className="flex flex-col gap-1"
			data-generation-cost
		>
			<p>
				{preview.remainingMicroUsd === null
					? tl(
							"Planning estimate: {estimate} per {item}. This project has no budget cap.",
							{ estimate, item }
						)
					: tl(
							"Planning estimate: {estimate} per {item}. {remaining} of the {limit} project budget is left.",
							{
								estimate,
								item,
								limit: formatMicroUsd(preview.limitMicroUsd),
								remaining: formatMicroUsd(preview.remainingMicroUsd),
							}
						)}
			</p>
			{preview.allowed ? null : (
				<p role="alert">
					This request would exceed the project budget. Raise the budget in
					Production budget or review pending generations first.
				</p>
			)}
		</div>
	);
}
