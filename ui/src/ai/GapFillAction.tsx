import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	canGapFill,
	gapFillNeighbors,
	localMotionGapRefusal,
	motionGapRefusal,
} from "../../../shared/gap-fill.ts";
import { isLocalEngineProvider } from "../../../shared/generation-models.ts";
import {
	type Asset,
	assetSchema,
	type Segment,
} from "../../../shared/project.ts";
import { request } from "../bridge.ts";
import { timelineTimingKey } from "../editing-ui.ts";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import { useBridgeFeatures } from "./AiVideoTools.tsx";
import { runGapFill } from "./gap-fill-run.ts";
import {
	bridgeSupports,
	hostGenerationServices,
	hostMediaBridge,
} from "./media-bridge.ts";
import { runGapFillMotion } from "./reference-tasks.ts";
import { initialTaskChoice, TaskModelFields } from "./TaskModelFields.tsx";
import {
	type TaskModelChoice,
	taskUnavailableReason,
} from "./task-generation.ts";

function withAssets(current: Asset[], added: readonly Asset[]): Asset[] {
	const known = new Set(current.map((asset) => asset.id));
	return [...added.filter((asset) => !known.has(asset.id)), ...current];
}

/**
 * "Fill gap with AI" for the inspected clip: bridges it to the next picture
 * clip on its track with a generated still, dissolves on both sides, and a
 * slow Ken Burns push. Renders nothing when there is no following clip.
 */
export function GapFillAction({ segment }: { segment: Segment }) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { assets, busy, project } = runtime;
	const [direction, setDirection] = useState("");
	const [model, setModel] = useState("");
	const [working, setWorking] = useState(false);
	const [mode, setMode] = useState<"still" | "motion">("still");
	const [motion, setMotion] = useState<TaskModelChoice>(() =>
		initialTaskChoice("flf")
	);
	const features = useBridgeFeatures();
	if (!canGapFill(project, assets, segment.id)) {
		return null;
	}
	const gap = gapFillNeighbors(project, assets, segment.id).gap;
	const gapRefusal = motionGapRefusal(gap, project.fps);
	const hasGap = !gapRefusal;
	const motionMode = mode === "motion" && hasGap;
	const motionReason = taskUnavailableReason(
		hostMediaBridge(),
		features,
		"flf"
	);
	const localGapRefusal =
		motionMode && isLocalEngineProvider(motion.provider)
			? localMotionGapRefusal(gap)
			: undefined;
	const canGenerate = motionMode
		? !(motionReason || localGapRefusal)
		: bridgeSupports(hostMediaBridge(), "image");
	const disabled = busy || working || !canGenerate;
	const fillMotion = async () => {
		if (disabled) {
			return;
		}
		setWorking(true);
		runtime.setStatus(
			"Generating motion between the boundary frames through Ryu. The node's model policy, approvals, and provider configuration apply."
		);
		try {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			const result = await runGapFillMotion({
				assets,
				choice: motion,
				clipId: segment.id,
				direction,
				place: async (placement) => {
					const outcome = await runtime.routeEdit(
						"gap-fill",
						{ ...placement },
						() =>
							"Filled the gap with generated motion that starts and ends on the neighbouring frames.",
						{ planStamp: timelineTimingKey(saved), refreshAssets: true }
					);
					return outcome.status === "ok" &&
						typeof outcome.extras.clipId === "string"
						? outcome.extras.clipId
						: undefined;
				},
				project: saved,
				services: hostGenerationServices((progress) =>
					runtime.setStatus(
						tl("Saving the motion bridge · {percent}%", {
							percent: Math.round(Math.min(1, progress) * 100),
						})
					)
				),
			});
			runtime.setAssets((current) => withAssets(current, [result.asset]));
			if (result.historyWarning) {
				runtime.setStatus(result.historyWarning);
			} else if (!result.placedClipId) {
				runtime.setStatus(
					tl(
						"Saved “{name}” to the library, but the timeline changed while it was generating, so it was not placed. Run Generate motion again for the current clips.",
						{ name: result.asset.name }
					)
				);
			}
		} catch (error) {
			runtime.setStatus(message(error));
		} finally {
			setWorking(false);
		}
	};
	const fill = async () => {
		if (disabled) {
			return;
		}
		setWorking(true);
		runtime.setStatus(
			"Generating a bridge still through Ryu. The node's model policy, approvals, and provider configuration apply."
		);
		try {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			const result = await runGapFill({
				assets,
				capture: (time, name) =>
					request(assetSchema, `/projects/${saved.id}/capture-frame`, "POST", {
						name,
						revision: saved.revision,
						time,
					}),
				clipId: segment.id,
				direction,
				model: model.trim(),
				place: async (placement) => {
					const outcome = await runtime.routeEdit(
						"gap-fill",
						{ ...placement },
						() =>
							"Bridged the cut with an AI still: dissolves on both sides and a slow push-in.",
						{ planStamp: timelineTimingKey(saved), refreshAssets: true }
					);
					return outcome.status === "ok" &&
						typeof outcome.extras.clipId === "string"
						? outcome.extras.clipId
						: undefined;
				},
				project: saved,
				services: hostGenerationServices((progress) =>
					runtime.setStatus(
						tl("Saving the bridge still · {percent}%", {
							percent: Math.round(Math.min(1, progress) * 100),
						})
					)
				),
			});
			runtime.setAssets((current) =>
				withAssets(current, [result.asset, ...result.frames])
			);
			if (result.historyWarning) {
				runtime.setStatus(result.historyWarning);
			} else if (!result.placedClipId) {
				runtime.setStatus(
					tl(
						"Saved “{name}” to the library, but the timeline changed before it could be placed. Run gap fill again or place it by hand.",
						{ name: result.asset.name }
					)
				);
			}
		} catch (error) {
			runtime.setStatus(message(error));
		} finally {
			setWorking(false);
		}
	};
	return (
		<>
			<RyuAppField
				description={
					hasGap
						? "Generate motion animates from this clip's exact last frame to the next clip's first frame and fills the gap. The still bridge crossfades through one image."
						: gap > 0
							? gapRefusal
							: "Generate motion needs a gap between the clips; at a cut the still bridge applies."
				}
				label="Bridge"
			>
				<NativeSelect
					aria-label="Gap fill bridge"
					disabled={busy || working}
					onChange={(event) =>
						setMode(event.target.value === "motion" ? "motion" : "still")
					}
					value={motionMode ? "motion" : "still"}
				>
					<NativeSelectOption value="still">
						Still bridge (image model)
					</NativeSelectOption>
					<NativeSelectOption disabled={!hasGap} value="motion">
						Generate motion (video model)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="AI transition">
				<Textarea
					aria-label="Gap fill direction"
					disabled={busy || working}
					maxLength={2000}
					onChange={(event) => setDirection(event.target.value)}
					placeholder="Optional: describe the in-between moment…"
					value={direction}
				/>
			</RyuAppField>
			{motionMode ? (
				<TaskModelFields
					choice={motion}
					disabled={busy || working}
					onChange={setMotion}
					task="flf"
				/>
			) : (
				<RyuAppField label="Model (optional)">
					<Input
						aria-label="Gap fill model"
						disabled={busy || working}
						maxLength={200}
						onChange={(event) => setModel(event.target.value)}
						placeholder="Choose a model that accepts input images"
						value={model}
					/>
				</RyuAppField>
			)}
			<RyuAppActions>
				<Button
					disabled={disabled}
					onClick={() => void (motionMode ? fillMotion() : fill())}
					size="sm"
					variant="outline"
				>
					{working
						? "Filling…"
						: motionMode
							? "Generate motion"
							: "Fill gap with AI"}
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground">
				{motionMode
					? (motionReason ??
						localGapRefusal ??
						"Sends the two exact boundary frames to the selected first/last-frame model and trims the result to the gap. Cloud models may incur provider charges.")
					: canGenerate
						? "Captures this clip's last frame and the next clip's first frame, generates a bridging still, and crossfades through it. Cloud models may incur provider charges."
						: "AI gap fill is unavailable in this host. Open the app in Ryu with media permissions and an image model configured."}
			</p>
		</>
	);
}
