import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import type { Asset } from "../../shared/project.ts";
import { useBridgeFeatures } from "./ai/AiVideoTools.tsx";
import { describeShotsWithVision } from "./ai/reference-tasks.ts";
import { visionErrorMessage } from "./ai/task-generation.ts";
import { SourceRangeResult } from "./SearchPanel-source-range-result.tsx";
import {
	analyzeShots,
	indexShots,
	type ShotSearchResponse,
	type StudioSearchServices,
	searchShotsLocally,
} from "./search-bridge.ts";

/** "dark blue, not muted": the look a shot search matched. */
function describeLook(
	labels: readonly string[],
	excluded: readonly string[]
): string {
	return [labels.join(" "), ...excluded.map((label) => `not ${label}`)]
		.filter(Boolean)
		.join(", ");
}

/**
 * Visual search: measure per-shot colors, brightness and motion, search them
 * by look ("dark blue motion") without Spaces, and optionally project the
 * shots into the Space so meaning search finds them next to transcripts.
 */
export function VisualShotSearch({
	assets,
	onIndexed,
	onRange,
	onStatus,
	spaceName,
	spaces,
}: {
	assets: Asset[];
	onIndexed: () => Promise<unknown>;
	onRange: (assetId: string, start: number, end: number) => void;
	onStatus: (text: string) => void;
	spaceName: string;
	spaces: (StudioSearchServices & Parameters<typeof indexShots>[0]) | undefined;
}) {
	const videos = assets.filter((asset) => asset.kind === "video");
	const [assetId, setAssetId] = useState("");
	const [query, setQuery] = useState("");
	const [found, setFound] = useState<ShotSearchResponse | null>(null);
	const [working, setWorking] = useState(false);
	const [visionProvider, setVisionProvider] = useState("");
	const [visionModel, setVisionModel] = useState("");
	const features = useBridgeFeatures();
	const tl = useLiteralMessages();
	const complete = window.ryu?.model?.complete;
	const visionReason = complete
		? features?.["model.vision"] === false
			? "This host does not send images to models yet, so shots are searched by their measured look only."
			: undefined
		: "Ryu's model service is unavailable, so shots are searched by their measured look only.";
	const run = async (task: () => Promise<void>, failure: string) => {
		setWorking(true);
		try {
			await task();
		} catch (error) {
			onStatus(error instanceof Error ? error.message : failure);
		} finally {
			setWorking(false);
		}
	};
	const analyze = (refresh: boolean) =>
		run(async () => {
			const index = await analyzeShots(assetId, refresh);
			onStatus(
				tl(
					"{count, plural, one {{countText} shot} other {{countText} shots}} measured. Search them by look below.",
					{
						count: index.shots.length,
						countText: String(index.shots.length),
					}
				)
			);
		}, "Shot analysis failed.");
	const project = () =>
		run(async () => {
			if (!spaces) {
				return;
			}
			await analyzeShots(assetId, false);
			await indexShots(spaces, assetId, spaceName.trim(), false, onStatus);
			await onIndexed();
			onStatus(
				"Shot descriptions stored in your selected Space. Core controls search indexing and access."
			);
		}, "Shot indexing failed.");
	const describe = () =>
		run(async () => {
			if (!complete) {
				return;
			}
			await analyzeShots(assetId, false);
			try {
				const count = await describeShotsWithVision({
					assetId,
					complete,
					model: visionModel.trim() || undefined,
					onProgress: (done, total) =>
						onStatus(
							tl("Describing shots with the vision model · {done} of {total}", {
								done: String(done),
								total: String(total),
							})
						),
					provider: visionProvider.trim() || undefined,
				});
				onStatus(
					tl(
						"{count, plural, one {{countText} shot} other {{countText} shots}} described. Search them by what they show, alongside their look.",
						{ count, countText: String(count) }
					)
				);
			} catch (error) {
				throw new Error(visionErrorMessage(error));
			}
		}, "Shot description failed.");
	const search = () =>
		run(async () => {
			const response = await searchShotsLocally(query.trim());
			setFound(response);
			const excluded = response.excluded ?? [];
			if (
				!(response.labels.length || excluded.length || response.results.length)
			) {
				onStatus(
					"Describe a look with brightness, color, framing or motion words, such as “dark blue motion”."
				);
				return;
			}
			onStatus(
				response.results.length
					? response.labels.length || excluded.length
						? tl(
								"{count, plural, one {{countText} shot} other {{countText} shots}} look like “{look}”.",
								{
									count: response.results.length,
									countText: String(response.results.length),
									look: describeLook(response.labels, excluded),
								}
							)
						: `${response.results.length} described ${response.results.length === 1 ? "shot matches" : "shots match"} “${query.trim()}”.`
					: "No analyzed shots match that look. Analyze more sources or loosen the description."
			);
		}, "Shot search failed.");
	return (
		<RyuAppSection title="Find footage by look">
			<RyuAppField label="Video source">
				<NativeSelect
					aria-label="Video to analyze for shots"
					disabled={working}
					onChange={(event) => setAssetId(event.target.value)}
					value={assetId}
				>
					<NativeSelectOption value="">Choose a video</NativeSelectOption>
					{videos.map((asset) => (
						<NativeSelectOption key={asset.id} value={asset.id}>
							{asset.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<p>
				Shot analysis measures colors, brightness and motion between the scene
				cuts of a completed source analysis. Labels are estimates.
			</p>
			<RyuAppActions>
				<Button
					disabled={!assetId || working}
					onClick={() => void analyze(false)}
					size="sm"
					variant="outline"
				>
					Analyze shots
				</Button>
				<Button
					disabled={!assetId || working}
					onClick={() => void analyze(true)}
					size="sm"
					variant="ghost"
				>
					Re-measure
				</Button>
				<Button
					disabled={!(spaces && assetId && spaceName.trim()) || working}
					onClick={() => void project()}
					size="sm"
					variant="ghost"
				>
					Index shots in Space
				</Button>
			</RyuAppActions>
			<RyuAppField
				description="Sends one 384 px keyframe per shot to the vision model, a few at a time, and stores a caption and tags with each shot. Leave the model empty to use the node default."
				label="Vision model (optional)"
			>
				<div className="flex flex-wrap gap-2">
					<Input
						aria-label="Vision provider"
						className="w-28"
						disabled={working}
						maxLength={64}
						onChange={(event) => setVisionProvider(event.target.value)}
						placeholder="Provider"
						value={visionProvider}
					/>
					<Input
						aria-label="Vision model"
						className="min-w-40 flex-1"
						disabled={working}
						maxLength={256}
						onChange={(event) => setVisionModel(event.target.value)}
						placeholder="A model that reads images"
						value={visionModel}
					/>
				</div>
			</RyuAppField>
			{visionReason && <small>{visionReason}</small>}
			<RyuAppActions>
				<Button
					disabled={!assetId || working || Boolean(visionReason)}
					onClick={() => void describe()}
					size="sm"
					variant="outline"
				>
					Describe shots with AI
				</Button>
			</RyuAppActions>
			<Input
				aria-label="Footage look query"
				disabled={working}
				maxLength={200}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && query.trim() && !working) {
						void search();
					}
				}}
				placeholder="Describe a look, e.g. dark blue motion"
				value={query}
			/>
			<Button
				disabled={!query.trim() || working}
				onClick={() => void search()}
				variant="outline"
			>
				Search by look
			</Button>
			{found && (found.excluded ?? []).length > 0 && (
				<small>
					{tl("Excluding: {terms}", {
						terms: (found.excluded ?? []).join(", "),
					})}
				</small>
			)}
			{found && found.ignored.length > 0 && (
				<small>
					{tl("Not a visual term: {terms}", {
						terms: found.ignored.join(", "),
					})}
				</small>
			)}
			{found?.results.map((match) => {
				const asset = assets.find((item) => item.id === match.assetId);
				return asset ? (
					<SourceRangeResult
						asset={asset}
						colors={match.colors}
						end={match.end}
						key={`${match.assetId}:${match.start}`}
						labels={match.labels}
						onRange={onRange}
						start={match.start}
						text={
							match.caption
								? `${match.caption}${match.tags?.length ? ` · ${match.tags.join(", ")}` : ""}`
								: undefined
						}
					/>
				) : null;
			})}
		</RyuAppSection>
	);
}
