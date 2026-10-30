import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Switch, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { MAX_INPUT_CLIP_SECONDS } from "../../../shared/generation-inputs.ts";
import type { GenerationTask } from "../../../shared/generation-models.ts";
import type { Asset, Project, Segment } from "../../../shared/project.ts";
import type { StudioBridgeFeatures } from "../bridge.ts";
import { loadAssets } from "../bridge.ts";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import { swapStillMedia } from "./ai-edit.ts";
import { hostGenerationServices, hostMediaBridge } from "./media-bridge.ts";
import {
	overwritePlacementEdit,
	type PlaceOver,
	runAiMatte,
	runVideoToVideo,
} from "./reference-tasks.ts";
import { initialTaskChoice, TaskModelFields } from "./TaskModelFields.tsx";
import {
	hostBridgeFeatures,
	type TaskModelChoice,
	taskUnavailableReason,
} from "./task-generation.ts";

/** The host's generation-bridge flags, read once per mount. */
export function useBridgeFeatures(): Partial<StudioBridgeFeatures> | undefined {
	const [features, setFeatures] = useState<Partial<StudioBridgeFeatures>>();
	useEffect(() => {
		let active = true;
		hostBridgeFeatures().then((value) => {
			if (active) {
				setFeatures(value);
			}
		});
		return () => {
			active = false;
		};
	}, []);
	return features;
}

/**
 * Place library media over a range with the overwrite edit. `inputs` is the
 * saved timeline the generation inputs were prepared from: when clips have
 * moved, trimmed, or changed speed since (saved or not), placement is refused
 * as a conflict instead of landing over whatever is there now.
 */
export function useOverwritePlacement(): (inputs: Project) => PlaceOver {
	const runtime = useEditorProject();
	return (inputs) => async (placement) => {
		const { body, options } = overwritePlacementEdit(inputs, placement);
		const outcome = await runtime.routeEdit(
			"overwrite",
			body,
			() => "Placed the AI result as a take over the clip.",
			options
		);
		return outcome.status === "ok";
	};
}

/** The saved copy of `clipId`, or a refusal when it is gone. */
function savedClip(saved: Project, clipId: string): Segment {
	const clip = saved.segments.find((candidate) => candidate.id === clipId);
	if (!clip) {
		throw new Error("The clip was removed. Select a clip and try again.");
	}
	return clip;
}

function withAsset(assets: Asset[], asset: Asset): Asset[] {
	return assets.some((candidate) => candidate.id === asset.id)
		? assets
		: [asset, ...assets];
}

/**
 * AI edit → Video (G78) and AI matte (G46) for the inspected clip. Both run
 * on cloud models through the host bridge; results are saved to the
 * library and placed as a take, and Edit frame as still stays available.
 */
export function AiVideoTools({
	asset,
	segment,
}: {
	asset: Asset;
	segment: Segment;
}) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { busy } = runtime;
	const features = useBridgeFeatures();
	const place = useOverwritePlacement();
	const matteTask: GenerationTask =
		asset.kind === "image" ? "matte-image" : "matte-video";
	const [prompt, setPrompt] = useState("");
	const [v2v, setV2v] = useState<TaskModelChoice>(() =>
		initialTaskChoice("v2v")
	);
	const [matte, setMatte] = useState<TaskModelChoice>(() =>
		initialTaskChoice(matteTask)
	);
	const [invert, setInvert] = useState(false);
	const [working, setWorking] = useState("");
	if (asset.kind === "audio" || asset.sequenceProjectId) {
		return null;
	}
	const bridge = hostMediaBridge();
	const v2vReason =
		asset.kind === "video"
			? taskUnavailableReason(bridge, features, "v2v")
			: undefined;
	const matteReason = taskUnavailableReason(bridge, features, matteTask);
	const disabled = busy || Boolean(working);
	const services = hostGenerationServices((progress) =>
		runtime.setStatus(
			tl("Saving AI media · {percent}%", {
				percent: Math.round(Math.min(1, progress) * 100),
			})
		)
	);
	const run = async (
		label: string,
		operation: (saved: Project) => Promise<string>
	) => {
		if (disabled) {
			return;
		}
		setWorking(label);
		runtime.setStatus(
			tl(
				"{action} through Ryu. The node's model policy, approvals, and provider configuration apply.",
				{ action: label }
			)
		);
		try {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			runtime.setStatus(await operation(saved));
		} catch (error) {
			runtime.setStatus(message(error));
		} finally {
			setWorking("");
		}
	};
	const swapStill = async (clipId: string, still: Asset) => {
		const library = withAsset(await loadAssets(), still);
		runtime.setAssets(library);
		runtime.latestEdit(
			(latest) => {
				try {
					return swapStillMedia(latest, library, clipId, still);
				} catch {
					return latest;
				}
			},
			() =>
				"Swapped in the matted still; length, transform, and grade were kept."
		);
		return true;
	};
	const tooLong =
		segment.sourceOut - segment.sourceIn > MAX_INPUT_CLIP_SECONDS + 1e-6;
	return (
		<>
			{asset.kind === "video" && (
				<>
					<RyuAppField
						description={
							tooLong
								? tl(
										"Sends the first {seconds} s at up to 720p to a video-to-video model and places the result as a take. Edit frame as still stays available for a single frame.",
										{ seconds: MAX_INPUT_CLIP_SECONDS }
									)
								: tl(
										"Sends the clip at up to 720p to a video-to-video model and places the result as a take. Edit frame as still stays available for a single frame."
									)
						}
						label="AI edit → Video"
					>
						<Textarea
							aria-label="AI video edit direction"
							disabled={disabled}
							maxLength={8000}
							onChange={(event) => setPrompt(event.target.value)}
							placeholder="Describe the change to this clip…"
							value={prompt}
						/>
					</RyuAppField>
					<TaskModelFields
						choice={v2v}
						disabled={disabled}
						onChange={setV2v}
						task="v2v"
					/>
					{v2vReason && <p className="text-xs">{v2vReason}</p>}
					<RyuAppActions>
						<Button
							disabled={disabled || Boolean(v2vReason) || !prompt.trim()}
							onClick={() =>
								void run("Editing the clip", async (saved) => {
									const result = await runVideoToVideo({
										asset,
										choice: v2v,
										place: place(saved),
										projectId: saved.id,
										prompt,
										segment: savedClip(saved, segment.id),
										services,
									});
									runtime.setAssets((current) =>
										withAsset(current, result.asset)
									);
									return (
										result.historyWarning ??
										(result.placed
											? `Placed the AI video edit as a take${result.truncated ? ` (first ${MAX_INPUT_CLIP_SECONDS} s)` : ""}.`
											: `Saved “${result.asset.name}” to the library. It was not placed; place it from there.`)
									);
								})
							}
							size="sm"
							variant="outline"
						>
							{working === "Editing the clip" ? "Editing…" : "AI edit → Video"}
						</Button>
					</RyuAppActions>
				</>
			)}
			<TaskModelFields
				choice={matte}
				disabled={disabled}
				onChange={setMatte}
				task={matteTask}
			/>
			<RyuAppField
				description="Keeps the background and removes the subject instead."
				label="Keep background"
			>
				<Switch
					aria-label="Keep background"
					checked={invert}
					disabled={disabled}
					onCheckedChange={setInvert}
				/>
			</RyuAppField>
			{matteReason && <p className="text-xs">{matteReason}</p>}
			<RyuAppActions>
				<Button
					disabled={disabled || Boolean(matteReason)}
					onClick={() =>
						void run("Matting the subject", async (saved) => {
							const result = await runAiMatte({
								asset,
								choice: matte,
								invert,
								place: place(saved),
								projectId: saved.id,
								segment: savedClip(saved, segment.id),
								services,
								swapStill,
							});
							runtime.setAssets((current) =>
								withAsset(
									withAsset(current, result.asset),
									result.output ?? result.asset
								)
							);
							return (
								result.historyWarning ??
								(result.placed
									? "Applied the AI matte: the subject now has a transparent background."
									: `Saved the matted copy “${result.output?.name ?? result.asset.name}” to the library. It was not placed; place it from there.`)
							);
						})
					}
					size="sm"
					variant="outline"
				>
					{working === "Matting the subject" ? "Matting…" : "AI matte"}
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground text-xs">
				These tools send media to the selected cloud model. Results are saved to
				your library; provider charges may apply.
			</p>
		</>
	);
}
