import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Input } from "@ryu/blocks/companion/controls";
import { useEffect, useState } from "react";
import {
	type ProductionBudget,
	productionBudgetSchema,
	productionBudgetStatusSchema,
} from "../../shared/production-budget.ts";
import { request } from "./bridge.ts";

const dollars = (microUsd: number) => (microUsd / 1_000_000).toFixed(2);
const microUsdFromDollars = (value: string) => {
	const dollarsValue = Number(value);
	return Number.isFinite(dollarsValue) && dollarsValue >= 0
		? Math.min(1_000_000_000, Math.round(dollarsValue * 1_000_000))
		: 0;
};

export function ProductionBudgetPanel({
	budget,
	onChange,
	projectId,
	revision,
}: {
	budget: ProductionBudget;
	onChange: (budget: ProductionBudget) => void;
	projectId: string;
	revision: number;
}) {
	const [status, setStatus] = useState<
		| { kind: "loading" }
		| {
				kind: "ready";
				value: ReturnType<typeof productionBudgetStatusSchema.parse>;
		  }
		| { kind: "error"; message: string }
	>({ kind: "loading" });
	const parsed = productionBudgetSchema.parse(budget);
	useEffect(() => {
		let mounted = true;
		setStatus({ kind: "loading" });
		void request<unknown>(`/projects/${projectId}/budget`)
			.then((value) => {
				if (mounted) {
					setStatus({
						kind: "ready",
						value: productionBudgetStatusSchema.parse(value),
					});
				}
			})
			.catch((error) => {
				if (mounted) {
					setStatus({
						kind: "error",
						message:
							error instanceof Error
								? error.message
								: "Budget status unavailable.",
					});
				}
			});
		return () => {
			mounted = false;
		};
	}, [projectId, revision]);
	const update = (patch: Partial<ProductionBudget>) =>
		onChange(productionBudgetSchema.parse({ ...parsed, ...patch }));
	const updateEstimate = (
		kind: keyof ProductionBudget["estimates"],
		value: string
	) =>
		update({
			estimates: { ...parsed.estimates, [kind]: microUsdFromDollars(value) },
		});
	return (
		<RyuAppSection title="Production budget">
			<p className="text-muted-foreground">
				Set an app-owned admission cap for new image, video, and narration
				requests. Gateway receipts remain authoritative; unsettled requests keep
				their planning estimate reserved until a matching receipt appears.
			</p>
			<RyuAppField label="Project cap (USD, 0 means uncapped)">
				<Input
					aria-label="Project production budget cap"
					defaultValue={
						parsed.limitMicroUsd ? dollars(parsed.limitMicroUsd) : "0"
					}
					key={`${projectId}-${revision}-limit-${parsed.limitMicroUsd}`}
					min={0}
					onBlur={(event) =>
						update({ limitMicroUsd: microUsdFromDollars(event.target.value) })
					}
					step={0.01}
					type="number"
				/>
			</RyuAppField>
			<RyuAppField label="Image estimate (USD)">
				<Input
					aria-label="Image generation estimate"
					defaultValue={dollars(parsed.estimates.image)}
					key={`${projectId}-${revision}-image-${parsed.estimates.image}`}
					min={0}
					onBlur={(event) => updateEstimate("image", event.target.value)}
					step={0.01}
					type="number"
				/>
			</RyuAppField>
			<RyuAppField label="Video estimate (USD)">
				<Input
					aria-label="Video generation estimate"
					defaultValue={dollars(parsed.estimates.video)}
					key={`${projectId}-${revision}-video-${parsed.estimates.video}`}
					min={0}
					onBlur={(event) => updateEstimate("video", event.target.value)}
					step={0.01}
					type="number"
				/>
			</RyuAppField>
			<RyuAppField label="Narration estimate (USD)">
				<Input
					aria-label="Narration generation estimate"
					defaultValue={dollars(parsed.estimates.audio)}
					key={`${projectId}-${revision}-audio-${parsed.estimates.audio}`}
					min={0}
					onBlur={(event) => updateEstimate("audio", event.target.value)}
					step={0.01}
					type="number"
				/>
			</RyuAppField>
			{status.kind === "loading" && <p>Loading budget status…</p>}
			{status.kind === "error" && <p>{status.message}</p>}
			{status.kind === "ready" && (
				<p>
					Exact Gateway spend: ${dollars(status.value.spentMicroUsd)} ·
					Reserved: ${dollars(status.value.reservedMicroUsd)} · Unsettled: $
					{dollars(status.value.atRiskMicroUsd)}
					{status.value.availableMicroUsd === null
						? " · no cap"
						: ` · available: $${dollars(status.value.availableMicroUsd)}`}
				</p>
			)}
		</RyuAppSection>
	);
}
