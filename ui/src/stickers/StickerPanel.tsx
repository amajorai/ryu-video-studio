import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useDeferredValue, useMemo, useState } from "react";
import {
	STICKER_SOURCE_ORDER,
	STICKER_SOURCES,
	type StickerCategory,
	type StickerEntry,
	searchStickers,
} from "../../../shared/stickers/catalog.ts";
import {
	STICKER_ANIMATION_LABELS,
	STICKER_ANIMATION_PRESETS,
	type StickerAnimationPreset,
} from "../../../shared/stickers/place.ts";
import { useEditorProject } from "../editor/context.tsx";
import { addSticker, type StickerDependencies } from "./add-sticker.ts";
import { stickerUrl } from "./sticker-urls.ts";

/** Most stickers drawn at once; refine the search to see the rest. */
export const STICKER_GRID_LIMIT = 120;

const CATEGORY_OPTIONS: readonly {
	label: string;
	value: StickerCategory | "all";
}[] = [
	{ label: "All stickers", value: "all" },
	{ label: "Emoji", value: "emoji" },
	{ label: "Flags", value: "flags" },
	{ label: "Shapes", value: "shapes" },
];

const isCategory = (value: string): value is StickerCategory | "all" =>
	CATEGORY_OPTIONS.some((option) => option.value === value);

const isPreset = (value: string): value is StickerAnimationPreset =>
	(STICKER_ANIMATION_PRESETS as readonly string[]).includes(value);

function StickerButton({
	disabled,
	entry,
	onPick,
}: {
	disabled: boolean;
	entry: StickerEntry;
	onPick: (entry: StickerEntry) => void;
}) {
	const tl = useLiteralMessages();
	const url = stickerUrl(entry);
	return (
		<button
			aria-label={tl("Add sticker {name}", { name: entry.name })}
			className="flex aspect-square items-center justify-center rounded-md border border-transparent p-1 hover:border-border hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
			data-slot="sticker-tile"
			disabled={disabled}
			onClick={() => onPick(entry)}
			title={entry.name}
			type="button"
		>
			{url ? (
				<img
					alt=""
					className="max-h-full max-w-full object-contain"
					decoding="async"
					height={40}
					loading="lazy"
					src={url}
					width={40}
				/>
			) : (
				<span className="line-clamp-2 text-center text-[10px] leading-tight">
					{entry.name}
				</span>
			)}
		</button>
	);
}

/**
 * Bundled sticker library: search emoji, flags, and shapes by name or
 * keyword; choosing one rasterizes it to a PNG, imports it with its license
 * credit, and places it at the playhead on the first free track.
 */
export function StickerPanel({
	dependencies,
}: {
	/** Rasterize/import overrides (tests). */
	dependencies?: StickerDependencies;
} = {}) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<StickerCategory | "all">("all");
	const [preset, setPreset] = useState<StickerAnimationPreset>("pop");
	const deferredQuery = useDeferredValue(query);
	const matches = useMemo(
		() => searchStickers(deferredQuery, { category }),
		[deferredQuery, category]
	);
	const shown = matches.slice(0, STICKER_GRID_LIMIT);
	const pick = (entry: StickerEntry) =>
		addSticker(runtime, entry, preset, dependencies);

	return (
		<RyuAppSection title="Stickers">
			<RyuAppField label="Search">
				<Input
					aria-label="Search stickers"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Heart, star, flag of Japan…"
					type="search"
					value={query}
				/>
			</RyuAppField>
			<div className="studio-inline-fields">
				<RyuAppField label="Set">
					<NativeSelect
						aria-label="Sticker set"
						onChange={(event) => {
							if (isCategory(event.target.value)) {
								setCategory(event.target.value);
							}
						}}
						value={category}
					>
						{CATEGORY_OPTIONS.map((option) => (
							<NativeSelectOption key={option.value} value={option.value}>
								{option.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
				<RyuAppField label="Animation">
					<NativeSelect
						aria-label="Sticker animation"
						onChange={(event) => {
							if (isPreset(event.target.value)) {
								setPreset(event.target.value);
							}
						}}
						value={preset}
					>
						{STICKER_ANIMATION_PRESETS.map((value) => (
							<NativeSelectOption key={value} value={value}>
								{STICKER_ANIMATION_LABELS[value]}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
			</div>
			{shown.length > 0 ? (
				<ul
					aria-label="Stickers"
					className="grid list-none grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1 p-0"
				>
					{shown.map((entry) => (
						<li key={entry.id}>
							<StickerButton
								disabled={runtime.busy}
								entry={entry}
								onPick={pick}
							/>
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground text-xs">
					{tl("No stickers match “{query}”.", { query: query.trim() })}
				</p>
			)}
			{matches.length > shown.length && (
				<p className="text-muted-foreground text-xs">
					{tl("Showing {shown} of {total}. Refine the search to see more.", {
						shown: String(shown.length),
						total: String(matches.length),
					})}
				</p>
			)}
			<footer className="flex flex-col gap-1 text-muted-foreground text-xs">
				<span>
					Stickers are placed at the playhead on the first free track. Credits
					for published videos:
				</span>
				<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
					{STICKER_SOURCE_ORDER.map((source) => {
						const info = STICKER_SOURCES[source];
						return (
							<li key={source}>
								{info.attribution}{" "}
								{info.licenseUrl && (
									<a
										className="underline"
										href={info.licenseUrl}
										rel="noopener noreferrer"
										target="_blank"
									>
										{tl("{licenseName} license", {
											licenseName: info.licenseName,
										})}
									</a>
								)}
							</li>
						);
					})}
				</ul>
			</footer>
		</RyuAppSection>
	);
}
