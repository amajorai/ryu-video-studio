import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import type { Asset } from "../../shared/project.ts";
import { soundtrackMoodSchema } from "../../shared/soundtrack.ts";
import { request } from "./bridge.ts";

export function SoundtrackPanel({
	onAsset,
	onStatus,
}: {
	onAsset: (asset: Asset) => void;
	onStatus: (message: string) => void;
}) {
	const [duration, setDuration] = useState(15);
	const [bpm, setBpm] = useState(96);
	const [mood, setMood] = useState<"warm" | "bright" | "tense">("warm");
	const [working, setWorking] = useState(false);
	const generate = async () => {
		if (working) {
			return;
		}
		setWorking(true);
		onStatus("Creating a local soundtrack on the node…");
		try {
			const asset = await request<Asset>("/soundtrack", "POST", {
				bpm,
				duration,
				mood: soundtrackMoodSchema.parse(mood),
			});
			onAsset(asset);
			onStatus("Local soundtrack saved to the media library.");
		} catch (error) {
			onStatus(
				error instanceof Error ? error.message : "Soundtrack generation failed."
			);
		} finally {
			setWorking(false);
		}
	};
	return (
		<RyuAppSection title="Local soundtrack">
			<p className="text-muted-foreground">
				Create a bounded offline score and add it to the timeline or a
				production recipe. This does not call a cloud provider.
			</p>
			<RyuAppField label="Duration (seconds)">
				<Input
					aria-label="Soundtrack duration"
					disabled={working}
					max={7200}
					min={0.5}
					onChange={(event) => setDuration(Number(event.target.value))}
					step={0.5}
					type="number"
					value={duration}
				/>
			</RyuAppField>
			<RyuAppField label="Tempo (BPM)">
				<Input
					aria-label="Soundtrack tempo"
					disabled={working}
					max={180}
					min={60}
					onChange={(event) => setBpm(Number(event.target.value))}
					step={1}
					type="number"
					value={bpm}
				/>
			</RyuAppField>
			<RyuAppField label="Mood">
				<NativeSelect
					aria-label="Soundtrack mood"
					disabled={working}
					onChange={(event) => setMood(event.target.value as typeof mood)}
					value={mood}
				>
					<NativeSelectOption value="warm">Warm</NativeSelectOption>
					<NativeSelectOption value="bright">Bright</NativeSelectOption>
					<NativeSelectOption value="tense">Tense</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={working}
					onClick={() => void generate()}
					variant="outline"
				>
					{working ? "Generating…" : "Create soundtrack"}
				</Button>
			</RyuAppActions>
		</RyuAppSection>
	);
}
