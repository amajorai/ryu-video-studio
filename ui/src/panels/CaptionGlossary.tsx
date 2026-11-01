import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Input } from "@ryu/blocks/companion/controls";
import { formatMessage } from "@ryu/i18n/core";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import {
	type GlossaryEntry,
	glossarySuggestionRequest,
	MAX_GLOSSARY_ENTRIES,
	mergeGlossary,
	parseGlossarySuggestions,
} from "../../../shared/caption-glossary.ts";
import { activeCaptions } from "../../../shared/project.ts";
import { useEditorProject } from "../editor/context.tsx";

/** "Fixed N names and terms…" from the route's reply. */
export function glossarySummary(
	extras: Record<string, unknown>,
	tl: LiteralMessage = (source, values) => formatMessage(source, values, "en")
): string {
	const replacements =
		typeof extras.replacements === "number" ? extras.replacements : 0;
	const transcripts = Array.isArray(extras.transcripts)
		? extras.transcripts.length
		: 0;
	const values = {
		replacementCount: String(replacements),
		replacements,
		transcriptCount: String(transcripts),
		transcripts,
	};
	return transcripts
		? tl(
				"Fixed {replacements, plural, one {{replacementCount} name and term} other {{replacementCount} names and terms}} in the captions and {transcripts, plural, one {{transcriptCount} transcript} other {{transcriptCount} transcripts}}.",
				values
			)
		: tl(
				"Fixed {replacements, plural, one {{replacementCount} name and term} other {{replacementCount} names and terms}} in the captions.",
				values
			);
}

/**
 * "Fix names and terms": a project glossary of wrong→right pairs applied as
 * one batch replace across the captions (and, optionally, every language
 * track and the source transcripts), with Ryu suggesting pairs for misheard
 * proper nouns and jargon. Saved on the project, so agents use the same list.
 */
export function CaptionGlossary() {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const { busy, project, routeEdit, setStatus } = runtime;
	const saved = project.captionGlossary ?? [];
	const [draft, setDraft] = useState<GlossaryEntry[] | null>(null);
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [allTracks, setAllTracks] = useState(false);
	const [suggestions, setSuggestions] = useState<GlossaryEntry[]>([]);
	const [suggesting, setSuggesting] = useState(false);
	const glossary = draft ?? saved;
	const complete = window.ryu?.model?.complete;
	const working = busy || suggesting;

	const addPair = () => {
		if (!(from.trim() && to.trim())) {
			return;
		}
		setDraft(mergeGlossary(glossary, [{ from, to }]));
		setFrom("");
		setTo("");
	};
	const apply = async () => {
		const outcome = await routeEdit(
			"caption-glossary",
			{ allTracks, glossary, transcripts: true },
			(extras) => glossarySummary(extras, tl)
		);
		if (outcome.status === "ok") {
			setDraft(null);
		}
	};
	const suggest = async () => {
		if (!complete) {
			return;
		}
		setSuggesting(true);
		setStatus("Asking Ryu for likely misheard names and terms…");
		try {
			const found = parseGlossarySuggestions(
				await complete(
					glossarySuggestionRequest(activeCaptions(project), {
						brief: project.brief,
						title: project.title,
					})
				)
			).filter(
				(entry) =>
					!glossary.some(
						(existing) =>
							existing.from.toLocaleLowerCase() ===
							entry.from.toLocaleLowerCase()
					)
			);
			setSuggestions(found);
			setStatus(
				found.length
					? tl(
							"Ryu suggested {count, plural, one {# fix} other {# fixes}}. Review them before adding.",
							{ count: found.length }
						)
					: "Ryu found nothing to fix."
			);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Suggestions failed.");
		} finally {
			setSuggesting(false);
		}
	};
	return (
		<RyuAppSection title="Fix names and terms">
			<p className="text-muted-foreground">
				List words the transcription gets wrong and how to spell them. Fixing
				replaces every whole-word match, ignoring case, in the captions and the
				source transcripts in one undoable step.
			</p>
			{glossary.length > 0 && (
				<ul aria-label="Name and term fixes" className="grid gap-1 text-sm">
					{glossary.map((entry) => (
						<li
							className="flex items-center justify-between gap-2"
							key={entry.from.toLocaleLowerCase()}
						>
							<span>
								<s className="text-muted-foreground">{entry.from}</s> →{" "}
								<strong>{entry.to}</strong>
							</span>
							<Button
								aria-label={tl("Remove fix for {from}", { from: entry.from })}
								disabled={working}
								onClick={() =>
									setDraft(glossary.filter((item) => item !== entry))
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			<div className="grid grid-cols-2 gap-2">
				<RyuAppField label="Heard as">
					<Input
						aria-label="Heard as"
						disabled={working}
						maxLength={100}
						onChange={(event) => setFrom(event.target.value)}
						placeholder="rye you"
						value={from}
					/>
				</RyuAppField>
				<RyuAppField label="Correct spelling">
					<Input
						aria-label="Correct spelling"
						disabled={working}
						maxLength={100}
						onChange={(event) => setTo(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								addPair();
							}
						}}
						placeholder="Ryu"
						value={to}
					/>
				</RyuAppField>
			</div>
			{suggestions.length > 0 && (
				<div className="grid gap-1 text-sm">
					<p className="text-muted-foreground text-xs">Ryu suggests</p>
					<ul aria-label="Suggested fixes">
						{suggestions.map((entry) => (
							<li key={entry.from.toLocaleLowerCase()}>
								{entry.from} → {entry.to}
							</li>
						))}
					</ul>
					<RyuAppActions>
						<Button
							disabled={working}
							onClick={() => {
								setDraft(mergeGlossary(glossary, suggestions));
								setSuggestions([]);
							}}
							size="sm"
							variant="outline"
						>
							Add suggestions
						</Button>
						<Button
							disabled={working}
							onClick={() => setSuggestions([])}
							size="sm"
							variant="ghost"
						>
							Dismiss
						</Button>
					</RyuAppActions>
				</div>
			)}
			<label className="flex items-center gap-1.5 text-sm">
				<Checkbox
					aria-label="Also fix language tracks"
					checked={allTracks}
					disabled={working}
					onCheckedChange={(checked) => setAllTracks(checked === true)}
				/>
				Also fix every caption language track
			</label>
			<RyuAppActions>
				<Button
					disabled={
						working ||
						!(from.trim() && to.trim()) ||
						glossary.length >= MAX_GLOSSARY_ENTRIES
					}
					onClick={addPair}
					size="sm"
					variant="outline"
				>
					Add fix
				</Button>
				<Button
					disabled={working || !complete || !project.captions.length}
					onClick={() => void suggest()}
					size="sm"
					title={complete ? undefined : "Ryu's model service is unavailable"}
					variant="ghost"
				>
					{suggesting ? "Suggesting…" : "Suggest fixes with Ryu"}
				</Button>
				<Button
					disabled={working || glossary.length === 0}
					onClick={() => void apply()}
					size="sm"
				>
					Fix captions and transcripts
				</Button>
			</RyuAppActions>
		</RyuAppSection>
	);
}
