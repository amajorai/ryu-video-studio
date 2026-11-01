import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEditorProject } from "../editor/context.tsx";
import { ChunkingForm } from "./CaptionStylePanel-chunking-form.tsx";
import { EmojiSuggestions } from "./CaptionStylePanel-emoji.tsx";
import { PresetGallery } from "./CaptionStylePanel-fields.tsx";
import { CaptionImport } from "./CaptionStylePanel-import.tsx";
import { storedStyle, styleTargetTrackId } from "./CaptionStylePanel-model.ts";
import { StyleForm } from "./CaptionStylePanel-style-form.tsx";
import type { PanelTab } from "./types.ts";

export {
	importSummary,
	numberFieldText,
	parseNumberField,
	parseProfanityList,
	rechunkBody,
	storedStyle,
	styleTargetTrackId,
} from "./CaptionStylePanel-model.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Captions), under the caption list.
 */
export const captionStylePanelTab: PanelTab | null = null;

/** Caption style, chunking, emoji, and caption import options. */
export function CaptionStylePanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { project } = runtime;
	const trackId = styleTargetTrackId(project);
	const target = trackId
		? project.captionTracks.find((track) => track.id === trackId)?.label
		: undefined;
	const selected = storedStyle(project)?.presetId;
	// Re-mount the forms when the stored values change on the server.
	const formKey = `${project.id}:${trackId ?? "source"}:${JSON.stringify(storedStyle(project) ?? {})}`;
	return (
		<>
			<RyuAppSection title="Caption style">
				<p className="text-muted-foreground text-xs">
					{target
						? tl("Styling the {target} track.", { target })
						: tl("Styling the source captions.")}
				</p>
				<PresetGallery
					disabled={runtime.busy}
					onApply={(preset) =>
						void runtime.routeEdit(
							"caption-style",
							{ mode: "replace", style: preset.style, trackId },
							() => `Applied the ${preset.label} caption style.`
						)
					}
					selected={selected}
				/>
				<StyleForm key={formKey} runtime={runtime} />
			</RyuAppSection>
			<RyuAppSection title="Caption timing">
				<ChunkingForm
					key={`${project.id}:${JSON.stringify(project.captionChunking ?? {})}`}
					runtime={runtime}
				/>
				<EmojiSuggestions runtime={runtime} />
			</RyuAppSection>
			<RyuAppSection title="Import captions">
				<CaptionImport runtime={runtime} />
			</RyuAppSection>
		</>
	);
}
