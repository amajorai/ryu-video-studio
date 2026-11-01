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
import { useEffect, useState } from "react";
import { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import { SourceRangeResult } from "./SearchPanel-source-range-result.tsx";
import { VisualShotSearch } from "./SearchPanel-visual-shot-search.tsx";
import {
	type FootageMatch,
	type IndexedShots,
	type IndexedSource,
	indexSource,
	readSearchIndexes,
	readShotIndexes,
	searchFootage,
} from "./search-bridge.ts";

export { VisualShotSearch } from "./SearchPanel-visual-shot-search.tsx";

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
	const tl = useLiteralMessages();
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
					? tl(
							"{count, plural, one {{countText} source range} other {{countText} source ranges}} found.",
							{ count: results.length, countText: String(results.length) }
						)
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
