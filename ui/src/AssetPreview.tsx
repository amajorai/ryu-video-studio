import { Button } from "@ryu/blocks/companion/controls";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useRef, useState } from "react";
import type { Asset } from "../../shared/project.ts";
import { request } from "./bridge.ts";

export function AssetPreview({
	asset,
	onError,
}: {
	asset: Asset;
	onError: (message: string) => void;
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const [url, setUrl] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const show = async () => {
		if (url) {
			setOpen(true);
			return;
		}
		setLoading(true);
		try {
			const result = await request<{ data: unknown }>(
				`/assets/${asset.id}/thumbnail`
			);
			if (
				typeof result.data !== "string" ||
				result.data.length > 2_000_000 ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)
			) {
				throw new Error("The source preview is unavailable.");
			}
			setUrl(`data:image/jpeg;base64,${result.data}`);
			setOpen(true);
		} catch (error) {
			onError(
				error instanceof Error ? error.message : "Source preview failed."
			);
		} finally {
			setLoading(false);
		}
	};
	return (
		<>
			<Button
				aria-label={`Preview ${asset.name}`}
				disabled={loading}
				onClick={() => void show()}
				ref={trigger}
				size="sm"
				variant="ghost"
			>
				{loading
					? "Loading preview…"
					: asset.kind === "video"
						? "Preview frame"
						: "Preview"}
			</Button>
			{url && (
				<Dialog onOpenChange={setOpen} open={open}>
					<DialogContent className="sm:max-w-2xl" finalFocus={trigger}>
						<DialogHeader>
							<DialogTitle className="pe-8">{asset.name}</DialogTitle>
							<DialogDescription>
								Source thumbnail. Timeline edits and exports use the original
								media.
							</DialogDescription>
						</DialogHeader>
						<img
							alt={`Preview of ${asset.name}`}
							className="max-h-[60vh] w-full object-contain"
							height={asset.height}
							src={url}
							width={asset.width}
						/>
						<DialogFooter>
							<Button onClick={() => setOpen(false)} variant="outline">
								Close preview
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}
