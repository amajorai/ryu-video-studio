import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import { dubbingFilename, dubbingScript } from "../../shared/dubbing.ts";
import { generationJobSchema } from "../../shared/generation.ts";
import type { Asset, Caption } from "../../shared/project.ts";
import { mediaDataUrlBlob, request, uploadMedia } from "./bridge.ts";
import { generatedDataUrl } from "./GenerationPanel.tsx";

export function DubCaptions({
	captions,
	projectId,
	onAsset,
	onStatus,
}: {
	captions: Caption[];
	projectId: string;
	onAsset: (asset: Asset) => void;
	onStatus: (text: string) => void;
}) {
	const [language, setLanguage] = useState("");
	const [voice, setVoice] = useState("");
	const [speed, setSpeed] = useState(1);
	const [working, setWorking] = useState(false);
	const available = Boolean(window.ryu?.media?.tts);
	const dub = async () => {
		if (working || !available) {
			return;
		}
		setWorking(true);
		let requestId: string | undefined;
		let savedAsset: Asset | undefined;
		try {
			const script = dubbingScript(captions);
			if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
				throw new Error("Choose a speaking rate between 0.5 and 2.");
			}
			const tracked = await request<{ job: unknown; created: boolean }>(
				"/generations",
				"POST",
				{
					id: crypto.randomUUID(),
					projectId,
					kind: "audio",
					prompt: script,
					provider: "",
					model: "",
					voice: voice.trim(),
					language: language.trim(),
					speed,
					route: "node-default",
					rationale: "Caption dubbing through the configured narration engine.",
				}
			);
			if (!tracked.created) {
				throw new Error(
					"This dubbing request is already in generation history."
				);
			}
			requestId = generationJobSchema.parse(tracked.job).id;
			if (!window.ryu?.media?.tts) {
				throw new Error("Ryu narration is unavailable on this host.");
			}
			onStatus(
				"Dubbing captions through Ryu. Review timing after the audio is saved."
			);
			const result = await window.ryu.media.tts({
				text: script,
				request_id: requestId,
				speed,
				...(voice.trim() ? { voice: voice.trim() } : {}),
				...(language.trim() ? { language: language.trim() } : {}),
			});
			const blob = mediaDataUrlBlob(generatedDataUrl(result, "audio"));
			const asset = await uploadMedia(
				new File([blob], dubbingFilename(language), { type: blob.type }),
				(progress) =>
					onStatus(`Saving dubbed track · ${Math.round(progress * 100)}%`)
			);
			savedAsset = asset;
			onAsset(asset);
			await request(`/generations/${requestId}`, "PUT", {
				status: "completed",
				assetIds: [asset.id],
				message:
					"Caption timing was retained; review the generated audio duration.",
			});
			onStatus(
				"Dubbed audio saved and added to the timeline. Review pronunciation and timing."
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Dubbing failed.";
			if (requestId && !savedAsset) {
				await request(`/generations/${requestId}`, "PUT", {
					status: "incomplete",
					assetIds: [],
					message: message.slice(0, 1000),
				}).catch(() => undefined);
			}
			onStatus(message);
		} finally {
			setWorking(false);
		}
	};
	return (
		<div className="studio-scene">
			<RyuAppField label="Dub this caption track">
				<Input
					aria-label="Dubbing language"
					disabled={working}
					maxLength={35}
					onChange={(event) => setLanguage(event.target.value)}
					placeholder="Language code, for example fr-fr"
					value={language}
				/>
			</RyuAppField>
			<RyuAppField label="Dubbing voice">
				<Input
					aria-label="Dubbing voice"
					disabled={working}
					maxLength={100}
					onChange={(event) => setVoice(event.target.value)}
					placeholder="Use engine default"
					value={voice}
				/>
			</RyuAppField>
			<RyuAppField label="Dubbing speed">
				<Input
					aria-label="Dubbing speed"
					disabled={working}
					max={2}
					min={0.5}
					onChange={(event) => setSpeed(Number(event.target.value))}
					step={0.1}
					type="number"
					value={speed}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={!available || working || !captions.length}
					onClick={() => void dub()}
					variant="outline"
				>
					{working ? "Dubbing…" : "Create dubbed track"}
				</Button>
			</RyuAppActions>
			{!available && (
				<p>Open Video Studio in Ryu with narration access to dub captions.</p>
			)}
			<p>
				Caption timing stays unchanged. The generated audio is added as a
				reviewable timeline track.
			</p>
		</div>
	);
}
