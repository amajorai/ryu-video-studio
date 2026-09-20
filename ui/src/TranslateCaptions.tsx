import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import { translationRequest } from "../../shared/production-prompts.ts";
import type { Caption } from "../../shared/project.ts";
import { applyTranslations } from "../../shared/transcript.ts";

export function TranslateCaptions({
	captions,
	onApply,
	onStatus,
}: {
	captions: Caption[];
	onApply: (
		original: Caption[],
		translated: Caption[],
		language: string
	) => void;
	onStatus: (text: string) => void;
}) {
	const [language, setLanguage] = useState("");
	const [working, setWorking] = useState(false);
	const translate = async () => {
		const complete = window.ryu?.model?.complete;
		if (!complete) {
			return;
		}
		setWorking(true);
		const original = structuredClone(captions);
		const translated: Caption[] = [];
		try {
			for (let offset = 0; offset < original.length; ) {
				const batch: Caption[] = [];
				let characters = 0;
				while (offset < original.length && batch.length < 50) {
					const next = original[offset];
					if (!next) {
						break;
					}
					if (batch.length && characters + next.text.length > 8000) {
						break;
					}
					batch.push(next);
					characters += next.text.length;
					offset++;
				}
				onStatus(`Translating captions · ${offset} of ${original.length}`);
				const response = await complete(translationRequest(language, batch));
				translated.push(...applyTranslations(batch, JSON.parse(response)));
			}
			onApply(original, translated, language.trim());
			onStatus(
				"Translated captions are ready for review. Their timings were preserved."
			);
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "Translation failed.");
		} finally {
			setWorking(false);
		}
	};
	return (
		<div className="studio-scene">
			<RyuAppField label="Translate captions">
				<Input
					aria-label="Caption translation language"
					disabled={working}
					maxLength={35}
					onChange={(event) => setLanguage(event.target.value)}
					placeholder="Target language"
					value={language}
				/>
			</RyuAppField>
			<Button
				disabled={
					working ||
					!captions.length ||
					language.trim().length < 2 ||
					!window.ryu?.model?.complete
				}
				onClick={() => void translate()}
				size="sm"
				variant="outline"
			>
				{working ? "Translating…" : "Translate with Ryu"}
			</Button>
		</div>
	);
}
