import {
	applyAvatarLipSync,
	envelopeFromDb,
	type LipSyncEnvelope,
	resolveLipSyncSource,
} from "../../../shared/avatar-lipsync.ts";
import type { Asset, Project } from "../../../shared/project.ts";
import {
	type PlacedScriptAvatar,
	placeScriptMusic,
	type ScriptMusic,
	scriptMusicRequest,
} from "../../../shared/script-extras.ts";
import {
	assembleScriptVideo,
	narrationTimingFromTranscript,
	scriptAssembleRequestSchema,
} from "../../../shared/script-to-video.ts";
import {
	assertSynthesisSlot,
	generateSoundtrack,
	soundtrackRendersInBackground,
	startSoundtrackJob,
} from "../soundtrack.ts";
import { ConflictError, type StudioStore } from "../store.ts";
import { voiceActivityFeatures } from "../vad.ts";
import type { StudioRoute } from "./registry.ts";

const CONFLICT = "The project changed. Reload before assembling the script.";

interface LipSyncedAvatar extends PlacedScriptAvatar {
	keyframes: number;
}

/** Lip-sync every presenter avatar to its scene's narration clip. */
async function lipSyncPresenters(
	store: StudioStore,
	project: Project,
	assets: readonly Asset[],
	avatars: readonly PlacedScriptAvatar[],
	signal: AbortSignal
): Promise<{ avatars: LipSyncedAvatar[]; project: Project }> {
	const envelopes = new Map<string, LipSyncEnvelope>();
	let next = project;
	const synced: LipSyncedAvatar[] = [];
	for (const avatar of avatars) {
		const source = resolveLipSyncSource(next, assets, {
			segmentId: avatar.narrationClipId,
		});
		let envelope = envelopes.get(source.asset.id);
		if (!envelope) {
			const features = await voiceActivityFeatures(store, source.asset, {
				signal,
			});
			envelope = envelopeFromDb(features.energyDb, features.frameSeconds);
			envelopes.set(source.asset.id, envelope);
		}
		const result = applyAvatarLipSync(next, {
			avatarId: avatar.avatarId,
			envelope,
			source,
			words: store.transcript(source.asset.id)?.words ?? [],
		});
		next = result.project;
		synced.push({ ...avatar, keyframes: result.keyframes });
	}
	return { avatars: synced, project: next };
}

type MusicOutcome =
	| {
			assetId: string;
			clipId: string;
			mood: string;
			status: "placed";
			track: number;
	  }
	| { job: unknown; mood: string; status: "running" };

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "script-assemble",
		method: "POST",
		operation: {
			id: "video_studio_script_assemble",
			description:
				"Assemble narrated script scenes into the timeline. Each scene names a narration audio asset (for example Ryu narration), a video or image visual, and its narration text. Narration clips are placed back to back (optional gap seconds) on the first free audio track that is audible (not muted or excluded by solo) from `at` (default: the end of the edit); each visual is sized to its narration on the first free visual track (stills get a slow Ken Burns zoom unless kenBurns is false; short video is slowed down to half speed at most, then tiled; visual audio is muted; fit defaults to fill). Unless captions is false, captions are built from the narration text, timed to the narration asset's saved transcript words when it has one (transcribe the narration first for word-accurate captions; otherwise timing is estimated), grouped by captionChunking (default: the project's, else word chunks), and replace existing captions overlapping the assembly. Optional music {mood?, description?, volume? (0-1, default 0.35), duck? (default true)} scores a local soundtrack over the assembly (style from mood, else keywords in description, else warm; intensity sections change at scene starts and build to the end), places it from the assembly start on a free audio track, faded and ducked under the narration; a score too long to render inline returns music.status running with a soundtrack job (poll GET /soundtrack-jobs) that places the bed into the latest project when it finishes. Optional avatar {preset: presenter-right | presenter-left | corner, lipSync? (default true)} adds one 2.5D presenter avatar per scene, spanning its narration, with mouth keyframes lip-synced to that narration clip. Requires the current project revision.",
			body: scriptAssembleRequestSchema,
		},
		handle: async ({
			id,
			json,
			mediaSignal,
			request,
			soundtrackSignal,
			store,
		}) => {
			const input = scriptAssembleRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(CONFLICT);
			}
			const result = assembleScriptVideo(project, store.assets(), input, {
				narrationTiming: (assetId) =>
					narrationTimingFromTranscript(store.transcript(assetId)),
			});
			let next = result.project;
			let avatars: LipSyncedAvatar[] = result.avatars.map((avatar) => ({
				...avatar,
				keyframes: 0,
			}));
			if (result.avatars.length && input.avatar?.lipSync !== false) {
				const synced = await lipSyncPresenters(
					store,
					next,
					store.assets(),
					result.avatars,
					mediaSignal(request)
				);
				next = synced.project;
				avatars = synced.avatars;
			}
			const start = result.scenes[0]?.start ?? 0;
			const music = input.music;
			const musicBody = music ? scriptMusicRequest(result, music) : undefined;
			let musicOutcome: MusicOutcome | undefined;
			const place = (current: Project, asset: Asset, settings: ScriptMusic) =>
				placeScriptMusic(current, store.assets(), asset, {
					duck: settings.duck,
					duration: result.duration,
					start,
					volume: settings.volume,
				});
			if (music && musicBody && !soundtrackRendersInBackground(musicBody)) {
				const asset = await generateSoundtrack(store, musicBody, {
					signal: soundtrackSignal(request),
				});
				const placed = place(next, asset, music);
				next = placed.project;
				musicOutcome = {
					assetId: asset.id,
					clipId: placed.clipId,
					mood: musicBody.mood,
					status: "placed",
					track: placed.track,
				};
			}
			const background = Boolean(music && musicBody && !musicOutcome);
			if (background) {
				// Refuse a full synthesis budget before anything is saved.
				assertSynthesisSlot();
			}
			if (store.project(id).revision !== project.revision) {
				throw new ConflictError(CONFLICT);
			}
			const saved = store.save(next);
			if (background && music && musicBody) {
				// The job outlives this request, so its signal must not follow it.
				const detached = new Request(request.url);
				musicOutcome = {
					job: startSoundtrackJob(store, musicBody, {
						finish: (asset) => {
							// Placed into the latest project, like a late edit.
							store.save(place(store.project(id), asset, music).project);
						},
						signal: soundtrackSignal(detached),
					}),
					mood: musicBody.mood,
					status: "running",
				};
			}
			// JSON drops `music` when no bed was requested.
			return json({
				avatars,
				captions: result.captions,
				duration: result.duration,
				music: musicOutcome,
				narrationTrack: result.narrationTrack,
				project: saved,
				replacedCaptions: result.replacedCaptions,
				scenes: result.scenes,
				visualTrack: result.visualTrack,
			});
		},
	},
];
