import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { Asset, Project, Scene } from "../../shared/project.ts";
import { takeQuality } from "../../shared/take-quality.ts";
import { request, studioResponseSchema } from "./bridge.ts";

const sceneThumbnailSchema = z.object({ data: z.string().max(2_000_000) });

export function SceneContactSheet({
	assets,
	project,
	scenes,
	onStatus,
}: {
	assets: Asset[];
	project: Pick<Project, "height" | "width">;
	scenes: Scene[];
	onStatus: (message: string) => void;
}) {
	const tl = useLiteralMessages();
	const [thumbnails, setThumbnails] = useState<Record<string, string | null>>(
		{}
	);
	const [loading, setLoading] = useState(false);
	const visualAssets = scenes
		.map((scene) =>
			scene.assetIds.map((id) => assets.find((asset) => asset.id === id))
		)
		.map((items) => items.find((asset) => asset && asset.kind !== "audio"))
		.filter((asset): asset is Asset => Boolean(asset));
	const ids = [...new Set(visualAssets.map((asset) => asset.id))];
	useEffect(() => {
		let mounted = true;
		const missing = ids.filter((id) => !Object.hasOwn(thumbnails, id));
		if (!missing.length) {
			return;
		}
		setLoading(true);
		void Promise.all(
			missing.map(async (id): Promise<[string, string | null]> => {
				try {
					const result = sceneThumbnailSchema.safeParse(
						await request(studioResponseSchema, `/assets/${id}/thumbnail`)
					);
					if (!result.success) {
						throw new Error("The scene thumbnail is unavailable.");
					}
					return [id, `data:image/jpeg;base64,${result.data.data}`];
				} catch (error) {
					onStatus(
						error instanceof Error ? error.message : "Scene thumbnail failed."
					);
					return [id, null];
				}
			})
		)
			.then((entries) => {
				if (mounted) {
					setThumbnails((current) =>
						Object.fromEntries([...Object.entries(current), ...entries])
					);
				}
			})
			.finally(() => {
				if (mounted) {
					setLoading(false);
				}
			});
		return () => {
			mounted = false;
		};
	}, [ids.join(","), onStatus, thumbnails]);
	return (
		<RyuAppSection title="Scene contact sheet">
			<p className="text-muted-foreground">
				Review selected visual takes at a glance before approving the
				production.
			</p>
			{ids.some((id) => thumbnails[id] === null) && (
				<Button
					disabled={loading}
					onClick={() => {
						onStatus("");
						setThumbnails((current) =>
							Object.fromEntries(
								Object.entries(current).filter(([, value]) => value !== null)
							)
						);
					}}
					size="sm"
					variant="outline"
				>
					Retry unavailable previews
				</Button>
			)}
			{!scenes.length && <p>No scenes have been drafted yet.</p>}
			{scenes.length > 0 && (
				<div className="studio-contact-sheet">
					{scenes.map((scene, index) => {
						const asset = scene.assetIds
							.map((id) => assets.find((candidate) => candidate.id === id))
							.find((candidate) => candidate && candidate.kind !== "audio");
						const quality = takeQuality(asset, project);
						const thumbnail = asset ? thumbnails[asset.id] : undefined;
						return (
							<div className="studio-contact-card" key={scene.id}>
								<div className="studio-contact-image">
									{thumbnail ? (
										<img
											alt={tl("Scene {sceneNumber} take", {
												sceneNumber: index + 1,
											})}
											src={safeMediaUrl(thumbnail) ?? undefined}
										/>
									) : (
										<span>
											{loading
												? "Loading…"
												: asset
													? "Preview unavailable"
													: "No visual take"}
										</span>
									)}
								</div>
								<strong>
									{tl("Scene {sceneNumber}: {title}", {
										sceneNumber: index + 1,
										title: scene.title || tl("Untitled"),
									})}
								</strong>
								<small>
									{scene.approved
										? "Approved"
										: scene.reviewStatus === "changes-requested"
											? "Changes requested"
											: "In review"}{" "}
									· {asset?.name ?? "No take"}
								</small>
								<small>
									{quality.label} · {quality.score}/100
								</small>
								<small>{quality.detail}</small>
								{scene.reviewNotes?.trim() ? (
									<small>
										{tl("Note: {note}{truncated, select, yes {…} other {}}", {
											note: scene.reviewNotes.trim().slice(0, 140),
											truncated:
												scene.reviewNotes.trim().length > 140 ? "yes" : "no",
										})}
									</small>
								) : null}
							</div>
						);
					})}
				</div>
			)}
		</RyuAppSection>
	);
}
