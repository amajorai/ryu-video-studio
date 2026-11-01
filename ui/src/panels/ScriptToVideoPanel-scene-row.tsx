import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Badge, Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	MAX_SCENE_NARRATION_CHARS,
	type ScriptScene,
} from "../../../shared/script-to-video.ts";
import { sceneStatusText } from "./ScriptToVideoPanel-model.ts";
import type { SceneDraft } from "./script-to-video-pipeline.ts";

export function SceneRow({
	disabled,
	draft,
	index,
	onChange,
	onRemove,
	onRetry,
}: {
	disabled: boolean;
	draft: SceneDraft;
	index: number;
	onChange: (scene: ScriptScene, reset: Partial<SceneDraft>) => void;
	onRemove: () => void;
	onRetry: () => void;
}) {
	const tl = useLiteralMessages();
	const label = `Scene ${index + 1}`;
	return (
		<div className="studio-scene" data-script-scene={draft.id}>
			<div className="flex items-center justify-between gap-2">
				<strong>{label}</strong>
				<Badge
					variant={draft.status === "failed" ? "destructive" : "secondary"}
				>
					{draft.status}
				</Badge>
			</div>
			<RyuAppField label="Narration">
				<Textarea
					aria-label={tl("{label} narration", { label })}
					disabled={disabled}
					maxLength={MAX_SCENE_NARRATION_CHARS}
					onChange={(event) =>
						onChange(
							{ ...draft.scene, narration: event.target.value },
							// New words need new narration and timing.
							{
								narrationAssetId: undefined,
								status: "pending",
								transcribed: false,
								transcriptNote: undefined,
							}
						)
					}
					value={draft.scene.narration}
				/>
			</RyuAppField>
			<RyuAppField label="Stock search">
				<Input
					aria-label={tl("{label} stock search", { label })}
					disabled={disabled}
					maxLength={200}
					onChange={(event) =>
						onChange(
							{ ...draft.scene, visualQuery: event.target.value },
							{ status: "pending", visualAssetId: undefined }
						)
					}
					value={draft.scene.visualQuery}
				/>
			</RyuAppField>
			<RyuAppField label="Image prompt">
				<Textarea
					aria-label={tl("{label} image prompt", { label })}
					disabled={disabled}
					maxLength={2000}
					onChange={(event) =>
						onChange(
							{ ...draft.scene, imagePrompt: event.target.value },
							{ status: "pending", visualAssetId: undefined }
						)
					}
					value={draft.scene.imagePrompt}
				/>
			</RyuAppField>
			<small aria-live="polite">{sceneStatusText(draft)}</small>
			{draft.transcriptNote && <small>{draft.transcriptNote}</small>}
			<RyuAppActions>
				{draft.status === "failed" && (
					<Button
						disabled={disabled}
						onClick={onRetry}
						size="sm"
						variant="outline"
					>
						{tl("Retry {label}", { label: label.toLowerCase() })}
					</Button>
				)}
				<Button
					disabled={disabled}
					onClick={onRemove}
					size="sm"
					variant="ghost"
				>
					Remove
				</Button>
			</RyuAppActions>
		</div>
	);
}
