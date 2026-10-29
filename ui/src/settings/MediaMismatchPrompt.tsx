import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import { z } from "zod";
import type { Asset, Project } from "../../../shared/project.ts";
import {
	firstClipMediaAsset,
	type MediaSettingsMismatch,
	mediaSettingsMismatch,
} from "../../../shared/settings.ts";
import { useEditorProject } from "../editor/context.tsx";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";

/** Per-viewer list of `projectId:assetId` prompts the viewer declined. */
const DISMISSED_KEY = "media-mismatch.dismissed";
const MAX_DISMISSED = 100;
const dismissedSchema = z.array(z.string().max(80)).max(MAX_DISMISSED);

const size = (width: number, height: number) => `${width}×${height}`;
const rate = (fps: number | undefined) =>
	fps === undefined ? "" : ` at ${fps} fps`;

/** Sentence describing how the first clip differs from the project. */
export function mediaMismatchText(
	project: Pick<Project, "fps" | "height" | "width">,
	asset: Pick<Asset, "height" | "name" | "width">,
	mismatch: MediaSettingsMismatch
): string {
	const media = `“${asset.name}” is ${size(asset.width, asset.height)}${rate(mismatch.mediaFrameRate)}; the project is ${size(project.width, project.height)} at ${project.fps} fps.`;
	if (mismatch.canvas === undefined && mismatch.fps === undefined) {
		return `${media} Its ${mismatch.unsupportedFps} fps rate cannot be exported yet, so the project keeps its settings.`;
	}
	const changes = [
		mismatch.canvas
			? `the canvas to ${size(mismatch.canvas.width, mismatch.canvas.height)}`
			: undefined,
		mismatch.fps === undefined ? undefined : `the rate to ${mismatch.fps} fps`,
	].filter(Boolean);
	const pending =
		mismatch.unsupportedFps === undefined
			? ""
			: ` Its ${mismatch.unsupportedFps} fps rate cannot be exported yet.`;
	return `${media} Matching sets ${changes.join(" and ")}.${pending}`;
}

/**
 * "Match project to media": offered while the timeline holds only its first
 * clip and that clip's media differs from the project canvas or frame rate.
 * Matching saves through the revision-checked `match-media` route, so it is
 * one undo step; declining is remembered per viewer for that project and
 * asset.
 */
export function MediaMismatchPrompt() {
	const runtime = useEditorProject();
	const { assets, busy, project } = runtime;
	const [dismissed, setDismissed] = useState(() =>
		readViewerValue(DISMISSED_KEY, dismissedSchema, [])
	);
	const asset = firstClipMediaAsset(project, assets);
	if (!asset) {
		return null;
	}
	const mismatch = mediaSettingsMismatch(project, asset);
	const key = `${project.id}:${asset.id}`;
	if (!mismatch || dismissed.includes(key)) {
		return null;
	}
	const dismiss = () => {
		const next = [...dismissed.filter((item) => item !== key), key].slice(
			-MAX_DISMISSED
		);
		setDismissed(next);
		writeViewerValue(DISMISSED_KEY, next);
	};
	const matchable = mismatch.canvas !== undefined || mismatch.fps !== undefined;
	return (
		<RyuAppField label="Media settings differ">
			<small aria-live="polite">
				{mediaMismatchText(project, asset, mismatch)}
			</small>
			<RyuAppActions>
				{matchable ? (
					<Button
						disabled={busy}
						onClick={() =>
							void runtime.routeEdit(
								"match-media",
								{ assetId: asset.id },
								() => `Project matched to “${asset.name}”.`
							)
						}
					>
						Match project to media
					</Button>
				) : null}
				<Button disabled={busy} onClick={dismiss} variant="ghost">
					{matchable ? "Keep project settings" : "Dismiss"}
				</Button>
			</RyuAppActions>
		</RyuAppField>
	);
}
