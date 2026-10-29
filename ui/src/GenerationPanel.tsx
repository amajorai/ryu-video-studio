import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	type GenerationRequestInput,
	generationRequestSchema,
	generationRouteSchema,
	referenceImageIds,
} from "../../shared/generation.ts";
import { resolvePromptMentions } from "../../shared/generation-assist.ts";
import type { Asset } from "../../shared/project.ts";
import {
	EMPTY_VOICE_CHOICE,
	type TtsVoiceChoice,
} from "../../shared/tts-voices.ts";
import { assetsById } from "./ai/ai-edit.ts";
import {
	bridgeSupports,
	hostGenerationServices,
	hostMediaBridge,
	runGeneration,
} from "./ai/media-bridge.ts";
import { ReferenceImagePicker } from "./ai/ReferenceImagePicker.tsx";
import { VoicePicker } from "./audio/VoicePicker.tsx";
import { GenerationHistory } from "./GenerationHistory.tsx";
import { GenerationCostEstimate } from "./generation/GenerationCostEstimate.tsx";
import { GenerationModelField } from "./generation/GenerationModelField.tsx";
import { PromptTools } from "./generation/PromptTools.tsx";

export { generatedDataUrl } from "./generation-response.ts";

export function GenerationPanel({
	projectId,
	assets,
	onAsset,
	onStatus,
	productionBudget,
}: {
	projectId: string;
	assets: Asset[];
	onAsset: (asset: Asset) => void;
	onStatus: (message: string) => void;
	/** The project's budget settings, for the cost estimate. */
	productionBudget?: unknown;
}) {
	const tl = useLiteralMessages();
	const [kind, setKind] = useState<"image" | "video" | "audio">("image");
	const [prompt, setPrompt] = useState("");
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [voice, setVoice] = useState<TtsVoiceChoice>(EMPTY_VOICE_CHOICE);
	const [speed, setSpeed] = useState(1);
	const [route, setRoute] = useState<
		"node-default" | "local" | "managed" | "byok"
	>("node-default");
	const [rationale, setRationale] = useState("");
	const [working, setWorking] = useState(false);
	const [historyRevision, setHistoryRevision] = useState(0);
	const [references, setReferences] = useState<string[]>([]);
	const available = bridgeSupports(hostMediaBridge(), kind);
	const generate = async () => {
		if (!prompt.trim() || working) {
			return;
		}
		setWorking(true);
		onStatus(
			"Generating through Ryu. The node's model policy and provider configuration apply."
		);
		try {
			if (
				kind === "audio" &&
				(!Number.isFinite(speed) || speed < 0.5 || speed > 2)
			) {
				throw new Error("Choose a speaking rate between 0.5 and 2.");
			}
			const mentions =
				kind === "image"
					? resolvePromptMentions(prompt.trim(), assets)
					: { ids: [], prompt: prompt.trim(), unknown: [] };
			// Mentioned images come first so "reference image N" matches their order.
			const referenceIds =
				kind === "image"
					? referenceImageIds(assets, [...mentions.ids, ...references])
					: [];
			const input: GenerationRequestInput = {
				id: crypto.randomUUID(),
				projectId,
				kind,
				prompt: mentions.prompt,
				provider: kind === "audio" ? "" : provider.trim(),
				model: kind === "audio" ? "" : model.trim(),
				voice: kind === "audio" ? voice.voice.trim() : "",
				language: kind === "audio" ? voice.language.trim() : "",
				speed: kind === "audio" ? speed : 1,
				route,
				rationale: rationale.trim(),
			};
			if (kind === "audio" && voice.engine && voice.voice) {
				input.engine = voice.engine;
			}
			if (referenceIds.length) {
				input.inputAssetIds = referenceIds;
			}
			const saved = await runGeneration(
				hostGenerationServices((progress) =>
					onStatus(
						tl("Saving generated media · {percent}%", {
							percent: String(Math.round(progress * 100)),
						})
					)
				),
				input,
				assetsById(assets, referenceIds)
			);
			onAsset(saved.asset);
			onStatus(
				saved.historyWarning ??
					"Generated media saved to your library. Review it before adding it to the timeline."
			);
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "Generation failed.");
		} finally {
			setHistoryRevision((value) => value + 1);
			setWorking(false);
		}
	};
	return (
		<>
			<RyuAppSection title="Generate with Ryu">
				<RyuAppField label="Create">
					<NativeSelect
						aria-label="Generation type"
						disabled={working}
						onChange={(e) =>
							setKind(generationRequestSchema.shape.kind.parse(e.target.value))
						}
						value={kind}
					>
						<NativeSelectOption value="image">Image</NativeSelectOption>
						<NativeSelectOption value="video">Video</NativeSelectOption>
						<NativeSelectOption value="audio">Narration</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
				<PromptTools
					assets={assets}
					disabled={working}
					key={projectId}
					kind={kind}
					onPromptChange={setPrompt}
					onStatus={onStatus}
					projectId={projectId}
					prompt={prompt}
				/>
				{kind === "image" && (
					<ReferenceImagePicker
						assets={assets}
						disabled={working}
						onChange={setReferences}
						selected={references}
					/>
				)}
				{kind !== "audio" && (
					<GenerationModelField
						disabled={working}
						model={model}
						onChange={(next) => {
							setProvider(next.provider);
							setModel(next.model);
						}}
						provider={provider}
					/>
				)}
				<RyuAppField label="Execution route">
					<NativeSelect
						aria-label="Generation execution route"
						disabled={working}
						onChange={(event) =>
							setRoute(generationRouteSchema.parse(event.target.value))
						}
						value={route}
					>
						<NativeSelectOption value="node-default">
							Node default
						</NativeSelectOption>
						<NativeSelectOption value="local">Local model</NativeSelectOption>
						<NativeSelectOption value="managed">
							Managed provider
						</NativeSelectOption>
						<NativeSelectOption value="byok">BYOK provider</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
				<RyuAppField label="Decision note">
					<Input
						aria-label="Generation decision note"
						disabled={working}
						maxLength={1000}
						onChange={(event) => setRationale(event.target.value)}
						placeholder="Why this route fits the production?"
						value={rationale}
					/>
				</RyuAppField>
				<p>
					The route and note are saved as requested context. Core and Gateway
					still decide the resolved provider and any charge.
				</p>
				{kind === "audio" && (
					<>
						<VoicePicker
							disabled={working}
							languageAriaLabel="Narration language"
							onChange={setVoice}
							value={voice}
							voiceAriaLabel="Narration voice"
							voiceLabel="Voice (optional)"
						/>
						<RyuAppField label="Speaking rate">
							<Input
								aria-label="Narration speaking rate"
								disabled={working}
								max={2}
								min={0.5}
								onChange={(event) => setSpeed(Number(event.target.value))}
								step={0.1}
								type="number"
								value={speed}
							/>
						</RyuAppField>
						<p>
							Voices come from the speech engines installed on your Ryu node,
							grouped by engine and language. Review pronunciation and timing
							before assembling your edit.
						</p>
					</>
				)}
				<GenerationCostEstimate
					kind={kind}
					productionBudget={productionBudget}
					projectId={projectId}
					revision={historyRevision}
				/>
				<p className="text-muted-foreground">
					Uses the models configured on your Ryu node. Cloud generation may
					incur provider charges.
				</p>
				{!available && (
					<p>
						Generation is unavailable in this host. Open the app in Ryu with
						media permissions and a configured model.
					</p>
				)}
				<Button
					disabled={!available || working || !prompt.trim()}
					onClick={() => void generate()}
				>
					{working ? "Generating…" : "Generate media"}
				</Button>
			</RyuAppSection>
			<GenerationHistory
				assets={assets}
				onStatus={onStatus}
				projectId={projectId}
				revision={historyRevision}
			/>
		</>
	);
}
