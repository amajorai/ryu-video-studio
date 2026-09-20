import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Textarea } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { analysisSchema } from "../../shared/analysis.ts";
import { colorScopesSchema } from "../../shared/color-scopes.ts";
import type { Asset } from "../../shared/project.ts";
import {
	buildReferenceProfile,
	type ReferenceProfile,
} from "../../shared/reference.ts";
import { request } from "./bridge.ts";

const dollars = (microUsd: number) => (microUsd / 1_000_000).toFixed(2);

export function ReferencePanel({
	assets,
	captions,
	profile,
	onChange,
	onBrief,
	onStatus,
}: {
	assets: Asset[];
	captions: Parameters<typeof buildReferenceProfile>[2];
	profile?: ReferenceProfile;
	onChange: (profile: ReferenceProfile | undefined) => void;
	onBrief: (brief: string) => void;
	onStatus: (text: string) => void;
}) {
	const [assetId, setAssetId] = useState(profile?.assetId ?? "");
	const [working, setWorking] = useState(false);
	const videos = assets.filter((asset) => asset.kind === "video");
	const selectedId = assetId || profile?.assetId || "";
	const selected = assets.find((asset) => asset.id === selectedId);
	const study = async () => {
		if (!selected) {
			onStatus("Choose a video reference first.");
			return;
		}
		setWorking(true);
		try {
			const result = await request<{ analysis: unknown }>(
				`/assets/${selected.id}/analysis`
			);
			const analysis = result.analysis
				? analysisSchema.parse(result.analysis)
				: null;
			if (!analysis) {
				throw new Error("Analyze this source in the Media panel first.");
			}
			const scopes = await request<unknown>(
				`/assets/${selected.id}/scopes?time=0`
			);
			const next = buildReferenceProfile(
				selected,
				analysis,
				captions,
				colorScopesSchema.parse(scopes)
			);
			onChange(next);
			onStatus("Reference profile saved to this project.");
		} catch (error) {
			onStatus(
				error instanceof Error ? error.message : "Reference study failed."
			);
		} finally {
			setWorking(false);
		}
	};
	return (
		<RyuAppSection title="Reference study">
			<p>
				Study an imported video before drafting a new production. The profile
				uses measured scene cuts, audio levels, and captions from this project.
			</p>
			<RyuAppField label="Reference video">
				<NativeSelect
					aria-label="Reference video"
					disabled={working || !videos.length}
					onChange={(event) => setAssetId(event.target.value)}
					value={selectedId}
				>
					<NativeSelectOption value="">Choose a video</NativeSelectOption>
					{videos.map((asset) => (
						<NativeSelectOption key={asset.id} value={asset.id}>
							{asset.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={working || !selected}
					onClick={() => void study()}
					variant="outline"
				>
					{working ? "Studying reference…" : "Build reference profile"}
				</Button>
				{profile && (
					<Button onClick={() => onChange(undefined)} variant="ghost">
						Clear profile
					</Button>
				)}
			</RyuAppActions>
			{profile && (
				<>
					<div className="studio-scene">
						<strong>{profile.assetName}</strong>
						<small>
							{profile.pace} pace · {profile.shotCount} shots · average{" "}
							{profile.averageShotSeconds.toFixed(1)}s
						</small>
						<p>
							{profile.width} × {profile.height} · {profile.duration.toFixed(1)}
							s · {profile.audioPeak > 0.01 ? "audio detected" : "quiet source"}{" "}
							· {profile.captionCount} caption cues
						</p>
						{profile.visualStyle && (
							<small>
								Style sample · {Math.round(profile.visualStyle.luma * 100)}%
								luma · {Math.round(profile.visualStyle.saturation * 100)}%
								saturation · hue {Math.round(profile.visualStyle.hueDegrees)}°
								{profile.visualStyle.clipping.black ||
								profile.visualStyle.clipping.white
									? " · clipping review"
									: ""}
							</small>
						)}
						<small>
							Planning estimate · $
							{dollars(profile.estimatedCostMicroUsd.total)}· images $
							{dollars(profile.estimatedCostMicroUsd.image)} · video $
							{dollars(profile.estimatedCostMicroUsd.video)} · narration $
							{dollars(profile.estimatedCostMicroUsd.audio)}
						</small>
					</div>
					<RyuAppField label="Reference brief">
						<Textarea
							aria-label="Reference brief"
							maxLength={4000}
							onChange={(event) =>
								onChange({ ...profile, brief: event.target.value })
							}
							value={profile.brief}
						/>
					</RyuAppField>
					<Button onClick={() => onBrief(profile.brief)} variant="outline">
						Copy brief to Plan
					</Button>
					{profile.concepts.length > 0 && (
						<>
							<p>Original concept variants</p>
							{profile.concepts.map((concept) => (
								<div className="studio-scene" key={concept.id}>
									<strong>{concept.title}</strong>
									<small>{concept.duration.toFixed(1)}s target</small>
									<p>{concept.hook}</p>
									<Button
										onClick={() => onBrief(concept.brief)}
										size="sm"
										variant="outline"
									>
										Use concept in Plan
									</Button>
								</div>
							))}
						</>
					)}
				</>
			)}
			{!videos.length && <p>Import a video to study its pacing.</p>}
		</RyuAppSection>
	);
}
