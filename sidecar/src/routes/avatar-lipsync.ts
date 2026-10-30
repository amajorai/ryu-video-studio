import {
	applyAvatarLipSync,
	avatarLipSyncRequestSchema,
	envelopeFromDb,
	envelopeFromWaveform,
	type LipSyncEnvelope,
	photorealInputsRequestSchema,
	photorealPlan,
	resolveLipSyncSource,
} from "../../../shared/avatar-lipsync.ts";
import type { Asset } from "../../../shared/project.ts";
import { prepareGenerationInput } from "../generation-inputs.ts";
import { acquireMediaOperation } from "../media-operation.ts";
import { ConflictError, type StudioStore } from "../store.ts";
import { voiceActivityFeatures } from "../vad.ts";
import type { StudioRoute } from "./registry.ts";

const CONFLICT = "The project changed. Reload before lip-syncing the avatar.";

async function loudnessEnvelope(
	store: StudioStore,
	asset: Asset,
	kind: "audio" | "analysis",
	signal: AbortSignal
): Promise<LipSyncEnvelope> {
	if (kind === "analysis") {
		const analysis = store.analysis(asset.id);
		if (!(analysis?.status === "completed" && analysis.waveform.length)) {
			throw new Error(
				"Analyze this media first, or lip-sync from the audio envelope."
			);
		}
		return envelopeFromWaveform(analysis.waveform, analysis.duration);
	}
	const features = await voiceActivityFeatures(store, asset, { signal });
	return envelopeFromDb(features.energyDb, features.frameSeconds);
}

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "avatars",
		subaction: "lip-sync",
		method: "POST",
		operation: {
			id: "video_studio_avatar_lip_sync",
			description:
				"Generate an avatar's mouth rig keyframes from speech. The mouth follows the 20 ms speech-band loudness of the source (envelope 'audio', the default) or the cached analysis waveform (envelope 'analysis'): openness is the gated, normalized level raised to 0.6, smoothed without lag, widened on vowel-heavy transcript words and closed on m/b/p. segmentId uses an audible timeline clip's audio while it plays under the avatar (muted, zero-volume, or muted-track clips are refused); assetId aligns media with the avatar's start; one of them is required. The keyframes are self-contained: no source reference is kept, so removing the clip or media later leaves the mouth animation in place. sensitivity (0-1, default 0.5) lowers the gate and raises gain; smoothing (0-1, default 0.4) evens the motion. Existing mouth keyframes are replaced, other rig keyframes are kept, and the curve is decimated to the free keyframe slots (at most 100 per avatar). Requires the current project revision.",
			body: avatarLipSyncRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			request,
			store,
		}) => {
			const input = avatarLipSyncRequestSchema.parse(await request.json());
			const project = currentProject(id, input.revision, CONFLICT);
			const avatar = project.avatars.find((item) => item.id === input.avatarId);
			if (!avatar) {
				throw new Error("The avatar is not in this project.");
			}
			const assets = store.assets();
			const source = resolveLipSyncSource(project, assets, input);
			const envelope = await loudnessEnvelope(
				store,
				source.asset,
				input.envelope ?? "audio",
				mediaSignal(request)
			);
			const transcript = store.transcript(source.asset.id);
			const result = applyAvatarLipSync(project, {
				avatarId: avatar.id,
				envelope,
				sensitivity: input.sensitivity,
				smoothing: input.smoothing,
				source,
				words: transcript?.words ?? [],
			});
			if (store.project(id).revision !== project.revision) {
				throw new ConflictError(CONFLICT);
			}
			return json({
				avatarId: avatar.id,
				envelope: input.envelope ?? "audio",
				keyframes: result.keyframes,
				project: store.save(result.project),
				voicedRatio: Math.round(result.voicedRatio * 1000) / 1000,
				words: transcript?.words.length ?? 0,
			});
		},
	},
	{
		scope: "project",
		action: "avatars",
		subaction: "photoreal-inputs",
		method: "POST",
		operation: {
			id: "video_studio_photoreal_inputs",
			description:
				"Prepare the inputs for Photoreal (cloud) lip-sync or a talking avatar (G80); the local vector avatar stays the default. `consent: \"subjects-agreed\"` is required: only send footage or photos of people who agreed. `mode: lipsync` extracts the picture clip's video (no audio) and the audio clip's sound over the range where both play, at most 10 s; `mode: avatar` extracts one PNG frame of the picture clip (or its still) and up to 60 s of the audio. Both clips must play at 100% speed. Returns `{plan, picture, audio}` where `plan` says the source ranges and the timeline start and track the result belongs on, and `picture`/`audio` are prepared generation inputs to read with GET /generation-inputs/{id}/data. Nothing is sent to a model by this route. Revision-checked; does not change the project.",
			body: photorealInputsRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			request,
			store,
		}) => {
			const input = photorealInputsRequestSchema.parse(await request.json());
			const project = currentProject(id, input.revision, CONFLICT);
			const assets = store.assets();
			const plan = photorealPlan(project, assets, input);
			const pictureAsset = assets.find(
				(item) => item.id === plan.picture.assetId
			);
			const audioAsset = assets.find((item) => item.id === plan.audio.assetId);
			if (!(pictureAsset && audioAsset)) {
				throw new Error("The clip media is no longer in the library.");
			}
			const operation = acquireMediaOperation(5 * 60_000, mediaSignal(request));
			try {
				const picture =
					plan.mode === "lipsync"
						? await prepareGenerationInput(
								store,
								pictureAsset,
								{
									audio: false,
									end: plan.picture.end,
									kind: "clip",
									start: plan.picture.start,
								},
								{ operation }
							)
						: await prepareGenerationInput(
								store,
								pictureAsset,
								{ format: "png", frame: plan.picture.frame, kind: "frame" },
								{ operation }
							);
				const audio = await prepareGenerationInput(
					store,
					audioAsset,
					{ end: plan.audio.end, kind: "audio", start: plan.audio.start },
					{ operation }
				);
				return json({ audio, picture, plan });
			} finally {
				operation.release();
			}
		},
	},
];
