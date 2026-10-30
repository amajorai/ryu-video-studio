import { Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type SoundtrackLayer,
	type SoundtrackMood,
	type SoundtrackSection,
	soundtrackLayerSchema,
} from "../../shared/soundtrack.ts";
import {
	formatSeconds,
	toggleLayer,
} from "./SoundtrackPanel-soundtrack-requests.ts";

const LAYER_LABELS = {
	pluck: "Pluck",
	pad: "Pad",
	bass: "Bass",
	arpeggio: "Arpeggio",
	kick: "Kick",
	hat: "Hi-hat",
	snare: "Snare",
} as const satisfies Record<SoundtrackLayer, string>;

/** The instrument layer toggles and the planned section list. */
export function SoundtrackLayerFields({
	activeLayers,
	busy,
	layers,
	mood,
	sections,
	setLayers,
}: {
	activeLayers: SoundtrackLayer[];
	busy: boolean;
	layers: SoundtrackLayer[] | undefined;
	mood: SoundtrackMood;
	sections: SoundtrackSection[];
	setLayers: (layers: SoundtrackLayer[] | undefined) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<fieldset className="flex flex-wrap gap-3" disabled={busy}>
				<legend className="mb-1 text-muted-foreground text-xs">
					Instrument layers
				</legend>
				{soundtrackLayerSchema.options.map((layer) => (
					<label className="flex items-center gap-1.5 text-sm" key={layer}>
						<Checkbox
							aria-label={tl("{layer} layer", { layer: LAYER_LABELS[layer] })}
							checked={activeLayers.includes(layer)}
							onCheckedChange={(checked) =>
								setLayers(toggleLayer(mood, layers, layer, checked === true))
							}
						/>
						{LAYER_LABELS[layer]}
					</label>
				))}
			</fieldset>
			{sections.length > 0 && (
				<div>
					<p className="text-muted-foreground text-xs">
						Planned sections (quieter sections drop drums and arpeggio)
					</p>
					<ol aria-label="Planned soundtrack sections" className="text-sm">
						{sections.map((section) => (
							<li key={`${section.start}-${section.end}`}>
								{tl("{start} – {end} · intensity {intensity}%", {
									end: formatSeconds(section.end),
									intensity: Math.round(section.intensity * 100),
									start: formatSeconds(section.start),
								})}
							</li>
						))}
					</ol>
				</div>
			)}
		</>
	);
}
