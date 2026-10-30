import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import { z } from "zod";
import { generationModelOptions } from "../../../shared/generation-assist.ts";

const discoverySchema = z.looseObject({
	models: z.array(z.looseObject({ id: z.string() })),
});
const providerIdsSchema = z.looseObject({
	providers: z.array(
		z.looseObject({
			configured: z.boolean().optional(),
			id: z.string(),
			supportsDiscovery: z.boolean().optional(),
		})
	),
});

const CUSTOM = "custom";
/** Providers asked at most per discovery, to keep the request bounded. */
const MAX_DISCOVERY_PROVIDERS = 6;

/**
 * Pick the generation model from the node's model catalog, or type a
 * provider and model. Without catalog access (an older host, or the optional
 * grant declined) it falls back to the two free-text fields.
 */
export function GenerationModelField({
	disabled,
	model,
	onChange,
	provider,
}: {
	disabled: boolean;
	model: string;
	onChange: (next: { model: string; provider: string }) => void;
	provider: string;
}) {
	const catalog =
		typeof window === "undefined" ? undefined : window.ryu?.catalog;
	const [snapshot, setSnapshot] = useState<unknown>(null);
	const [discovered, setDiscovered] = useState<Record<string, string[]>>({});
	const [custom, setCustom] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	useEffect(() => {
		if (!catalog) {
			return;
		}
		let active = true;
		catalog
			.snapshot()
			.then((value) => {
				if (active) {
					setSnapshot(value);
				}
			})
			.catch(() => {
				if (active) {
					setNote("The model catalog is unavailable; type a model instead.");
				}
			});
		return () => {
			active = false;
		};
	}, [catalog]);
	const options = generationModelOptions(snapshot, discovered);
	const selected = provider || model ? `${provider}/${model}` : "";
	const listed = options.some((option) => option.key === selected);
	const showCustom =
		!(catalog && options.length) || custom || !(listed || selected === "");
	const discover = async () => {
		if (!catalog) {
			return;
		}
		const parsed = providerIdsSchema.safeParse(snapshot);
		const providers = parsed.success
			? parsed.data.providers
					.filter((item) => item.configured !== false && item.supportsDiscovery)
					.slice(0, MAX_DISCOVERY_PROVIDERS)
			: [];
		if (!providers.length) {
			setNote("No configured provider supports model discovery.");
			return;
		}
		setNote("Discovering models…");
		const found: Record<string, string[]> = {};
		for (const item of providers) {
			try {
				const reply = discoverySchema.parse(
					await catalog.models({ providerId: item.id })
				);
				found[item.id] = reply.models.map((entry) => entry.id);
			} catch {
				// A provider that cannot list models keeps its suggestions.
			}
		}
		setDiscovered(found);
		setNote(
			`Found ${Object.values(found).reduce((sum, ids) => sum + ids.length, 0)} models.`
		);
	};
	return (
		<>
			{catalog && options.length ? (
				<RyuAppField label="Model">
					<div className="flex items-center gap-2">
						<NativeSelect
							aria-label="Generation model"
							className="min-w-0 flex-1"
							disabled={disabled}
							onChange={(event) => {
								const value = event.target.value;
								if (value === CUSTOM) {
									setCustom(true);
									return;
								}
								setCustom(false);
								const option = options.find((item) => item.key === value);
								onChange({
									model: option?.model ?? "",
									provider: option?.provider ?? "",
								});
							}}
							value={showCustom ? CUSTOM : selected}
						>
							<NativeSelectOption value="">Node default</NativeSelectOption>
							{options.map((option) => (
								<NativeSelectOption key={option.key} value={option.key}>
									{option.label}
								</NativeSelectOption>
							))}
							<NativeSelectOption value={CUSTOM}>Custom…</NativeSelectOption>
						</NativeSelect>
						<Button
							disabled={disabled}
							onClick={() => {
								discover().catch(() => undefined);
							}}
							size="sm"
							type="button"
							variant="outline"
						>
							Discover models
						</Button>
					</div>
				</RyuAppField>
			) : null}
			{showCustom ? (
				<>
					<RyuAppField label="Provider (optional)">
						<Input
							disabled={disabled}
							onChange={(event) =>
								onChange({ model, provider: event.target.value })
							}
							placeholder="Use node default"
							value={provider}
						/>
					</RyuAppField>
					<RyuAppField label="Model (optional)">
						<Input
							disabled={disabled}
							onChange={(event) =>
								onChange({ model: event.target.value, provider })
							}
							placeholder="Use node default"
							value={model}
						/>
					</RyuAppField>
				</>
			) : null}
			{note ? <small role="status">{note}</small> : null}
		</>
	);
}
