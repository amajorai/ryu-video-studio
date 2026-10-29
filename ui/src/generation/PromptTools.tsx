import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	draftsStorageKey,
	enhancePromptRequest,
	type GenerationDraft,
	generationDraftsSchema,
	insertMention,
	mentionQueryAt,
	mentionSuggestions,
	mentionToken,
	parseEnhancedPrompt,
	saveDraft,
} from "../../../shared/generation-assist.ts";
import type { ProductionKind } from "../../../shared/production-budget.ts";
import type { Asset } from "../../../shared/project.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";

/**
 * The generation prompt with its helpers: `@` mentions of library images
 * (image generation sends them as references), an Enhance action that
 * rewrites the prompt through the node's model, and per-project drafts kept
 * in this browser.
 */
export function PromptTools({
	assets,
	disabled,
	kind,
	onPromptChange,
	onStatus,
	projectId,
	prompt,
}: {
	assets: readonly Asset[];
	disabled: boolean;
	kind: ProductionKind;
	onPromptChange: (prompt: string) => void;
	onStatus: (message: string) => void;
	projectId: string;
	prompt: string;
}) {
	const tl = useLiteralMessages();
	const [cursor, setCursor] = useState<number | null>(null);
	const [enhancing, setEnhancing] = useState(false);
	const [drafts, setDrafts] = useState<GenerationDraft[]>(() =>
		readViewerValue(draftsStorageKey(projectId), generationDraftsSchema, [])
	);
	const [previous, setPrevious] = useState<string | null>(null);
	const query = cursor === null ? null : mentionQueryAt(prompt, cursor);
	const suggestions =
		query === null || kind === "audio" ? [] : mentionSuggestions(query, assets);
	const complete =
		typeof window === "undefined" ? undefined : window.ryu?.model?.complete;
	const storeDrafts = (next: GenerationDraft[]) => {
		setDrafts(next);
		writeViewerValue(draftsStorageKey(projectId), next);
	};
	const enhance = async () => {
		if (!(complete && prompt.trim())) {
			return;
		}
		setEnhancing(true);
		onStatus("Enhancing the prompt with Ryu…");
		try {
			const rewritten = parseEnhancedPrompt(
				await complete(enhancePromptRequest(kind, prompt))
			);
			setPrevious(prompt);
			onPromptChange(rewritten);
			onStatus("Prompt enhanced. Review it, or choose Undo enhance.");
		} catch (error) {
			onStatus(
				error instanceof Error ? error.message : "The prompt was not enhanced."
			);
		} finally {
			setEnhancing(false);
		}
	};
	const kindDrafts = drafts.filter((draft) => draft.kind === kind);
	return (
		<>
			<RyuAppField label={kind === "audio" ? "Narration script" : "Direction"}>
				<Textarea
					aria-label={kind === "audio" ? "Narration script" : "Direction"}
					disabled={disabled || enhancing}
					maxLength={8000}
					onChange={(event) => {
						onPromptChange(event.target.value);
						setCursor(event.target.selectionStart);
					}}
					onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
					placeholder={
						kind === "audio"
							? "Words for your narrator…"
							: "Describe the scene, subject, and motion… Type @ to reference a library image."
					}
					value={prompt}
				/>
			</RyuAppField>
			{suggestions.length ? (
				<div
					aria-label="Mention a library image"
					className="flex flex-wrap gap-1"
					role="group"
				>
					{suggestions.map((asset) => (
						<Button
							key={asset.id}
							onClick={() => {
								const next = insertMention(
									prompt,
									cursor ?? prompt.length,
									asset
								);
								onPromptChange(next.prompt);
								setCursor(null);
							}}
							size="sm"
							type="button"
							variant="outline"
						>
							{`@${mentionToken(asset)}`}
						</Button>
					))}
				</div>
			) : null}
			{kind === "image" ? (
				<small>
					Mention a library image with @ to send it as a reference; the model
					reads it as "reference image 1", "reference image 2", and so on.
				</small>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					disabled={disabled || enhancing || !complete || !prompt.trim()}
					onClick={() => {
						enhance().catch(() => undefined);
					}}
					size="sm"
					type="button"
					variant="outline"
				>
					{enhancing ? "Enhancing…" : "Enhance prompt"}
				</Button>
				{previous === null ? null : (
					<Button
						disabled={disabled || enhancing}
						onClick={() => {
							onPromptChange(previous);
							setPrevious(null);
						}}
						size="sm"
						type="button"
						variant="ghost"
					>
						Undo enhance
					</Button>
				)}
				<Button
					disabled={disabled || !prompt.trim()}
					onClick={() => {
						storeDrafts(saveDraft(drafts, { kind, prompt }));
						onStatus("Draft saved in this browser for this project.");
					}}
					size="sm"
					type="button"
					variant="outline"
				>
					Save draft
				</Button>
			</div>
			{complete ? null : (
				<small>
					Enhance needs Ryu's language model, which this host lacks.
				</small>
			)}
			{kindDrafts.length ? (
				<RyuAppField label="Drafts">
					<div className="flex items-center gap-2">
						<NativeSelect
							aria-label="Prompt drafts"
							className="min-w-0 flex-1"
							disabled={disabled}
							onChange={(event) => {
								const draft = kindDrafts.find(
									(item) => item.id === event.target.value
								);
								if (draft) {
									onPromptChange(draft.prompt);
								}
							}}
							value=""
						>
							<NativeSelectOption value="">
								{tl("Open a draft ({count})", {
									count: String(kindDrafts.length),
								})}
							</NativeSelectOption>
							{kindDrafts.map((draft) => (
								<NativeSelectOption key={draft.id} value={draft.id}>
									{draft.prompt.length > 60
										? `${draft.prompt.slice(0, 60)}…`
										: draft.prompt}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<Button
							disabled={disabled}
							onClick={() => {
								const match = kindDrafts.find(
									(draft) => draft.prompt === prompt.trim()
								);
								if (match) {
									storeDrafts(drafts.filter((draft) => draft.id !== match.id));
									onStatus("Draft deleted.");
								} else {
									onStatus("Open a draft first to delete it.");
								}
							}}
							size="sm"
							type="button"
							variant="ghost"
						>
							Delete draft
						</Button>
					</div>
				</RyuAppField>
			) : null}
		</>
	);
}
