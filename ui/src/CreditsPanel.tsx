import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useEffect, useState } from "react";
import { type Credits, creditsSchema } from "../../shared/credits.ts";
import { download, request } from "./bridge.ts";

export function CreditsPanel({
	projectId,
	revision,
	onStatus,
}: {
	projectId: string;
	revision: number;
	onStatus: (message: string) => void;
}) {
	const [credits, setCredits] = useState<Credits | null>(null);
	const [markdown, setMarkdown] = useState("");
	useEffect(() => {
		let mounted = true;
		void request<unknown>(`/projects/${projectId}/credits`)
			.then((value) => {
				if (!mounted) {
					return;
				}
				if (
					typeof value !== "object" ||
					value === null ||
					Array.isArray(value)
				) {
					throw new Error("Credits response was malformed.");
				}
				const { markdown, ...payload } = value as Record<string, unknown>;
				setCredits(creditsSchema.parse(payload));
				setMarkdown(typeof markdown === "string" ? markdown : "");
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
					<a href={entry.pageUrl} rel="noreferrer noopener" target="_blank">
						Open source page
					</a>
				</div>
			))}
			<Button
				disabled={!markdown}
				onClick={() => {
					download(
						new Blob([markdown], { type: "text/markdown" }),
						`${credits?.projectTitle ?? "video"}-credits.md`
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
