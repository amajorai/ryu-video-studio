import { type KeyboardEvent, type MouseEvent, memo } from "react";
import type {
	TokenSpan,
	TranscriptToken,
} from "../../../shared/timeline-transcript.ts";
import { timelineClock } from "../editing-ui.ts";

/** Tailwind classes for one word chip from its state. */
export function wordClass(state: {
	active: boolean;
	currentHit: boolean;
	hit: boolean;
	selected: boolean;
	unit: TranscriptToken["unit"];
}): string {
	const classes = [
		"rounded px-0.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	];
	if (state.unit === "cue") {
		classes.push("italic");
	}
	if (state.selected) {
		classes.push("bg-destructive/20 text-destructive line-through");
	} else if (state.active) {
		classes.push("bg-primary text-primary-foreground");
	} else if (state.hit) {
		classes.push("bg-accent text-accent-foreground underline");
	}
	if (state.currentHit) {
		classes.push("ring-2 ring-primary");
	}
	return classes.join(" ");
}

export type WordEventKind = "click" | "down" | "enter" | "key";
export type WordEvent =
	| KeyboardEvent<HTMLButtonElement>
	| MouseEvent<HTMLButtonElement>;

export const WordList = memo(function WordList({
	active,
	currentHit,
	hits,
	onWord,
	selected,
	sentences,
	tokens,
}: {
	active: number;
	currentHit: TokenSpan | undefined;
	hits: ReadonlySet<number>;
	onWord: (kind: WordEventKind, index: number, event: WordEvent) => void;
	selected: ReadonlySet<number>;
	sentences: readonly TokenSpan[];
	tokens: readonly TranscriptToken[];
}) {
	return (
		<div className="flex flex-col gap-2">
			{sentences.map((sentence) => (
				<p className="leading-relaxed" key={sentence.first}>
					<span className="mr-1 text-muted-foreground text-xs tabular-nums">
						{timelineClock(tokens[sentence.first]?.start ?? 0)}
					</span>
					{tokens.slice(sentence.first, sentence.last + 1).map((token) => (
						<span key={token.index}>
							<button
								aria-label={`${token.text.trim()} at ${timelineClock(token.start)}`}
								aria-pressed={selected.has(token.index)}
								className={wordClass({
									active: token.index === active,
									currentHit: Boolean(
										currentHit &&
											token.index >= currentHit.first &&
											token.index <= currentHit.last
									),
									hit: hits.has(token.index),
									selected: selected.has(token.index),
									unit: token.unit,
								})}
								data-token-index={token.index}
								onClick={(event) => onWord("click", token.index, event)}
								onKeyDown={(event) => onWord("key", token.index, event)}
								onPointerDown={(event) => onWord("down", token.index, event)}
								onPointerEnter={(event) => onWord("enter", token.index, event)}
								type="button"
							>
								{token.text.trim()}
							</button>{" "}
						</span>
					))}
				</p>
			))}
		</div>
	);
});
