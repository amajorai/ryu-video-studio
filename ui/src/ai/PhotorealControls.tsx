import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { LIKENESS_CONSENT_NOTICE } from "../../../shared/generation.ts";
import type { Asset } from "../../../shared/project.ts";
import { message } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { useBridgeFeatures, useOverwritePlacement } from "./AiVideoTools.tsx";
import { hostGenerationServices, hostMediaBridge } from "./media-bridge.ts";
import { runPhotoreal } from "./reference-tasks.ts";
import { initialTaskChoice, TaskModelFields } from "./TaskModelFields.tsx";
import {
	type TaskModelChoice,
	taskUnavailableReason,
} from "./task-generation.ts";

type Mode = "lipsync" | "avatar";

/**
 * Photoreal (cloud) lip-sync and talking avatars (G80), next to the local
 * vector avatar, which stays the default. Sends real footage to a cloud
 * model only after the sender confirms the people shown agreed.
 */
export function PhotorealControls({
	assets,
	runtime,
}: {
	assets: readonly Asset[];
	runtime: EditorRuntime;
}) {
	const tl = useLiteralMessages();
	const project = runtime.project;
	const features = useBridgeFeatures();
	const place = useOverwritePlacement();
	const [mode, setMode] = useState<Mode>("lipsync");
	const [choices, setChoices] = useState<Record<Mode, TaskModelChoice>>(() => ({
		avatar: initialTaskChoice("avatar"),
		lipsync: initialTaskChoice("lipsync"),
	}));
	const [pictureId, setPictureId] = useState("");
	const [audioId, setAudioId] = useState("");
	const [consent, setConsent] = useState(false);
	const [working, setWorking] = useState(false);
	if (!project) {
		return null;
	}
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const describe = (clipId: string) => {
		const clip = project.segments.find((segment) => segment.id === clipId);
		return clip
			? tl("{clipName} at {start}s (track {track})", {
					clipName: byId.get(clip.assetId)?.name ?? "media",
					start: clip.start.toFixed(2),
					track: String(clip.track + 1),
				})
			: "";
	};
	const pictures = project.segments.filter((segment) => {
		const kind = byId.get(segment.assetId)?.kind;
		return mode === "lipsync"
			? kind === "video"
			: kind === "video" || kind === "image";
	});
	const voices = project.segments.filter((segment) => {
		const asset = byId.get(segment.assetId);
		return asset !== undefined && (asset.kind === "audio" || asset.hasAudio);
	});
	const reason = taskUnavailableReason(hostMediaBridge(), features, mode);
	const choice = choices[mode];
	const disabled = runtime.busy || working;
	const run = async () => {
		if (disabled || !(pictureId && audioId)) {
			return;
		}
		setWorking(true);
		runtime.setStatus(
			"Sending the clip and narration to the photoreal model through Ryu. The node's model policy, approvals, and provider configuration apply."
		);
		try {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			const result = await runPhotoreal({
				audioClipId: audioId,
				choice,
				consent,
				mode,
				pictureClipId: pictureId,
				place: place(saved),
				project: saved,
				services: hostGenerationServices((progress) =>
					runtime.setStatus(
						tl("Saving the photoreal take · {percent}%", {
							percent: Math.round(Math.min(1, progress) * 100),
						})
					)
				),
			});
			runtime.setStatus(
				result.historyWarning ??
					(result.placed
						? result.truncated
							? tl(
									"Placed the photoreal {mode, select, lipsync {lip-sync} other {avatar}} take, muted over the picture clip (shortened to the model limit).",
									{ mode }
								)
							: tl(
									"Placed the photoreal {mode, select, lipsync {lip-sync} other {avatar}} take, muted over the picture clip.",
									{ mode }
								)
						: tl(
								"Saved “{name}” to the library. It was not placed; place it from there.",
								{ name: result.asset.name }
							))
			);
		} catch (error) {
			runtime.setStatus(message(error));
		} finally {
			setWorking(false);
		}
	};
	return (
		<div className="studio-scene">
			<strong>Photoreal (cloud)</strong>
			<p className="text-muted-foreground text-xs">
				The local vector avatar above is the default. Photoreal mode sends a
				clip or photo and the narration to a cloud model: lip-sync re-times a
				speaker's mouth (up to 10 s), a talking avatar animates a still (up to
				60 s).
			</p>
			<RyuAppField label="Photoreal mode">
				<NativeSelect
					aria-label="Photoreal mode"
					disabled={disabled}
					onChange={(event) =>
						setMode(event.target.value === "avatar" ? "avatar" : "lipsync")
					}
					value={mode}
				>
					<NativeSelectOption value="lipsync">
						Lip-sync a video clip
					</NativeSelectOption>
					<NativeSelectOption value="avatar">
						Talking avatar from a still
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Picture clip">
				<NativeSelect
					aria-label="Photoreal picture clip"
					disabled={disabled}
					onChange={(event) => setPictureId(event.target.value)}
					value={pictureId}
				>
					<NativeSelectOption value="">Choose a clip</NativeSelectOption>
					{pictures.map((segment) => (
						<NativeSelectOption key={segment.id} value={segment.id}>
							{describe(segment.id)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Narration or TTS clip">
				<NativeSelect
					aria-label="Photoreal audio clip"
					disabled={disabled}
					onChange={(event) => setAudioId(event.target.value)}
					value={audioId}
				>
					<NativeSelectOption value="">Choose a clip</NativeSelectOption>
					{voices.map((segment) => (
						<NativeSelectOption key={segment.id} value={segment.id}>
							{describe(segment.id)}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<TaskModelFields
				choice={choice}
				disabled={disabled}
				key={mode}
				onChange={(next) =>
					setChoices((current) => ({ ...current, [mode]: next }))
				}
				task={mode}
			/>
			<label className="flex items-start gap-2 text-xs">
				<Checkbox
					aria-label="Consent to use this likeness"
					checked={consent}
					disabled={disabled}
					onCheckedChange={(value) => setConsent(value === true)}
				/>
				<span>
					{tl("{notice} This confirmation is recorded with the result.", {
						notice: tl(LIKENESS_CONSENT_NOTICE),
					})}
				</span>
			</label>
			{reason && <p className="text-xs">{reason}</p>}
			<RyuAppActions>
				<Button
					disabled={
						disabled || Boolean(reason) || !consent || !(pictureId && audioId)
					}
					onClick={() => void run()}
					size="sm"
					variant="outline"
				>
					{working ? "Generating…" : "Generate photoreal take"}
				</Button>
			</RyuAppActions>
		</div>
	);
}
