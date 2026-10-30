import { z } from "zod";
import {
	conformGeneratedAudioRequestSchema,
	soundtrackRequestSchema,
} from "../../../shared/soundtrack.ts";
import {
	alignSoundtrackPlan,
	soundtrackDescriptionSchema,
	soundtrackPlanInput,
	soundtrackPlanPrompt,
	soundtrackPlanSchema,
	soundtrackRequestFromPlan,
} from "../../../shared/soundtrack-plan.ts";
import {
	conformGeneratedAudio,
	generateSoundtrack,
	soundtrackJob,
	soundtrackRendersInBackground,
	startSoundtrackJob,
} from "../soundtrack.ts";
import type { StudioRoute } from "./registry.ts";

const rangeTime = z.number().finite().min(0).max(7200);

export const soundtrackPlanAlignRequestSchema = z
	.object({
		plan: soundtrackPlanSchema,
		/** Largest boundary move in seconds when snapping to a cut or downbeat. */
		tolerance: z.number().finite().min(0).max(10).optional(),
		/** Score only this timeline range (both or neither). */
		start: rangeTime.optional(),
		end: rangeTime.optional(),
	})
	.strict()
	.refine(
		(value) => (value.start === undefined) === (value.end === undefined),
		{
			message: "Send both start and end to score a range.",
		}
	);

/** The planner query: an optional description and an optional range. */
function planQuery(url: URL) {
	const description = soundtrackDescriptionSchema.parse(
		url.searchParams.get("description") ?? ""
	);
	const start = url.searchParams.get("start");
	const end = url.searchParams.get("end");
	if ((start === null) !== (end === null)) {
		throw new Error("Send both start and end to score a range.");
	}
	const range =
		start === null || end === null
			? undefined
			: {
					end: rangeTime.parse(Number(end)),
					start: rangeTime.parse(Number(start)),
				};
	return { description, range };
}

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "soundtrack",
		method: "POST",
		operation: {
			id: "video_studio_generate_soundtrack",
			description:
				"Generate a bounded local soundtrack WAV with a selected style, tempo, optional instrument layers (pad, bass, arpeggio, kick, hat, snare, pluck), optional intensity sections and an optional downbeat offset that phases the bars, then save it as an app-owned audio asset. Returns 201 with the asset. A long score that would outlast the request returns 202 {job}; poll GET /soundtrack-jobs?id=<job id> until status is done (job.asset) or failed (job.error).",
			body: soundtrackRequestSchema,
		},
		handle: async ({ json, request, soundtrackSignal, store }) => {
			const input = soundtrackRequestSchema.parse(await request.json());
			if (soundtrackRendersInBackground(input)) {
				// The job outlives this request, so its signal must not follow the
				// request: a fresh Request never aborts, leaving only shutdown.
				const detached = new Request(request.url);
				return json(
					{
						job: startSoundtrackJob(store, input, {
							signal: soundtrackSignal(detached),
						}),
					},
					202
				);
			}
			return json(
				await generateSoundtrack(store, input, {
					signal: soundtrackSignal(request),
				}),
				201
			);
		},
	},
	{
		scope: "root",
		path: "soundtrack-jobs",
		method: "GET",
		operation: {
			id: "video_studio_soundtrack_job",
			description:
				"Read a background soundtrack job started by POST /soundtrack (202). status is running, done (asset holds the saved audio asset) or failed (error holds code and message). Jobs are kept for an hour after they finish.",
			query: [
				{
					name: "id",
					required: true,
					schema: { type: "string", format: "uuid" },
				},
			],
		},
		handle: ({ json, url }) => {
			const id = z.uuid().parse(url.searchParams.get("id"));
			const job = soundtrackJob(id);
			return job
				? json(job)
				: json(
						{ code: "NOT_FOUND", message: "Soundtrack job not found." },
						404
					);
		},
	},
	{
		scope: "project",
		action: "soundtrack-plan",
		method: "GET",
		operation: {
			id: "video_studio_soundtrack_plan_context",
			description:
				"Read the timeline summary, picture cut times, beat-marker times and the planning prompt for a soundtrack plan. Send the prompt to a model, then align its JSON plan with POST soundtrack-plan. Optional query: description (up to 500 characters, what the music should sound like; the model maps it to style, tempo, layers and section energy) and start/end (seconds) to score only that timeline range, with times shifted so the range starts at 0; place the generated soundtrack at start.",
			query: [
				{ name: "description", schema: { type: "string", maxLength: 500 } },
				{ name: "start", schema: { type: "number", minimum: 0 } },
				{ name: "end", schema: { type: "number", minimum: 0 } },
			],
		},
		handle: ({ id, json, store, url }) => {
			const project = store.project(id);
			const { description, range } = planQuery(url);
			const input = soundtrackPlanInput(
				project,
				store.assets(),
				range,
				description
			);
			return json({
				beats: input.beats,
				prompt: soundtrackPlanPrompt(
					input.summary,
					input.sceneCuts,
					input.beats,
					input.description
				),
				...(range ? { range } : {}),
				sceneCuts: input.sceneCuts,
				summary: input.summary,
			});
		},
	},
	{
		scope: "project",
		action: "soundtrack-plan",
		method: "POST",
		operation: {
			id: "video_studio_align_soundtrack_plan",
			description:
				"Align a soundtrack plan {style, bpm, layers?, sections} to the project: sections become contiguous over the timeline (or over start..end when both are sent, with times relative to start) and each change moves to the nearest picture cut, else the nearest downbeat, within the tolerance. Returns the aligned plan and the POST /soundtrack body (layers included when the plan picked them). Read-only.",
			body: soundtrackPlanAlignRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = soundtrackPlanAlignRequestSchema.parse(
				await request.json()
			);
			const project = store.project(id);
			const context = soundtrackPlanInput(
				project,
				store.assets(),
				input.start === undefined || input.end === undefined
					? undefined
					: { end: input.end, start: input.start }
			);
			const plan = alignSoundtrackPlan(input.plan, {
				beats: context.beats,
				duration: context.summary.duration,
				sceneCuts: context.sceneCuts,
				tolerance: input.tolerance,
			});
			return json({
				plan,
				request: soundtrackRequestFromPlan(plan, context.summary.duration),
			});
		},
	},
	{
		scope: "root",
		path: "soundtrack-conform",
		method: "POST",
		operation: {
			id: "video_studio_conform_generated_music",
			description:
				"Fit generated music (an audio asset saved from the host's media.audio bridge, which carries `generation` provenance) to the timeline: trim to `duration` seconds, fade the last `fadeOut` seconds (default 1), limit peaks, and save it as a new 48 kHz WAV asset in the soundtracks folder. The new asset keeps the provider and model provenance for the credits report; the original stays in the library. Media without generation provenance is refused. Shares the soundtrack concurrency budget.",
			body: conformGeneratedAudioRequestSchema,
			bodyJsonSchema: z.toJSONSchema(conformGeneratedAudioRequestSchema, {
				io: "input",
			}),
		},
		handle: async ({ json, request, soundtrackSignal, store }) =>
			json(
				await conformGeneratedAudio(
					store,
					await request.json(),
					"soundtracks",
					{
						signal: soundtrackSignal(request),
					}
				),
				201
			),
	},
];
