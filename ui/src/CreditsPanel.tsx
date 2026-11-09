import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { safeHttpUrl } from "@ryu/ui/lib/safe-url.ts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { type Credits, creditsSchema } from "../../shared/credits.ts";
import { download, request } from "./bridge.ts";
import { localizedCreditsMarkdown } from "./credits-markdown.ts";

// The route also returns an English `markdown` for API callers; the download
// is built in the UI language instead (see credits-markdown.ts).
const creditsResponseSchema = creditsSchema.extend({
	markdown: z.string().optional().catch(undefined),
});

export function CreditsPanel({
	projectId,
	revision,
	onStatus,
}: {
	projectId: string;
	revision: number;
	onStatus: (message: string) => void;
}) {
	const tl = useLiteralMessages();
	const [credits, setCredits] = useState<Credits | null>(null);
	useEffect(() => {
		let mounted = true;
		void request(z.json(), `/projects/${projectId}/credits`)
			.then((value) => {
				if (!mounted) {
					return;
				}
				const { markdown: _english, ...payload } =
					creditsResponseSchema.parse(value);
				setCredits(payload);
			})
			.catch((error) => {
				if (mounted) {
					onStatus(
						error instanceof Error ? error.message : "Credits are unavailable."
					);
				}
			});
		return () => {
			mounted = false;
		};
	}, [onStatus, projectId, revision]);
	return (
		<RyuAppSection title="Credits and provenance">
			<p className="text-muted-foreground">
				Rights and attribution for source media used by this project. Generated
				and local composition layers do not need a source credit.
			</p>
			{credits && !credits.entries.length && (
				<p>No attributed source media is used by this project.</p>
			)}
			{credits?.entries.map((entry) => (
				<div className="studio-scene" key={entry.assetId}>
					<strong>{entry.assetName}</strong>
					<small>
						{entry.provider} · {entry.identifier}
					</small>
					<p>{entry.attribution}</p>
					<small>{entry.rights}</small>
					{safeHttpUrl(entry.pageUrl) ? (
						<a
							href={safeHttpUrl(entry.pageUrl) ?? undefined}
							rel="noreferrer noopener"
							target="_blank"
						>
							Open source page
						</a>
					) : null}
				</div>
			))}
			{credits?.fonts?.map((font) => (
				<div className="studio-scene" data-font-credit="" key={font.fontId}>
					<strong>{font.family}</strong>
					<small>
						{font.origin.provider} · {font.origin.identifier}
					</small>
					<p>{font.origin.attribution}</p>
					<small>{font.origin.license}</small>
					{safeHttpUrl(font.origin.pageUrl) ? (
						<a
							href={safeHttpUrl(font.origin.pageUrl) ?? undefined}
							rel="noreferrer noopener"
							target="_blank"
						>
							Open source page
						</a>
					) : null}
				</div>
			))}
			<Button
				disabled={!credits}
				onClick={() => {
					if (!credits) {
						return;
					}
					download(
						new Blob([localizedCreditsMarkdown(credits, tl)], {
							type: "text/markdown",
						}),
						`${credits.projectTitle}-credits.md`
					);
					onStatus("Credits document downloaded.");
				}}
				variant="outline"
			>
				Download credits
			</Button>
		</RyuAppSection>
	);
}
