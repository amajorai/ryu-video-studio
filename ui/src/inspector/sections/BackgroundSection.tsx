import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useContext } from "react";
import {
	BASE_TRACK,
	type BackgroundType,
	backgroundImageCandidates,
} from "../../../../shared/background.ts";
import { EditorContext } from "../../editor/context.tsx";
import { BackgroundFields } from "../../panels/BackgroundFields.tsx";
import type { ClipSectionProps } from "../section-props.ts";

/** Clip-level fills the render draws; an image covers the clip box. */
const clipBackgroundTypes: readonly BackgroundType[] = [
	"color",
	"gradient",
	"blur",
	"image",
];

/**
 * Per-clip background fill (W2-V8), drawn under the clip only while it plays.
 * "Project" clears the field, so the clip falls back to the canvas (and to
 * the project blur fill on the base track, unless the clip is keyed or
 * masked). Waveform clips get no fill, so audio clips show no section.
 * Agents set or clear the same field through the background route with
 * `clipId`.
 */
export function BackgroundSection({
	isAudio,
	onChange,
	segment,
	visualControls,
}: ClipSectionProps) {
	// Library pictures for an image fill (none outside the editor).
	const assets = useContext(EditorContext)?.assets ?? [];
	const tl = useLiteralMessages();
	if (!visualControls || isAudio) {
		return null;
	}
	const projectBlur =
		segment.track === BASE_TRACK &&
		!segment.key &&
		(segment.masks?.length ?? 0) === 0;
	return (
		<RyuAppField
			description={
				segment.background
					? "Fills the frame behind this clip while it plays."
					: projectBlur
						? tl("Uses the project canvas (including a project blur fill).")
						: tl("Uses the project canvas.")
			}
			label="Clip background"
		>
			<BackgroundFields
				fallbackColor="#000000"
				imageAssets={backgroundImageCandidates(assets).filter(
					(asset) => asset.id !== segment.assetId
				)}
				label="Clip"
				noneLabel="Project"
				onChange={(background) => onChange({ background })}
				types={clipBackgroundTypes}
				value={segment.background}
			/>
		</RyuAppField>
	);
}
