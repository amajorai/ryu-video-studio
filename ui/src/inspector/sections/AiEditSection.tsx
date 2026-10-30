import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
	type GenerationJob,
	generationJobSchema,
} from "../../../../shared/generation.ts";
import type { Asset } from "../../../../shared/project.ts";
import { AiVideoTools } from "../../ai/AiVideoTools.tsx";
import {
	type AiEditResult,
	aiEditAvailability,
	aiEditClip,
	EDIT_FRAME_HOLD_SECONDS,
	editFrameAsStill,
	type InsertedStill,
	insertedStillSegment,
	regenerateClip,
	swapStillMedia,
} from "../../ai/ai-edit.ts";
import {
	bridgeSupports,
	hostGenerationServices,
	hostMediaBridge,
} from "../../ai/media-bridge.ts";
import {
	ReferenceImagePicker,
	referenceCandidates,
} from "../../ai/ReferenceImagePicker.tsx";
import { loadAssets, request } from "../../bridge.ts";
import { useEditorProject } from "../../editor/context.tsx";
import { clock, message } from "../../editor/format.ts";
import type { ClipSectionProps } from "../section-props.ts";

const TIMELINE_LIMIT = 7200;
const jobsResponseSchema = z.object({ jobs: z.array(z.json()) });

/**
 * This project's recorded generation requests, reloaded whenever
 * `refreshKey` changes: a new project revision, library, inspected media,
 * or a run of this section can each bring a new completed request.
 */
function useGenerationJobs(projectId: string, refreshKey: string) {
	const [jobs, setJobs] = useState<GenerationJob[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey marks changes that can add completed requests.
	useEffect(() => {
		let mounted = true;
		if (!window.ryu?.app?.request) {
			return;
		}
		request(jobsResponseSchema, `/generations?projectId=${projectId}`)
			.then((result) => {
				if (mounted) {
					setJobs(result.jobs.map((job) => generationJobSchema.parse(job)));
				}
			})
			.catch(() => {
				// History is optional here: without it, Regenerate stays hidden
				// unless the media carries its own generation metadata.
				if (mounted) {
					setJobs([]);
				}
			});
		return () => {
			mounted = false;
		};
	}, [projectId, refreshKey]);
	return jobs;
}

function withAsset(assets: Asset[], asset: Asset): Asset[] {
	return assets.some((candidate) => candidate.id === asset.id)
		? assets
		: [asset, ...assets];
}

/** Edit with AI, Edit frame as still, and Regenerate for the inspected clip. */
export function AiEditSection({ segment }: ClipSectionProps) {
	const runtime = useEditorProject();
	const { assets, busy, project, time } = runtime;
	const tl = useLiteralMessages();
	const [prompt, setPrompt] = useState("");
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [references, setReferences] = useState<string[]>([]);
	const [working, setWorking] = useState(false);
	const [jobsRevision, setJobsRevision] = useState(0);
	const [inspectedId, setInspectedId] = useState(segment.id);
	if (inspectedId !== segment.id) {
		// A different clip starts from a clean form: direction, route, and
		// references chosen for one clip do not carry over to the next.
		setInspectedId(segment.id);
		setPrompt("");
		setProvider("");
		setModel("");
		setReferences([]);
	}
	const jobs = useGenerationJobs(
		project.id,
		[
			jobsRevision,
			project.revision,
			segment.assetId,
			assets.map((asset) => asset.id).join(","),
		].join("|")
	);
	const availability = aiEditAvailability(segment, assets, jobs);
	const excludeId = availability.edit ? segment.assetId : undefined;
	// References deleted from the library since they were chosen no longer
	// have a checkbox, so they are dropped rather than failing every edit.
	const candidateIds = new Set(
		referenceCandidates(assets, excludeId).map((asset) => asset.id)
	);
	const liveReferences = references.filter((id) => candidateIds.has(id));
	const bridge = hostMediaBridge();
	const canEditImages = bridgeSupports(bridge, "image");
	if (
		!(availability.edit || availability.editFrame || availability.regenerate)
	) {
		return null;
	}
	const disabled = busy || working;
	const services = hostGenerationServices((progress) =>
		runtime.setStatus(
			tl("Saving AI media · {percent}%", {
				percent: String(Math.round(Math.min(1, progress) * 100)),
			})
		)
	);
	const swap = async (clipId: string, asset: Asset) => {
		const current = runtime.latestProject.current;
		const library = withAsset(await loadAssets(), asset);
		const previous = library.find(
			(candidate) =>
				candidate.id ===
				current?.segments.find((clip) => clip.id === clipId)?.assetId
		);
		if (asset.kind === "image" && previous?.kind === "image") {
			// Stills keep the clip's exact length: the shared swap edit would
			// clamp it to the new image's nominal duration.
			if (!current) {
				return false;
			}
			try {
				swapStillMedia(current, library, clipId, asset);
			} catch (error) {
				runtime.setStatus(message(error));
				return false;
			}
			runtime.latestEdit(
				(latest) => {
					try {
						return swapStillMedia(latest, library, clipId, asset);
					} catch {
						return latest;
					}
				},
				() => "Swapped in the AI still; length, transform, and grade were kept."
			);
			return true;
		}
		const outcome = await runtime.routeEdit(
			"swap-clip-media",
			{ assetId: asset.id, clipId },
			() => "Swapped in the AI media; trims, transform, and grade were kept.",
			{ refreshAssets: true }
		);
		return outcome.status === "ok";
	};
	const freeze = async (): Promise<InsertedStill | undefined> => {
		const before = runtime.latestProject.current;
		if (!before) {
			return undefined;
		}
		const at = Math.max(0, Math.min(TIMELINE_LIMIT, time));
		const outcome = await runtime.routeEdit(
			"freeze-frame",
			{
				at,
				clipId: segment.id,
				duration: EDIT_FRAME_HOLD_SECONDS,
				mode: "insert",
			},
			() => `Froze the frame at ${clock(at)} for AI editing.`,
			{ refreshAssets: true }
		);
		const after = runtime.latestProject.current;
		if (outcome.status !== "ok" || !after) {
			return undefined;
		}
		const still = insertedStillSegment(before, after);
		return still ? { assets: await loadAssets(), segment: still } : undefined;
	};
	const run = async (label: string, operation: () => Promise<AiEditResult>) => {
		if (disabled) {
			return;
		}
		setWorking(true);
		runtime.setStatus(
			tl(
				"{action} through Ryu. The node's model policy, approvals, and provider configuration apply.",
				{ action: tl(label) }
			)
		);
		try {
			const result = await operation();
			runtime.setAssets((current) => withAsset(current, result.asset));
			if (result.historyWarning) {
				runtime.setStatus(result.historyWarning);
			} else if (!result.swappedClipId) {
				runtime.setStatus(
					tl(
						"Saved “{name}” to the library, but the timeline changed before it could be swapped in. Use Replace media to apply it.",
						{ name: result.asset.name }
					)
				);
			}
		} catch (error) {
			runtime.setStatus(message(error));
		} finally {
			setJobsRevision((value) => value + 1);
			setWorking(false);
		}
	};
	const context = {
		model: model.trim(),
		projectId: project.id,
		prompt,
		provider: provider.trim(),
		referenceIds: liveReferences,
		segment,
		services,
		swap,
	};
	const showEditor = availability.edit || availability.editFrame;
	const inspectedAsset = assets.find(
		(candidate) => candidate.id === segment.assetId
	);
	return (
		<>
			{showEditor && (
				<>
					<RyuAppField label="Edit with AI">
						<Textarea
							aria-label="AI edit direction"
							disabled={disabled}
							maxLength={8000}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder={
								availability.edit
									? "Describe the change to this image…"
									: "Describe the change to the frame at the playhead…"
							}
							value={prompt}
						/>
					</RyuAppField>
					<ReferenceImagePicker
						assets={assets}
						disabled={disabled}
						excludeId={excludeId}
						onChange={setReferences}
						selected={liveReferences}
					/>
					<RyuAppField label="Provider (optional)">
						<Input
							aria-label="AI edit provider"
							disabled={disabled}
							maxLength={200}
							onChange={(event) => setProvider(event.target.value)}
							placeholder="Use node default"
							value={provider}
						/>
					</RyuAppField>
					<RyuAppField label="Model (optional)">
						<Input
							aria-label="AI edit model"
							disabled={disabled}
							maxLength={200}
							onChange={(event) => setModel(event.target.value)}
							placeholder="Choose a model that accepts input images"
							value={model}
						/>
					</RyuAppField>
				</>
			)}
			{!canEditImages && showEditor && (
				<p>
					AI image editing is unavailable in this host. Open the app in Ryu with
					media permissions and an image model configured.
				</p>
			)}
			<RyuAppActions>
				{availability.edit && (
					<Button
						disabled={disabled || !canEditImages || !prompt.trim()}
						onClick={() =>
							void run("Editing the image", () =>
								aiEditClip({ ...context, assets })
							)
						}
						size="sm"
						variant="outline"
					>
						{working ? "Editing…" : "Edit with AI"}
					</Button>
				)}
				{availability.editFrame && (
					<Button
						disabled={disabled || !canEditImages || !prompt.trim()}
						onClick={() =>
							void run("Editing the frame", () =>
								editFrameAsStill({ ...context, assets, freeze })
							)
						}
						size="sm"
						variant="outline"
					>
						Edit frame as still
					</Button>
				)}
				{availability.regenerate && availability.provenance && (
					<Button
						disabled={
							disabled || !bridgeSupports(bridge, availability.provenance.kind)
						}
						onClick={() =>
							void run("Regenerating", () =>
								regenerateClip({ ...context, assets, jobs })
							)
						}
						size="sm"
						variant="outline"
					>
						Regenerate
					</Button>
				)}
			</RyuAppActions>
			<p className="text-muted-foreground">
				{availability.editFrame
					? tl(
							"Edit frame as still inserts a {seconds}s freeze at the playhead and replaces it with the edited still. Results are saved to your library and swapped into the clip, keeping its trims, transform, and grade. Cloud models may incur provider charges.",
							{ seconds: String(EDIT_FRAME_HOLD_SECONDS) }
						)
					: tl(
							"Results are saved to your library and swapped into the clip, keeping its trims, transform, and grade. Cloud models may incur provider charges."
						)}
			</p>
			{inspectedAsset && (
				<AiVideoTools
					asset={inspectedAsset}
					key={segment.id}
					segment={segment}
				/>
			)}
		</>
	);
}
