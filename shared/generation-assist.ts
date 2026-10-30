/**
 * Helpers around the Generate panel that never call a provider themselves:
 * the model catalog options (from the host's secret-free catalog), the cost
 * preview against the project budget, `@asset` mentions that become image
 * references, the prompt-enhance request, and per-viewer prompt drafts.
 */
import { z } from "zod";
import { MAX_REFERENCE_IMAGES } from "./generation.ts";
import {
	type ProductionBudgetStatus,
	type ProductionKind,
	productionBudgetSchema,
} from "./production-budget.ts";
import type { Asset } from "./project.ts";

// --- Model catalog ---------------------------------------------------------

const catalogSchema = z.looseObject({
	current: z
		.looseObject({
			model: z.string().nullable().optional(),
			provider: z.string().optional(),
		})
		.optional(),
	providers: z
		.array(
			z.looseObject({
				configured: z.boolean().optional(),
				id: z.string().min(1),
				label: z.string().optional(),
				suggestedModels: z.array(z.string()).optional(),
			})
		)
		.default([]),
});

export interface GenerationModelOption {
	/** `provider/model`, the select value. */
	key: string;
	label: string;
	model: string;
	provider: string;
	providerLabel: string;
}

/** Most models one provider contributes to the picker. */
const MODELS_PER_PROVIDER = 24;

/**
 * Picker options from the host catalog snapshot: the node's current model
 * first, then each configured provider's suggested (or discovered) models.
 * An unreadable snapshot yields no options, and the panel keeps its
 * free-text fields.
 */
export function generationModelOptions(
	snapshot: unknown,
	discovered: Readonly<Record<string, readonly string[]>> = {}
): GenerationModelOption[] {
	const parsed = catalogSchema.safeParse(snapshot);
	if (!parsed.success) {
		return [];
	}
	const options: GenerationModelOption[] = [];
	const seen = new Set<string>();
	const add = (provider: string, providerLabel: string, model: string) => {
		const trimmed = model.trim();
		const key = `${provider}/${trimmed}`;
		if (!trimmed || seen.has(key) || trimmed.length > 200) {
			return;
		}
		seen.add(key);
		options.push({
			key,
			label: `${trimmed} · ${providerLabel}`,
			model: trimmed,
			provider,
			providerLabel,
		});
	};
	const providers = parsed.data.providers.filter(
		(provider) => provider.configured !== false
	);
	const { current } = parsed.data;
	const currentProvider = providers.find(
		(provider) => provider.id === current?.provider
	);
	if (currentProvider && current?.model) {
		add(
			currentProvider.id,
			currentProvider.label ?? currentProvider.id,
			current.model
		);
	}
	for (const provider of providers) {
		const models = [
			...(discovered[provider.id] ?? []),
			...(provider.suggestedModels ?? []),
		].slice(0, MODELS_PER_PROVIDER);
		for (const model of models) {
			add(provider.id, provider.label ?? provider.id, model);
		}
	}
	return options;
}

// --- Cost preview ----------------------------------------------------------

export interface GenerationCostPreview {
	/** Whether the project budget admits this request. */
	allowed: boolean;
	estimateMicroUsd: number;
	/** 0 means no cap is set. */
	limitMicroUsd: number;
	/** What is left after spent, reserved and unsettled requests; null without a cap. */
	remainingMicroUsd: number | null;
}

/**
 * The project's planning estimate for one request of `kind` and what the
 * budget has left, using the same admission rule the sidecar enforces.
 * Gateway receipts stay authoritative for the real charge.
 */
export function generationCostPreview(
	productionBudget: unknown,
	status: Pick<
		ProductionBudgetStatus,
		"atRiskMicroUsd" | "reservedMicroUsd" | "spentMicroUsd"
	> | null,
	kind: ProductionKind
): GenerationCostPreview {
	const budget = productionBudgetSchema.parse(productionBudget ?? {});
	const estimateMicroUsd = budget.estimates[kind];
	const limitMicroUsd = budget.limitMicroUsd;
	if (limitMicroUsd === 0) {
		return {
			allowed: true,
			estimateMicroUsd,
			limitMicroUsd,
			remainingMicroUsd: null,
		};
	}
	const committed = status
		? status.spentMicroUsd + status.reservedMicroUsd + status.atRiskMicroUsd
		: 0;
	return {
		allowed: committed + estimateMicroUsd <= limitMicroUsd,
		estimateMicroUsd,
		limitMicroUsd,
		remainingMicroUsd: Math.max(0, limitMicroUsd - committed),
	};
}

/** Dollars with cents (or tenths of a cent below one cent). */
export function formatMicroUsd(value: number): string {
	const dollars = value / 1_000_000;
	return dollars > 0 && dollars < 0.01
		? `$${dollars.toFixed(3)}`
		: `$${dollars.toFixed(2)}`;
}

// --- @mentions -------------------------------------------------------------

/** The token that mentions `asset`: its name without extension, spaces as hyphens. */
export function mentionToken(asset: Pick<Asset, "name">): string {
	const stem = asset.name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
	return (
		stem
			.trim()
			.replace(/\s+/g, "-")
			.replace(/[^\p{L}\p{N}_.-]/gu, "")
			.replace(/\.+$/, "")
			.slice(0, 60) || "asset"
	);
}

const MENTION = /(^|[\s(])@([\p{L}\p{N}_.-]+)/gu;

export interface ResolvedMentions {
	/** Image asset ids, in mention order, at most MAX_REFERENCE_IMAGES. */
	ids: string[];
	/** The prompt with each mention replaced by "reference image N". */
	prompt: string;
	/** Mentions that match no library image. */
	unknown: string[];
}

/**
 * Resolve `@token` mentions of library images. Each distinct image becomes
 * a reference (numbered in first-mention order) and its mentions read
 * "reference image N" in the prompt sent to the model.
 */
export function resolvePromptMentions(
	prompt: string,
	assets: readonly Pick<Asset, "id" | "kind" | "name">[]
): ResolvedMentions {
	const images = assets.filter((asset) => asset.kind === "image");
	const byToken = new Map<string, string>();
	for (const asset of images) {
		const token = mentionToken(asset).toLowerCase();
		if (!byToken.has(token)) {
			byToken.set(token, asset.id);
		}
	}
	const ids: string[] = [];
	const unknown: string[] = [];
	const text = prompt.replace(MENTION, (whole, lead: string, raw: string) => {
		const token = raw.replace(/[.]+$/, "");
		const trailing = raw.slice(token.length);
		const id = byToken.get(token.toLowerCase());
		if (!id) {
			if (!unknown.includes(token)) {
				unknown.push(token);
			}
			return whole;
		}
		if (!ids.includes(id)) {
			if (ids.length >= MAX_REFERENCE_IMAGES) {
				throw new Error(
					`Mention at most ${MAX_REFERENCE_IMAGES} reference images.`
				);
			}
			ids.push(id);
		}
		return `${lead}reference image ${ids.indexOf(id) + 1}${trailing}`;
	});
	return { ids, prompt: text, unknown };
}

/** The partial `@query` that ends at `cursor`, or null when none is being typed. */
export function mentionQueryAt(prompt: string, cursor: number): string | null {
	const before = prompt.slice(0, cursor);
	const match = /(?:^|[\s(])@([\p{L}\p{N}_.-]*)$/u.exec(before);
	return match ? (match[1] ?? "") : null;
}

/** Library images whose mention token starts with (then contains) `query`. */
export function mentionSuggestions<T extends Pick<Asset, "kind" | "name">>(
	query: string,
	assets: readonly T[],
	limit = 6
): T[] {
	const needle = query.toLowerCase();
	const images = assets.filter((asset) => asset.kind === "image");
	const starts = images.filter((asset) =>
		mentionToken(asset).toLowerCase().startsWith(needle)
	);
	const contains = images.filter(
		(asset) =>
			!starts.includes(asset) &&
			mentionToken(asset).toLowerCase().includes(needle)
	);
	return [...starts, ...contains].slice(0, limit);
}

/** Replace the `@query` ending at `cursor` with `asset`'s mention. */
export function insertMention(
	prompt: string,
	cursor: number,
	asset: Pick<Asset, "name">
): { cursor: number; prompt: string } {
	const query = mentionQueryAt(prompt, cursor);
	const start = query === null ? cursor : cursor - query.length - 1;
	const mention = `@${mentionToken(asset)} `;
	const next = prompt.slice(0, start) + mention + prompt.slice(cursor);
	return { cursor: start + mention.length, prompt: next };
}

// --- Prompt enhance --------------------------------------------------------

const ENHANCE_GUIDE: Record<ProductionKind, string> = {
	audio:
		"Rewrite it as a narration script that reads naturally aloud: clear sentences, natural pauses, no stage directions or speaker labels.",
	image:
		"Rewrite it as one detailed image prompt: subject, composition, framing, lighting, color palette, style and mood.",
	video:
		"Rewrite it as one detailed video prompt: subject, action and motion, camera movement, framing, lighting, style and pacing over a few seconds.",
};

/** The model.complete request that rewrites a direction for `kind`. */
export function enhancePromptRequest(
	kind: ProductionKind,
	prompt: string
): { prompt: string; system: string } {
	return {
		prompt: prompt.trim().slice(0, 4000),
		system: `You improve prompts for a media generation model. ${ENHANCE_GUIDE[kind]} Keep every @mention exactly as written. Keep the user's intent, subject and language; do not add brands, real people or text that was not asked for. Reply with the rewritten prompt only, under 1,200 characters, with no preamble or quotes.`,
	};
}

/** The rewritten prompt from a model reply, or an error for an empty one. */
export function parseEnhancedPrompt(reply: string): string {
	const text = reply
		.replace(/^```[a-z]*\n?|\n?```$/gi, "")
		.replace(/^\s*(?:enhanced |rewritten )?prompt\s*:\s*/i, "")
		.trim()
		.replace(/^["“](.*)["”]$/s, "$1")
		.trim()
		.slice(0, 8000);
	if (!text) {
		throw new Error("The model returned an empty prompt.");
	}
	return text;
}

// --- Drafts ----------------------------------------------------------------

export const MAX_PROMPT_DRAFTS = 20;

export const generationDraftSchema = z
	.object({
		id: z.string().min(1).max(64),
		kind: z.enum(["image", "video", "audio"]),
		prompt: z.string().min(1).max(8000),
		savedAt: z.string(),
	})
	.strict();
export type GenerationDraft = z.infer<typeof generationDraftSchema>;
export const generationDraftsSchema = z
	.array(generationDraftSchema)
	.max(MAX_PROMPT_DRAFTS);

/** Add or refresh a draft (same kind and text moves to the top), newest first. */
export function saveDraft(
	drafts: readonly GenerationDraft[],
	draft: Omit<GenerationDraft, "id" | "savedAt">,
	now = new Date()
): GenerationDraft[] {
	const prompt = draft.prompt.trim();
	if (!prompt) {
		return [...drafts];
	}
	const existing = drafts.find(
		(item) => item.kind === draft.kind && item.prompt === prompt
	);
	const saved: GenerationDraft = {
		id: existing?.id ?? crypto.randomUUID(),
		kind: draft.kind,
		prompt,
		savedAt: now.toISOString(),
	};
	return [saved, ...drafts.filter((item) => item.id !== saved.id)].slice(
		0,
		MAX_PROMPT_DRAFTS
	);
}

/** The viewer-storage key for one project's prompt drafts. */
export const draftsStorageKey = (projectId: string) =>
	`generation-drafts.${projectId}`;
