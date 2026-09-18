import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { generationJobSchema } from "../../shared/generation.ts";
import type { Asset } from "../../shared/project.ts";
import { mediaDataUrlBlob, request, uploadMedia } from "./bridge.ts";
import { GenerationHistory } from "./GenerationHistory.tsx";

export function generatedDataUrl(
	value: unknown,
	kind: "image" | "video" | "audio"
): string {
	const candidates = Array.isArray(value) ? value : [value];
	for (const candidate of candidates.slice(0, 16)) {
		const url =
			typeof candidate === "string"
				? candidate
				: candidate && typeof candidate === "object" && "url" in candidate
					? candidate.url
					: undefined;
		if (
			typeof url === "string" &&
			url.startsWith(`data:${kind}/`) &&
			url.includes(";base64,")
		) {
			return url;
		}
	}
	throw new Error(
		"Ryu did not return usable generated media. Check the selected model and try again."
	);
}

export function GenerationPanel({
	projectId,
	assets,
	onAsset,
	onStatus,
}: {
	projectId: string;
	assets: Asset[];
	onAsset: (asset: Asset) => void;
	onStatus: (message: string) => void;
}) {
	const [kind, setKind] = useState<"image" | "video" | "audio">("image");
	const [prompt, setPrompt] = useState("");
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [voice, setVoice] = useState("");
	const [language, setLanguage] = useState("");
	const [speed, setSpeed] = useState(1);
	const [route, setRoute] = useState<
		"node-default" | "local" | "managed" | "byok"
	>("node-default");
	const [rationale, setRationale] = useState("");
	const [working, setWorking] = useState(false);
	const [historyRevision, setHistoryRevision] = useState(0);
	const available =
		kind === "audio"
			? Boolean(window.ryu?.media?.tts)
			: Boolean(window.ryu?.media?.[kind]);
	const generate = async () => {
		if (!prompt.trim() || working) {
			return;
		}
		setWorking(true);
		onStatus(
			"Generating through Ryu. The node's model policy and provider configuration apply."
		);
		let requestId: string | undefined;
		let savedAsset: Asset | undefined;
		try {
			const tracked = await request<{ job: unknown; created: boolean }>(
				"/generations",
				"POST",
				{
					id: crypto.randomUUID(),
					projectId,
					kind,
					prompt: prompt.trim(),
					provider: kind === "audio" ? "" : provider.trim(),
					model: kind === "audio" ? "" : model.trim(),
					voice: kind === "audio" ? voice.trim() : "",
					language: kind === "audio" ? language.trim() : "",
					speed: kind === "audio" ? speed : 1,
					route,
					rationale: rationale.trim(),
				}
			);
			if (!tracked.created) {
				throw new Error(
					"This request was already recorded. Review generation history before retrying."
				);
			}
			requestId = generationJobSchema.parse(tracked.job).id;
			setHistoryRevision((value) => value + 1);
			let result: unknown;
			if (kind === "audio") {
				if (!window.ryu?.media?.tts) {
					throw new Error("Ryu narration is unavailable on this host.");
				}
				if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
					throw new Error("Choose a speaking rate between 0.5 and 2.");
				}
				result = await window.ryu.media.tts({
					text: prompt.trim(),
					request_id: requestId,
					project_id: projectId,
					speed,
					...(voice.trim() ? { voice: voice.trim() } : {}),
					...(language.trim() ? { language: language.trim() } : {}),
				});
			} else {
				const input = {
					prompt: prompt.trim(),
					...(provider.trim() ? { provider: provider.trim() } : {}),
					...(model.trim() ? { model: model.trim() } : {}),
				};
				if (kind === "image") {
					if (!window.ryu?.media?.image) {
						throw new Error(
							"Ryu image generation is unavailable on this host."
						);
					}
					result = await window.ryu.media.image({
						...input,
						count: 1,
						request_id: requestId,
						project_id: projectId,
					});
				} else {
					if (!window.ryu?.media?.video) {
						throw new Error(
							"Ryu video generation is unavailable on this host."
						);
					}
					result = await window.ryu.media.video({
						...input,
						request_id: requestId,
						project_id: projectId,
					});
				}
			}
			const data = generatedDataUrl(result, kind);
			const blob = mediaDataUrlBlob(data);
			const extension =
				kind === "image" ? "png" : kind === "video" ? "mp4" : "wav";
			const asset = await uploadMedia(
				new File(
					[blob],
					`Generated ${kind} — ${prompt.trim().replace(/\s+/g, " ").slice(0, 60)}.${extension}`,
					{ type: blob.type }
				),
				(progress) =>
					onStatus(`Saving generated media · ${Math.round(progress * 100)}%`)
			);
			savedAsset = asset;
			onAsset(asset);
			await request(`/generations/${requestId}`, "PUT", {
				status: "completed",
				assetIds: [asset.id],
				message: "",
			});
			onStatus(
				"Generated media saved to your library. Review it before adding it to the timeline."
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Generation failed.";
			if (requestId && !savedAsset) {
				await request(`/generations/${requestId}`, "PUT", {
					status: "incomplete",
					assetIds: [],
					message: message.slice(0, 1000),
				}).catch(() => undefined);
			}
			onStatus(
				savedAsset
					? `Media was saved, but its history update failed: ${message}`
					: message
			);
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
						onChange={(e) => setKind(e.target.value as typeof kind)}
						value={kind}
					>
						<NativeSelectOption value="image">Image</NativeSelectOption>
						<NativeSelectOption value="video">Video</NativeSelectOption>
						<NativeSelectOption value="audio">Narration</NativeSelectOption>
					</NativeSelect>
				</RyuAppField>
				<RyuAppField
					label={kind === "audio" ? "Narration script" : "Direction"}
				>
					<Textarea
						disabled={working}
						maxLength={8000}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={
							kind === "audio"
								? "Words for your narrator…"
								: "Describe the scene, subject, and motion…"
						}
						value={prompt}
					/>
				</RyuAppField>
				{kind !== "audio" && (
					<>
						<RyuAppField label="Provider (optional)">
							<Input
								disabled={working}
								onChange={(e) => setProvider(e.target.value)}
								placeholder="Use node default"
								value={provider}
							/>
						</RyuAppField>
						<RyuAppField label="Model (optional)">
							<Input
								disabled={working}
								onChange={(e) => setModel(e.target.value)}
								placeholder="Use node default"
								value={model}
							/>
						</RyuAppField>
					</>
				)}
				<RyuAppField label="Execution route">
					<NativeSelect
						aria-label="Generation execution route"
						disabled={working}
						onChange={(event) => setRoute(event.target.value as typeof route)}
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
						<RyuAppField label="Voice (optional)">
							<Input
								aria-label="Narration voice"
								disabled={working}
								maxLength={100}
								onChange={(event) => setVoice(event.target.value)}
								placeholder="Use engine default"
								value={voice}
							/>
						</RyuAppField>
						<RyuAppField label="Language (optional)">
							<Input
								aria-label="Narration language"
								disabled={working}
								maxLength={35}
								onChange={(event) => setLanguage(event.target.value)}
								placeholder="For example, en-us"
								value={language}
							/>
						</RyuAppField>
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
							Voice and language support depend on the selected Ryu speech
							engine. Review pronunciation and timing before assembling your
							edit.
						</p>
					</>
				)}
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
