import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
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

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** Sentence describing how the first clip differs from the project. */
export function mediaMismatchText(
	project: Pick<Project, "fps" | "height" | "width">,
	asset: Pick<Asset, "height" | "name" | "width">,
	mismatch: MediaSettingsMismatch,
	tl: LiteralMessage = englishMessages
): string {
	const shared = {
		assetName: asset.name,
		mediaSize: size(asset.width, asset.height),
		projectFps: String(project.fps),
		projectSize: size(project.width, project.height),
	};
	const media =
		mismatch.mediaFrameRate === undefined
			? tl(
					"“{assetName}” is {mediaSize}; the project is {projectSize} at {projectFps} fps.",
					shared
				)
			: tl(
					"“{assetName}” is {mediaSize} at {mediaFps} fps; the project is {projectSize} at {projectFps} fps.",
					{ ...shared, mediaFps: String(mismatch.mediaFrameRate) }
				);
	const unsupportedFps = String(mismatch.unsupportedFps);
	const canvas = mismatch.canvas
		? size(mismatch.canvas.width, mismatch.canvas.height)
		: undefined;
	const fps = mismatch.fps === undefined ? undefined : String(mismatch.fps);
	if (canvas === undefined && fps === undefined) {
		return tl(
			"{media} Its {unsupportedFps} fps rate cannot be exported yet, so the project keeps its settings.",
			{ media, unsupportedFps }
		);
	}
	let matching: string;
	if (canvas !== undefined && fps !== undefined) {
		matching = tl(
			"Matching sets the canvas to {canvasSize} and the rate to {fps} fps.",
			{ canvasSize: canvas, fps }
		);
	} else if (canvas === undefined) {
		matching = tl("Matching sets the rate to {fps} fps.", { fps });
	} else {
		matching = tl("Matching sets the canvas to {canvasSize}.", {
			canvasSize: canvas,
		});
	}
	return mismatch.unsupportedFps === undefined
		? `${media} ${matching}`
		: `${media} ${matching} ${tl("Its {unsupportedFps} fps rate cannot be exported yet.", { unsupportedFps })}`;
}

/**
 * "Match project to media": offered while the timeline holds only its first
 * clip and that clip's media differs from the project canvas or frame rate.
 * Matching saves through the revision-checked `match-media` route, so it is
 * one undo step; declining is remembered per viewer for that project and
 * asset.
 */
export function MediaMismatchPrompt() {
	const tl = useLiteralMessages();
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
				{mediaMismatchText(project, asset, mismatch, tl)}
			</small>
			<RyuAppActions>
				{matchable ? (
					<Button
						disabled={busy}
						onClick={() =>
							void runtime.routeEdit("match-media", { assetId: asset.id }, () =>
								tl("Project matched to “{assetName}”.", {
									assetName: asset.name,
								})
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
