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
import { useEffect, useState } from "react";
import type { Asset } from "../../shared/project.ts";
import {
	type FootageMatch,
	type IndexedSource,
	indexSource,
	readSearchIndexes,
	searchFootage,
} from "./search-bridge.ts";

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
	const [query, setQuery] = useState("");
	const [matches, setMatches] = useState<FootageMatch[]>([]);
	const [working, setWorking] = useState(false);
	const candidate = window.ryu?.spaces;
	const spaces =
		candidate &&
		[
			candidate.ensureSpace,
			candidate.createDoc,
			candidate.getDoc,
			candidate.updateDoc,
			candidate.deleteDoc,
			candidate.search,
		].every((method) => typeof method === "function")
			? candidate
			: undefined;
	const refresh = async () => {
		const current = await readSearchIndexes();
		setIndexes(current);
		setSpaceId((previous) => previous || current[0]?.spaceId || "");
		return current;
	};
	useEffect(() => {
		void readSearchIndexes()
			.then((current) => {
				setIndexes(current);
				setSpaceId(current[0]?.spaceId ?? "");
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
			const current = await refresh();
			const results = await searchFootage(
				spaces,
				current,
				spaceId,
				query.trim()
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
		...new Map(indexes.map((item) => [item.spaceId, item.spaceName])).entries(),
	];
	return (
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
					<NativeSelectOption value="">Choose source media</NativeSelectOption>
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
			{indexes.some((item) => !item.current) && (
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
					<div className="studio-scene" key={match.docId}>
						<strong>{asset.name}</strong>
						<small>
							{match.start.toFixed(1)}–{match.end.toFixed(1)}s
						</small>
						<p>{match.text}</p>
						<Button
							onClick={() => onRange(asset.id, match.start, match.end)}
							size="sm"
							variant="outline"
						>
							Add source range
						</Button>
					</div>
				) : null;
			})}
		</RyuAppSection>
	);
}
