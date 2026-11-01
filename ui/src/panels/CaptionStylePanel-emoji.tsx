import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import {
	applyEmojiSuggestions,
	type EmojiSuggestion,
	emojiPrompt,
	parseEmojiSuggestions,
} from "../../../shared/caption-edits.ts";
import { activeCaptions, type Caption } from "../../../shared/project.ts";
import { type Runtime, styleTargetTrackId } from "./CaptionStylePanel-model.ts";

export function EmojiSuggestions({ runtime }: { runtime: Runtime }) {
	const tl = useLiteralMessages();
	const { project } = runtime;
	const [suggestions, setSuggestions] = useState<EmojiSuggestion[]>([]);
	const [accepted, setAccepted] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const captions = activeCaptions(project);
	const model = window.ryu?.model;
	const byId = new Map(captions.map((caption) => [caption.id, caption]));
	const suggest = async () => {
		if (!model) {
			return;
		}
		setLoading(true);
		try {
			const reply = await model.complete(emojiPrompt(captions));
			const next = parseEmojiSuggestions(reply, captions);
			setSuggestions(next);
			setAccepted(new Set(next.map((item) => item.captionId)));
			runtime.setStatus(
				next.length
					? tl(
							"Review {count, plural, one {{countText} emoji suggestion} other {{countText} emoji suggestions}} before applying.",
							{ count: next.length, countText: String(next.length) }
						)
					: "No emoji suggestions for these captions."
			);
		} catch (error) {
			runtime.setStatus(
				error instanceof Error ? error.message : "Emoji suggestions failed."
			);
		} finally {
			setLoading(false);
		}
	};
	const apply = () => {
		const chosen = suggestions.filter((item) => accepted.has(item.captionId));
		const next: Caption[] = applyEmojiSuggestions(captions, chosen);
		void runtime
			.routeEdit(
				"captions",
				{
					action: "replace",
					captions: next,
					trackId: styleTargetTrackId(project),
				},
				() => `Added ${chosen.length} emoji.`
			)
			.then(() => setSuggestions([]));
	};
	return (
		<>
			<RyuAppActions>
				<Button
					disabled={!model || loading || runtime.busy || captions.length === 0}
					onClick={() => void suggest()}
					size="sm"
					title={model ? undefined : "Requires Ryu's model service."}
					variant="outline"
				>
					{loading ? "Suggesting…" : "Suggest emoji"}
				</Button>
			</RyuAppActions>
			{suggestions.length > 0 && (
				<>
					<ul className="flex flex-col gap-1">
						{suggestions.map((item) => (
							<li className="flex items-center gap-2" key={item.captionId}>
								<Checkbox
									aria-label={tl("Add {emoji}", { emoji: item.emoji })}
									checked={accepted.has(item.captionId)}
									onCheckedChange={(checked) =>
										setAccepted((current) => {
											const next = new Set(current);
											if (checked === true) {
												next.add(item.captionId);
											} else {
												next.delete(item.captionId);
											}
											return next;
										})
									}
								/>
								<span>
									{byId.get(item.captionId)?.text} {item.emoji}
								</span>
							</li>
						))}
					</ul>
					<RyuAppActions>
						<Button
							disabled={runtime.busy || accepted.size === 0}
							onClick={apply}
							size="sm"
						>
							{tl("Apply {size} emoji", { size: String(accepted.size) })}
						</Button>
						<Button
							onClick={() => setSuggestions([])}
							size="sm"
							variant="ghost"
						>
							Discard
						</Button>
					</RyuAppActions>
				</>
			)}
		</>
	);
}
