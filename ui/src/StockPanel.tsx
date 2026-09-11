import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import { assetSchema } from "../../shared/project.ts";
import {
	type StockProvider,
	type StockSearchResult,
	stockProviderSchema,
	stockSearchResponseSchema,
} from "../../shared/stock.ts";
import { request } from "./bridge.ts";

export function StockPanel({
	onAsset,
	onStatus,
}: {
	onAsset: (asset: ReturnType<typeof assetSchema.parse>) => void;
	onStatus: (message: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<StockSearchResult[]>([]);
	const [provider, setProvider] = useState<StockProvider>("archive.org");
	const [searching, setSearching] = useState(false);
	const [importing, setImporting] = useState<string | null>(null);
	const providerLabel = (value: StockProvider) =>
		value === "archive.org"
			? "Archive.org"
			: value === "coverr"
				? "Coverr (node-configured)"
				: value === "openverse.audio"
					? "Openverse audio"
					: value === "openverse.image"
						? "Openverse images"
						: value === "unsplash.image"
							? "Unsplash images (node-configured)"
							: value === "wikimedia.commons"
								? "Wikimedia Commons"
								: value === "nasa"
									? "NASA Images and Video"
									: value === "pexels"
										? "Pexels"
										: "Pixabay";
	const search = async () => {
		setSearching(true);
		try {
			const value = await request<unknown>(
				`/stock/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query.trim())}&limit=8`
			);
			const result = stockSearchResponseSchema.parse(value);
			setResults(result.results);
			if (!result.results.length) {
				onStatus(`No ${providerLabel(provider)} results matched that search.`);
			}
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "Stock search failed.");
		} finally {
			setSearching(false);
		}
	};
	const importResult = async (result: StockSearchResult) => {
		setImporting(result.identifier);
		try {
			const asset = assetSchema.parse(
				await request("/stock", "POST", {
					identifier: result.identifier,
					provider: result.provider,
				})
			);
			onAsset(asset);
			onStatus(
				`Imported ${asset.name}. Review the source rights before publishing.`
			);
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "Stock import failed.");
		} finally {
			setImporting(null);
		}
	};
	return (
		<div className="space-y-3">
			<p className="text-muted-foreground">
				Search open media catalogs. Results stay attributed to their source;
				review rights before publishing.
			</p>
			<NativeSelect
				aria-label="Open media provider"
				onChange={(event) => {
					const next = stockProviderSchema.parse(event.target.value);
					setProvider(next);
					setResults([]);
				}}
				value={provider}
			>
				<NativeSelectOption value="archive.org">Archive.org</NativeSelectOption>
				<NativeSelectOption value="coverr">
					Coverr (node-configured)
				</NativeSelectOption>
				<NativeSelectOption value="openverse.audio">
					Openverse audio
				</NativeSelectOption>
				<NativeSelectOption value="openverse.image">
					Openverse images
				</NativeSelectOption>
				<NativeSelectOption value="unsplash.image">
					Unsplash images (node-configured)
				</NativeSelectOption>
				<NativeSelectOption value="wikimedia.commons">
					Wikimedia Commons
				</NativeSelectOption>
				<NativeSelectOption value="nasa">
					NASA Images and Video
				</NativeSelectOption>
				<NativeSelectOption value="pexels">
					Pexels (node-configured)
				</NativeSelectOption>
				<NativeSelectOption value="pixabay">
					Pixabay (node-configured)
				</NativeSelectOption>
			</NativeSelect>
			<div className="flex gap-2">
				<Input
					aria-label="Search open media"
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							void search();
						}
					}}
					placeholder="e.g. big buck bunny, city streets"
					value={query}
				/>
				<Button
					disabled={searching || !query.trim()}
					onClick={() => void search()}
				>
					{searching ? "Searching…" : "Search"}
				</Button>
			</div>
			{results.map((result) => (
				<div className="studio-scene" key={result.identifier}>
					<strong>{result.title}</strong>
					<small>
						{result.format}
						{result.duration ? ` · ${Math.round(result.duration)}s` : ""}
						{result.sizeBytes
							? ` · ${(result.sizeBytes / 1e6).toFixed(1)} MB`
							: ""}
					</small>
					<p>{result.attribution}</p>
					<small>{result.rights}</small>
					<Button
						disabled={importing !== null}
						onClick={() => void importResult(result)}
						size="sm"
						variant="outline"
					>
						{importing === result.identifier
							? "Importing…"
							: "Import to library"}
					</Button>
				</div>
			))}
		</div>
	);
}
