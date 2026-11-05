import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOptGroup,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import {
	catalogHasVoices,
	choiceFromOption,
	choiceLanguages,
	languageLabel,
	type TtsVoiceCatalog,
	type TtsVoiceChoice,
	ttsVoiceCatalog,
	voiceOptionValue,
} from "../../../shared/tts-voices.ts";

/** The host's engine listing, when Video Studio runs inside Ryu. */
export function hostTtsEngines(): (() => Promise<unknown>) | undefined {
	const list = window.ryu?.media?.ttsEngines;
	return list ? () => list() : undefined;
}

/**
 * Load the host's voice catalog once. `undefined` while loading, and an
 * empty catalog when the host lists nothing or the listing fails.
 */
export function useTtsVoiceCatalog(
	listEngines: (() => Promise<unknown>) | undefined = hostTtsEngines()
): TtsVoiceCatalog | undefined {
	// The listing is read once per mount; a new function identity on each
	// render must not refetch it.
	const [lister] = useState(() => listEngines);
	const [catalog, setCatalog] = useState<TtsVoiceCatalog | undefined>(() =>
		lister ? undefined : { engines: [], groups: [] }
	);
	useEffect(() => {
		if (!lister) {
			return;
		}
		let live = true;
		lister()
			.then((listing) => {
				if (live) {
					setCatalog(ttsVoiceCatalog(listing));
				}
			})
			.catch(() => {
				if (live) {
					setCatalog({ engines: [], groups: [] });
				}
			});
		return () => {
			live = false;
		};
	}, [lister]);
	return catalog;
}

/**
 * Narration voice and language. With a host engine listing it offers the
 * installed voices grouped by engine and language; otherwise (or while the
 * listing loads) it keeps free-text voice and language fields.
 */
export function VoicePicker({
	disabled,
	languageAriaLabel = "Narration language",
	listEngines,
	onChange,
	showLanguage = true,
	value,
	voiceAriaLabel,
	voiceLabel,
}: {
	disabled?: boolean;
	languageAriaLabel?: string;
	/** The engine listing; defaults to the host's `media.ttsEngines`. */
	listEngines?: () => Promise<unknown>;
	onChange: (choice: TtsVoiceChoice) => void;
	showLanguage?: boolean;
	value: TtsVoiceChoice;
	voiceAriaLabel: string;
	voiceLabel: string;
}) {
	const catalog = useTtsVoiceCatalog(listEngines ?? hostTtsEngines());
	const tl = useLiteralMessages();
	if (!(catalog && catalogHasVoices(catalog))) {
		return (
			<>
				<RyuAppField label={voiceLabel}>
					<Input
						aria-label={voiceAriaLabel}
						disabled={disabled}
						maxLength={100}
						onChange={(event) =>
							onChange({ ...value, engine: "", voice: event.target.value })
						}
						placeholder="Use engine default"
						value={value.voice}
					/>
				</RyuAppField>
				{showLanguage && (
					<RyuAppField label="Language (optional)">
						<Input
							aria-label={languageAriaLabel}
							disabled={disabled}
							maxLength={35}
							onChange={(event) =>
								onChange({ ...value, language: event.target.value })
							}
							placeholder="For example, en-us"
							value={value.language}
						/>
					</RyuAppField>
				)}
			</>
		);
	}
	const selected = voiceOptionValue(value);
	const listed = catalog.groups.some((group) =>
		group.voices.some((option) => voiceOptionValue(option) === selected)
	);
	const languages = choiceLanguages(catalog, value.engine);
	const missing = catalog.engines.filter((engine) => !engine.installed);
	return (
		<>
			<RyuAppField label={voiceLabel}>
				<NativeSelect
					aria-label={voiceAriaLabel}
					disabled={disabled}
					onChange={(event) =>
						onChange(choiceFromOption(catalog, event.target.value, value))
					}
					value={selected}
				>
					<NativeSelectOption value="">Engine default</NativeSelectOption>
					{selected && !listed && (
						<NativeSelectOption value={selected}>
							{value.voice}
						</NativeSelectOption>
					)}
					{catalog.groups.map((group) => (
						<NativeSelectOptGroup
							key={`${group.engine}/${group.language}`}
							label={`${group.engineLabel} · ${group.languageLabel}`}
						>
							{group.voices.map((option) => (
								<NativeSelectOption
									key={option.voice}
									value={voiceOptionValue(option)}
								>
									{option.label}
								</NativeSelectOption>
							))}
						</NativeSelectOptGroup>
					))}
				</NativeSelect>
			</RyuAppField>
			{showLanguage && (
				<RyuAppField label="Language (optional)">
					<NativeSelect
						aria-label={languageAriaLabel}
						disabled={disabled}
						onChange={(event) =>
							onChange({ ...value, language: event.target.value })
						}
						value={value.language}
					>
						<NativeSelectOption value="">Voice default</NativeSelectOption>
						{value.language && !languages.includes(value.language) && (
							<NativeSelectOption value={value.language}>
								{languageLabel(value.language)}
							</NativeSelectOption>
						)}
						{languages.map((code) => (
							<NativeSelectOption key={code} value={code}>
								{languageLabel(code)}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
			)}
			{missing.length > 0 && (
				<small>
					{tl(
						"Not installed: {engineNames}. Install speech engines in Ryu settings to add their voices.",
						{ engineNames: missing.map((engine) => engine.label).join(", ") }
					)}
				</small>
			)}
		</>
	);
}
