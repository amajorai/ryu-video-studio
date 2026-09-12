import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import type { Asset } from "../../shared/project.ts";
import type { Recipe } from "../../shared/recipes.ts";

export function RecipePanel({
	assets,
	busy,
	onApply,
}: {
	assets: Asset[];
	busy: boolean;
	onApply: (recipe: Omit<Recipe, "revision">) => void;
}) {
	const [kind, setKind] = useState<Recipe["kind"]>("montage");
	const [assetIds, setAssetIds] = useState<string[]>([]);
	const [audioId, setAudioId] = useState("");
	const [title, setTitle] = useState("");
	const [format, setFormat] = useState<Recipe["format"]>("landscape");
	const [shotDuration, setShotDuration] = useState(5);
	return (
		<RyuAppSection title="Production recipes">
			<p>
				Build an editable timeline from imported media or a local template.
				Applying replaces the timeline, titles and captions; Undo restores the
				previous edit.
			</p>
			<RyuAppField label="Recipe">
				<NativeSelect
					aria-label="Production recipe"
					disabled={busy}
					onChange={(event) => {
						setKind(event.target.value as Recipe["kind"]);
						setAssetIds([]);
					}}
					value={kind}
				>
					<NativeSelectOption value="montage">
						Footage montage
					</NativeSelectOption>
					<NativeSelectOption value="cinematic">
						Cinematic montage
					</NativeSelectOption>
					<NativeSelectOption value="animated-explainer">
						Animated explainer
					</NativeSelectOption>
					<NativeSelectOption value="narrated-slides">
						Narrated slideshow
					</NativeSelectOption>
					<NativeSelectOption value="waveform">
						Waveform video
					</NativeSelectOption>
					<NativeSelectOption value="clip-factory">
						Clip factory
					</NativeSelectOption>
					<NativeSelectOption value="multicam">Multicam cut</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<p>
				{kind === "animated-explainer"
					? "Start without footage: create an editable local explainer with vector cards, a title, and optional audio."
					: kind === "montage"
						? "Sequence footage with short fades. Optional audio replaces source sound."
						: kind === "cinematic"
							? "Sequence footage with crossfades between shots and optional audio."
							: kind === "narrated-slides"
								? "Distribute images across the narration, with alternating slow zooms."
								: kind === "waveform"
									? "Turn audio into a source-driven waveform with an optional background image."
									: kind === "clip-factory"
										? "Cut one long video into short, editable clips with markers at each boundary."
										: "Alternate between synchronized camera sources while keeping one program-audio layer."}
			</p>
			{kind !== "animated-explainer" && (
				<RyuAppField label="Visual sources in playback order">
					{assets
						.filter(
							(asset) =>
								asset.kind !== "audio" &&
								(kind === "montage" ||
									kind === "cinematic" ||
									(kind === "clip-factory"
										? asset.kind === "video"
										: kind === "multicam"
											? asset.kind === "video"
											: asset.kind === "image"))
						)
						.map((asset) => (
							<Button
								aria-pressed={assetIds.includes(asset.id)}
								disabled={
									busy ||
									(!assetIds.includes(asset.id) &&
										assetIds.length >=
											(kind === "waveform" || kind === "clip-factory"
												? 1
												: kind === "multicam"
													? 4
													: 30))
								}
								key={asset.id}
								onClick={() =>
									setAssetIds((current) =>
										current.includes(asset.id)
											? current.filter((id) => id !== asset.id)
											: [...current, asset.id]
									)
								}
								size="sm"
								variant="outline"
							>
								{assetIds.includes(asset.id)
									? `${assetIds.indexOf(asset.id) + 1}. `
									: ""}
								{asset.name}
							</Button>
						))}
				</RyuAppField>
			)}
			<RyuAppField
				label={
					["montage", "cinematic", "clip-factory", "multicam"].includes(kind)
						? "Audio (optional)"
						: kind === "animated-explainer"
							? "Audio (optional)"
							: "Audio source"
				}
			>
				<NativeSelect
					aria-label="Recipe audio source"
					disabled={busy}
					onChange={(event) => setAudioId(event.target.value)}
					value={audioId}
				>
					<NativeSelectOption value="">Choose audio</NativeSelectOption>
					{assets
						.filter((asset) => asset.kind === "audio")
						.map((asset) => (
							<NativeSelectOption key={asset.id} value={asset.id}>
								{asset.name}
							</NativeSelectOption>
						))}
				</NativeSelect>
			</RyuAppField>
			{(kind === "montage" ||
				kind === "cinematic" ||
				kind === "clip-factory" ||
				kind === "multicam") && (
				<RyuAppField
					label={
						kind === "clip-factory"
							? "Seconds per clip"
							: kind === "multicam"
								? "Seconds per camera cut"
								: "Maximum seconds per shot"
					}
				>
					<Input
						aria-label="Recipe shot duration"
						disabled={busy}
						max={60}
						min={0.5}
						onChange={(event) => setShotDuration(Number(event.target.value))}
						step={0.5}
						type="number"
						value={shotDuration}
					/>
				</RyuAppField>
			)}
			<RyuAppField label="Title (optional)">
				<Input
					aria-label="Recipe title"
					disabled={busy}
					maxLength={200}
					onChange={(event) => setTitle(event.target.value)}
					value={title}
				/>
			</RyuAppField>
			<RyuAppField label="Format">
				<NativeSelect
					aria-label="Recipe format"
					disabled={busy}
					onChange={(event) =>
						setFormat(event.target.value as Recipe["format"])
					}
					value={format}
				>
					<NativeSelectOption value="landscape">Landscape</NativeSelectOption>
					<NativeSelectOption value="vertical">Vertical</NativeSelectOption>
					<NativeSelectOption value="square">Square</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={
						busy ||
						(kind !== "waveform" &&
							kind !== "animated-explainer" &&
							(!assetIds.length ||
								(kind === "multicam" && assetIds.length < 2))) ||
						(["narrated-slides", "waveform"].includes(kind) && !audioId)
					}
					onClick={() =>
						onApply({
							kind,
							assetIds,
							audioId: audioId || null,
							title,
							format,
							shotDuration,
						})
					}
				>
					Apply recipe
				</Button>
			</RyuAppActions>
		</RyuAppSection>
	);
}
