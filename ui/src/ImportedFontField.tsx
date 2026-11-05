import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import {
	Badge,
	Button,
	Input,
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOptGroup,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { type FormEvent, useRef, useState } from "react";
import type { FontChoice } from "../../shared/schema/font.ts";
import { localizedErrorMessage, studioFormat } from "./i18n/format.ts";
import {
	type CatalogFont,
	FONT_FILE_ACCEPT,
	importCatalogFont,
	importFontFile,
	searchCatalogFonts,
	useImportedFonts,
	useSystemFonts,
} from "./imported-fonts.ts";

/** Select values for system families; imported fonts use their UUID. */
const SYSTEM_PREFIX = "system:";

/** The select value for a font choice (an imported font wins). */
export function fontChoiceValue(choice: FontChoice): string {
	if (choice.customFont) {
		return choice.customFont.id;
	}
	return choice.systemFont ? `${SYSTEM_PREFIX}${choice.systemFont}` : "";
}

/**
 * Choose an imported font or an installed system font for a title, caption
 * style or text template, or import a new .ttf/.otf file. The Font stays as
 * the fallback when the chosen font is unavailable.
 */
export function ImportedFontField({
	label,
	onChange,
	value,
}: {
	/** Accessible name prefix, such as "Title 1". */
	label: string;
	/** Receives exactly one font source, or neither for "None". */
	onChange: (choice: FontChoice) => void;
	value: FontChoice;
}) {
	const tl = useLiteralMessages();
	const { error, fonts, refresh } = useImportedFonts();
	const system = useSystemFonts();
	const custom = value.customFont;
	const systemFont = custom ? undefined : value.systemFont;
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const listed = fonts ?? [];
	const missing =
		custom && fonts && !fonts.some((font) => font.id === custom.id)
			? custom
			: undefined;
	const systemMissing =
		systemFont && !system.includes(systemFont) ? systemFont : undefined;
	const [source, setSource] = useState<"library" | "online">("library");
	const importFile = async (file: File) => {
		setBusy(true);
		setStatus(studioFormat("Importing {name}…", { name: file.name }));
		try {
			const font = await importFontFile(file, (progress) =>
				setStatus(
					studioFormat("Importing {name} · {percent}%", {
						name: file.name,
						percent: Math.round(progress * 100),
					})
				)
			);
			await refresh();
			onChange({ customFont: { family: font.family, id: font.id } });
			setStatus(studioFormat("Imported {name}.", { name: font.family }));
		} catch (cause) {
			setStatus(localizedErrorMessage(cause) ?? String(cause));
		} finally {
			setBusy(false);
		}
	};
	const addOnline = async (font: CatalogFont) => {
		setBusy(true);
		setStatus(studioFormat("Adding {name}…", { name: font.family }));
		try {
			const added = await importCatalogFont(font);
			await refresh();
			onChange({ customFont: { family: added.family, id: added.id } });
			setStatus(
				studioFormat("Added {name} ({license}) to the font library.", {
					license: font.license,
					name: added.family,
				})
			);
			setSource("library");
		} catch (cause) {
			setStatus(localizedErrorMessage(cause) ?? String(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<RyuAppField label="Imported or system font">
			<ToggleGroup
				aria-label={tl("{label} Font source", { label })}
				onValueChange={(next: unknown[]) => {
					const value = next[0];
					if (value === "library" || value === "online") {
						setSource(value);
					}
				}}
				size="sm"
				value={[source]}
				variant="outline"
			>
				<ToggleGroupItem value="library">Library</ToggleGroupItem>
				<ToggleGroupItem value="online">Online fonts</ToggleGroupItem>
			</ToggleGroup>
			{source === "online" ? (
				<OnlineFontSearch busy={busy} label={label} onAdd={addOnline} />
			) : null}
			<div className="flex items-center gap-2">
				<NativeSelect
					aria-label={tl("{label} Imported or system font", { label })}
					className="min-w-0 flex-1"
					onChange={(event) => {
						const selected = event.target.value;
						if (selected.startsWith(SYSTEM_PREFIX)) {
							onChange({ systemFont: selected.slice(SYSTEM_PREFIX.length) });
							return;
						}
						const font = listed.find((item) => item.id === selected);
						if (font) {
							onChange({ customFont: { family: font.family, id: font.id } });
						} else if (missing?.id === selected) {
							onChange({ customFont: missing });
						} else {
							onChange({});
						}
					}}
					value={fontChoiceValue(value)}
				>
					<NativeSelectOption value="">None (use Font)</NativeSelectOption>
					{missing ? (
						<NativeSelectOption value={missing.id}>
							{tl("{family} (missing)", { family: missing.family })}
						</NativeSelectOption>
					) : null}
					{listed.map((font) => (
						<NativeSelectOption key={font.id} value={font.id}>
							{font.family}
						</NativeSelectOption>
					))}
					{system.length > 0 || systemMissing ? (
						<NativeSelectOptGroup label="System fonts">
							{systemMissing ? (
								<NativeSelectOption value={`${SYSTEM_PREFIX}${systemMissing}`}>
									{systemMissing}
								</NativeSelectOption>
							) : null}
							{system.map((family) => (
								<NativeSelectOption
									key={family}
									value={`${SYSTEM_PREFIX}${family}`}
								>
									{family}
								</NativeSelectOption>
							))}
						</NativeSelectOptGroup>
					) : null}
				</NativeSelect>
				<Button
					disabled={busy}
					onClick={() => input.current?.click()}
					size="sm"
					type="button"
					variant="outline"
				>
					Import font…
				</Button>
				<input
					accept={FONT_FILE_ACCEPT}
					aria-label={tl("{label} Font file", { label })}
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) {
							importFile(file).catch(() => undefined);
						}
					}}
					ref={input}
					type="file"
				/>
			</div>
			{status ? <small role="status">{status}</small> : null}
			{error && !status ? <small>{error}</small> : null}
			{missing ? (
				<small>
					This font is no longer in the library; the Font is used instead.
				</small>
			) : null}
		</RyuAppField>
	);
}

/**
 * The Online fonts tab: search Fontsource's open-licensed fonts (OFL, Apache
 * or UFL) and add one to the font library. The sidecar downloads the file;
 * a search or download that fails says why.
 */
function OnlineFontSearch({
	busy,
	label,
	onAdd,
}: {
	busy: boolean;
	label: string;
	onAdd: (font: CatalogFont) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<CatalogFont[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const search = async (event: FormEvent) => {
		event.preventDefault();
		setSearching(true);
		setError(null);
		try {
			setResults(await searchCatalogFonts(query));
		} catch (cause) {
			setResults(null);
			setError(localizedErrorMessage(cause) ?? String(cause));
		} finally {
			setSearching(false);
		}
	};
	return (
		<div className="space-y-2" data-online-fonts="">
			<form className="flex items-center gap-2" onSubmit={search}>
				<Input
					aria-label={tl("{label} Search online fonts", { label })}
					className="min-w-0 flex-1"
					maxLength={80}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search online fonts"
					type="search"
					value={query}
				/>
				<Button disabled={searching} size="sm" type="submit" variant="outline">
					Search
				</Button>
			</form>
			<small className="block text-muted-foreground">
				Open-licensed fonts from Fontsource. Each added font keeps its license
				in the project credits.
			</small>
			{error ? <small role="alert">{error}</small> : null}
			{results && results.length === 0 ? <small>No fonts match.</small> : null}
			{results?.length ? (
				<ul className="max-h-48 space-y-1 overflow-y-auto">
					{results.map((font) => (
						<li className="flex items-center gap-2" key={font.id}>
							<span className="min-w-0 flex-1 truncate">{font.family}</span>
							<Badge variant="outline">{font.license}</Badge>
							<Button
								aria-label={tl("Add {family}", { family: font.family })}
								disabled={busy}
								onClick={() => {
									onAdd(font).catch(() => undefined);
								}}
								size="sm"
								type="button"
								variant="outline"
							>
								Add
							</Button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
