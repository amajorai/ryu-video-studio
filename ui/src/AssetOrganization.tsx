import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useEffect, useState } from "react";
import type { Asset } from "../../shared/project.ts";

export function AssetOrganization({
	asset,
	busy,
	onDelete,
	onSave,
}: {
	asset: Asset;
	busy: boolean;
	onDelete: () => void;
	onSave: (patch: { folder: string; name: string }) => void;
}) {
	const [name, setName] = useState(asset.name);
	const [folder, setFolder] = useState(asset.folder ?? "");
	useEffect(() => {
		setName(asset.name);
		setFolder(asset.folder ?? "");
	}, [asset]);
	return (
		<details className="studio-asset-organization">
			<summary>Organize</summary>
			<RyuAppField label="Name">
				<Input
					aria-label={`Name for ${asset.name}`}
					disabled={busy}
					maxLength={200}
					onChange={(event) => setName(event.target.value)}
					value={name}
				/>
			</RyuAppField>
			<RyuAppField label="Folder">
				<Input
					aria-label={`Folder for ${asset.name}`}
					disabled={busy}
					maxLength={300}
					onChange={(event) => setFolder(event.target.value)}
					placeholder="B-roll/Sunset"
					value={folder}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={busy || !name.trim()}
					onClick={() => onSave({ folder: folder.trim(), name: name.trim() })}
					size="sm"
					variant="outline"
				>
					Save metadata
				</Button>
				<Button disabled={busy} onClick={onDelete} size="sm" variant="ghost">
					Delete media
				</Button>
			</RyuAppActions>
		</details>
	);
}
