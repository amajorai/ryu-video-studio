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
import { type DragEvent, useEffect, useState } from "react";
import { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import type { ShotColor } from "../../shared/shot-index.ts";
import { useBridgeFeatures } from "./ai/AiVideoTools.tsx";
import { describeShotsWithVision } from "./ai/reference-tasks.ts";
import { visionErrorMessage } from "./ai/task-generation.ts";
import {
	clearActiveAssetDrag,
	setActiveAssetDrag,
} from "./library/drag-source.ts";
import {
	analyzeShots,
	type FootageMatch,
	type IndexedShots,
	type IndexedSource,
	indexShots,
	indexSource,
	readSearchIndexes,
	readShotIndexes,
	type ShotSearchResponse,
	type StudioSearchServices,
	searchFootage,
	searchShotsLocally,
	writeAssetDrag,
} from "./search-bridge.ts";

const studioSpacesCapabilitySchema = z.object({
	ensureSpace: z.function(),
	createDoc: z.function(),
	getDoc: z.function(),
	updateDoc: z.function(),
	deleteDoc: z.function(),
	search: z.function(),
});

export function SearchPanel({
	assets,
	onRange,
	onStatus,
}: {
	assets: Asset[];
	onRange: (assetId: string, start: number, end: number) => void;
	onStatus: (text: string) => void;
}) {
	const [assetId, setAssetId] = useState("");
	const [spaceName, setSpaceName] = useState("Video Studio");
	const [spaceId, setSpaceId] = useState("");
	const [indexes, setIndexes] = useState<IndexedSource[]>([]);
	const [shotIndexes, setShotIndexes] = useState<IndexedShots[]>([]);
	const [query, setQuery] = useState("");
	const [matches, setMatches] = useState<FootageMatch[]>([]);
	const [working, setWorking] = useState(false);
	const candidate = window.ryu?.spaces;
	const spaces = studioSpacesCapabilitySchema.safeParse(candidate).success
		? candidate
		: undefined;
	const refresh = async () => {
		const [current, shots] = await Promise.all([
			readSearchIndexes(),
			readShotIndexes(),
		]);
		setIndexes(current);
		setShotIndexes(shots);
		setSpaceId(
			(previous) => previous || current[0]?.spaceId || shots[0]?.spaceId || ""
		);
		return { current, shots };
	};
	useEffect(() => {
		void Promise.all([readSearchIndexes(), readShotIndexes()])
			.then(([current, shots]) => {
				setIndexes(current);
				setShotIndexes(shots);
				setSpaceId(current[0]?.spaceId ?? shots[0]?.spaceId ?? "");
			})
			.catch((error) =>
				onStatus(error instanceof Error ? error.message : "Index unavailable.")
			);
	}, [onStatus]);
	const index = async (rebuild: boolean) => {
		if (!spaces) {
			return;
		}
		setWorking(true);
		try {
			await indexSource(spaces, assetId, spaceName.trim(), rebuild, onStatus);
			await refresh();
			onStatus(
				"Transcript stored in your selected Space. Core controls search indexing and access."
			);
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "Indexing failed.");
		} finally {
			setWorking(false);
		}
	};
	const search = async () => {
		if (!spaces) {
			return;
		}
		setWorking(true);
		setMatches([]);
		try {
			const { current, shots } = await refresh();
			const results = await searchFootage(
				spaces,
				current,
				spaceId,
				query.trim(),
				shots
			);
			setMatches(results);
			onStatus(
				results.length
					? `${results.length} source ${results.length === 1 ? "range" : "ranges"} found.`
					: "No current indexed ranges matched. Core may still be indexing newly saved documents."
			);
		} catch (error) {
			onStatus(
				error instanceof Error ? error.message : "Space search is unavailable."
			);
		} finally {
			setWorking(false);
		}
	};
	const choices = [
		...new Map(
			[...indexes, ...shotIndexes].map((item) => [item.spaceId, item.spaceName])
		).entries(),
	];
	return (
		<>
			<RyuAppSection title="Find footage by meaning">
				{!spaces && (
					<p>
						Open in a Ryu host with Spaces access to index and search source
						transcripts.
					</p>
				)}
				<RyuAppField label="Source transcript">
					<NativeSelect
						aria-label="Source to index"
						disabled={working}
						onChange={(event) => setAssetId(event.target.value)}
						value={assetId}
					>
						<NativeSelectOption value="">
							Choose source media
						</NativeSelectOption>
						{assets
							.filter((asset) => asset.kind !== "image")
							.map((asset) => (
								<NativeSelectOption key={asset.id} value={asset.id}>
									{asset.name}
								</NativeSelectOption>
							))}
					</NativeSelect>
				</RyuAppField>
				<RyuAppField label="Space name">
					<Input
						aria-label="Transcript index Space"
						disabled={working}
						maxLength={200}
						onChange={(event) => setSpaceName(event.target.value)}
						value={spaceName}
					/>
				</RyuAppField>
				<p>
					Indexing copies the selected source transcript into this Space. Its
					access settings apply. Media files stay in Video Studio.
				</p>
				<RyuAppActions>
					<Button
						disabled={!(spaces && assetId && spaceName.trim()) || working}
						onClick={() => void index(false)}
						size="sm"
						variant="outline"
					>
						Index transcript
					</Button>
					<Button
						disabled={!(spaces && assetId && spaceName.trim()) || working}
						onClick={() => void index(true)}
						size="sm"
						variant="ghost"
					>
						Rebuild index
					</Button>
				</RyuAppActions>
				{[...indexes, ...shotIndexes].some((item) => !item.current) && (
					<p>
						Some indexes are out of date. Reindex changed transcripts before
						searching them.
					</p>
				)}
				<RyuAppField label="Search Space">
					<NativeSelect
						aria-label="Footage search Space"
						disabled={working}
						onChange={(event) => setSpaceId(event.target.value)}
						value={spaceId}
					>
						<NativeSelectOption value="">
							Choose an indexed Space
						</NativeSelectOption>
						{choices.map(([id, name]) => (
							<NativeSelectOption key={id} value={id}>
								{name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
				<Input
					aria-label="Footage meaning query"
					disabled={working}
					maxLength={2000}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Describe the moment you need…"
					value={query}
				/>
				<Button
					disabled={!(spaces && spaceId && query.trim()) || working}
					onClick={() => void search()}
					variant="outline"
				>
					Search footage
				</Button>
				{matches.map((match) => {
					const asset = assets.find((item) => item.id === match.assetId);
					return asset ? (
						<SourceRangeResult
							asset={asset}
							end={match.end}
							key={match.docId}
							labels={match.labels}
							onRange={onRange}
							start={match.start}
							text={match.kind === "transcript" ? match.text : undefined}
						/>
					) : null;
				})}
			</RyuAppSection>
			<VisualShotSearch
				assets={assets}
				onIndexed={refresh}
				onRange={onRange}
				onStatus={onStatus}
				spaceName={spaceName}
				spaces={spaces}
			/>
		</>
	);
}

function dragRange(
	event: DragEvent<HTMLElement>,
	asset: Asset,
	start: number,
	end: number
) {
	const payload = { assetId: asset.id, sourceIn: start, sourceOut: end };
	writeAssetDrag(event.dataTransfer, payload);
	// The timeline drop preview reads the in-flight drag during dragover.
	setActiveAssetDrag({ asset, payload });
}

/** "dark blue, not muted": the look a shot search matched. */
function describeLook(
	labels: readonly string[],
	excluded: readonly string[]
): string {
	return [labels.join(" "), ...excluded.map((label) => `not ${label}`)]
		.filter(Boolean)
		.join(", ");
}

/** One found source range; drag it to the timeline or add it at the end. */
function SourceRangeResult({
	asset,
	colors = [],
	end,
	labels,
	onRange,
	start,
	text,
}: {
	asset: Asset;
	colors?: ShotColor[];
	end: number;
	labels: string[];
	onRange: (assetId: string, start: number, end: number) => void;
	start: number;
	text?: string;
}) {
	return (
		<div
			aria-label={`${asset.name} ${start.toFixed(1)} to ${end.toFixed(1)} seconds`}
			className="studio-scene cursor-grab"
			draggable
			onDragEnd={clearActiveAssetDrag}
			onDragStart={(event) => dragRange(event, asset, start, end)}
			role="group"
		>
			<strong>{asset.name}</strong>
			<small>
				{start.toFixed(1)}–{end.toFixed(1)}s
			</small>
			{colors.length > 0 && (
				<div className="flex items-center gap-1">
					{colors.map((color) => (
						<span
							className="inline-block size-3 rounded-sm border border-border"
							key={color.hex}
							style={{ backgroundColor: color.hex }}
							title={`${color.name} ${Math.round(color.weight * 100)}%`}
						/>
					))}
				</div>
			)}
			{labels.length > 0 && <small>{labels.join(" · ")}</small>}
			{text && <p>{text}</p>}
			<Button
				onClick={() => onRange(asset.id, start, end)}
				size="sm"
				variant="outline"
			>
				Add source range
			</Button>
		</div>
	);
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
				`${index.shots.length} ${index.shots.length === 1 ? "shot" : "shots"} measured. Search them by look below.`
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
							`Describing shots with the vision model · ${done} of ${total}`
						),
					provider: visionProvider.trim() || undefined,
				});
				onStatus(
					`${count} ${count === 1 ? "shot" : "shots"} described. Search them by what they show, alongside their look.`
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
						? `${response.results.length} ${response.results.length === 1 ? "shot" : "shots"} look like “${describeLook(response.labels, excluded)}”.`
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
				<small>Excluding: {(found.excluded ?? []).join(", ")}</small>
			)}
			{found && found.ignored.length > 0 && (
				<small>Not a visual term: {found.ignored.join(", ")}</small>
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
