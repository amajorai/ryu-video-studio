import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { useEffect, useState } from "react";
import type { Asset, Project, Scene } from "../../shared/project.ts";
import { takeQuality } from "../../shared/take-quality.ts";
import { request } from "./bridge.ts";

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
	const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
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
		const missing = ids.filter((id) => !thumbnails[id]);
		if (!missing.length) {
			return;
		}
		setLoading(true);
		void Promise.all(
			missing.map(async (id) => {
				try {
					const result = await request<{ data: unknown }>(
						`/assets/${id}/thumbnail`
					);
					if (
						typeof result.data !== "string" ||
						result.data.length > 2_000_000
					) {
						throw new Error("The scene thumbnail is unavailable.");
					}
					return [id, `data:image/jpeg;base64,${result.data}`] as [
						string,
						string,
					];
				} catch (error) {
					onStatus(
						error instanceof Error ? error.message : "Scene thumbnail failed."
					);
					return null;
				}
			})
		)
			.then((entries) => {
				if (mounted) {
					setThumbnails((current) =>
						Object.fromEntries([
							...Object.entries(current),
							...entries.filter(
								(entry): entry is [string, string] => entry !== null
							),
						])
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
			{!scenes.length && <p>No scenes have been drafted yet.</p>}
			{scenes.length > 0 && (
				<div className="studio-contact-sheet">
					{scenes.map((scene, index) => {
						const asset = scene.assetIds
							.map((id) => assets.find((candidate) => candidate.id === id))
							.find((candidate) => candidate && candidate.kind !== "audio");
						const quality = takeQuality(asset, project);
						return (
							<div className="studio-contact-card" key={scene.id}>
								<div className="studio-contact-image">
									{asset && thumbnails[asset.id] ? (
										<img
											alt={`Scene ${index + 1} take`}
											src={thumbnails[asset.id]}
										/>
									) : (
										<span>{loading ? "Loading…" : "No visual take"}</span>
									)}
								</div>
								<strong>
									Scene {index + 1}: {scene.title || "Untitled"}
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
										Note: {scene.reviewNotes.trim().slice(0, 140)}
										{scene.reviewNotes.trim().length > 140 ? "…" : ""}
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
