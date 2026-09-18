import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { Asset, Scene } from "../../shared/project.ts";
import { fitSceneToAudio } from "../../shared/storyboard.ts";
import { NumberField } from "./NumberField.tsx";

export function SceneMedia({
	scene,
	assets,
	index,
	onChange,
	onError,
}: {
	scene: Scene;
	assets: Asset[];
	index: number;
	onChange: (scene: Scene) => void;
	onError: (message: string) => void;
}) {
	const selected = scene.assetIds
		.map((id) => assets.find((asset) => asset.id === id))
		.filter((asset) => asset !== undefined);
	const visual = selected.find((asset) => asset.kind !== "audio");
	const audio = selected.filter((asset) => asset.kind === "audio");
	return (
		<>
			<RyuAppField label="Visual take">
				<NativeSelect
					aria-label={`Scene ${index + 1} visual take`}
					onChange={(event) =>
						onChange({
							...scene,
							assetIds: [
								...(event.target.value ? [event.target.value] : []),
								...audio.map((asset) => asset.id),
							],
							approved: false,
							reviewStatus: "in-review",
						})
					}
					value={visual?.id ?? ""}
				>
					<NativeSelectOption value="">No visual take</NativeSelectOption>
					{assets
						.filter((asset) => asset.kind !== "audio")
						.map((asset) => (
							<NativeSelectOption key={asset.id} value={asset.id}>
								{asset.name}
							</NativeSelectOption>
						))}
				</NativeSelect>
			</RyuAppField>
			<div className={visual?.kind === "video" ? "studio-pair" : undefined}>
				<NumberField
					label={`Scene ${index + 1} duration`}
					max={7200}
					min={0.1}
					onChange={(duration) =>
						onChange({
							...scene,
							duration,
							approved: false,
							reviewStatus: "in-review",
						})
					}
					value={scene.duration}
				/>
				{visual?.kind === "video" && (
					<NumberField
						label={`Scene ${index + 1} visual source in`}
						max={7200}
						min={0}
						onChange={(sourceIn) =>
							onChange({
								...scene,
								sourceIn,
								audioOffsets: Object.fromEntries(
									audio.map((asset) => [
										asset.id,
										scene.audioOffsets?.[asset.id] ?? scene.sourceIn,
									])
								),
								approved: false,
								reviewStatus: "in-review",
							})
						}
						value={scene.sourceIn}
					/>
				)}
			</div>
			{visual?.hasAudio && (
				<Button
					aria-pressed={scene.muteVisualAudio ?? false}
					onClick={() =>
						onChange({
							...scene,
							muteVisualAudio: !scene.muteVisualAudio,
							approved: false,
							reviewStatus: "in-review",
						})
					}
					size="sm"
					variant="outline"
				>
					Mute visual audio
				</Button>
			)}
			<RyuAppField label="Audio layers">
				<NativeSelect
					aria-label={`Scene ${index + 1} add audio`}
					disabled={audio.length >= (visual ? 15 : 16)}
					onChange={(event) => {
						if (event.target.value) {
							onChange({
								...scene,
								assetIds: [...scene.assetIds, event.target.value],
								audioOffsets: {
									...scene.audioOffsets,
									[event.target.value]: 0,
								},
								approved: false,
								reviewStatus: "in-review",
							});
						}
					}}
					value=""
				>
					<NativeSelectOption value="">
						Add narration or music
					</NativeSelectOption>
					{assets
						.filter(
							(asset) =>
								asset.kind === "audio" && !scene.assetIds.includes(asset.id)
						)
						.map((asset) => (
							<NativeSelectOption key={asset.id} value={asset.id}>
								{asset.name}
							</NativeSelectOption>
						))}
				</NativeSelect>
			</RyuAppField>
			{audio.map((asset) => (
				<div className="studio-scene" key={asset.id}>
					<strong>{asset.name}</strong>
					<NumberField
						label={`Scene ${index + 1} audio in: ${asset.name}`}
						max={asset.duration}
						min={0}
						onChange={(value) =>
							onChange({
								...scene,
								audioOffsets: { ...scene.audioOffsets, [asset.id]: value },
								approved: false,
								reviewStatus: "in-review",
							})
						}
						value={scene.audioOffsets?.[asset.id] ?? scene.sourceIn}
					/>
					<RyuAppActions>
						<Button
							onClick={() => {
								try {
									onChange(fitSceneToAudio(scene, asset, assets));
								} catch (error) {
									onError(
										error instanceof Error
											? error.message
											: "Could not fit scene timing."
									);
								}
							}}
							size="sm"
							variant="outline"
						>
							Fit scene to this audio
						</Button>
						<Button
							onClick={() => {
								const offsets = { ...scene.audioOffsets };
								delete offsets[asset.id];
								onChange({
									...scene,
									assetIds: scene.assetIds.filter((id) => id !== asset.id),
									audioOffsets: offsets,
									approved: false,
									reviewStatus: "in-review",
								});
							}}
							size="sm"
							variant="ghost"
						>
							Remove audio layer
						</Button>
					</RyuAppActions>
				</div>
			))}
		</>
	);
}
