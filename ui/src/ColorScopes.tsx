import { Button } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import type { Asset } from "../../shared/project.ts";
import { request } from "./bridge.ts";

interface ColorScopesResult {
	clipping: { black: boolean; white: boolean };
	hueDegrees: number;
	luma: { average: number; max: number; min: number };
	saturation: { average: number; max: number; min: number };
}

export function ColorScopes({
	asset,
	onError,
}: {
	asset: Asset;
	onError: (message: string) => void;
}) {
	const [scopes, setScopes] = useState<ColorScopesResult | null>(null);
	const [loading, setLoading] = useState(false);
	const inspect = async () => {
		setLoading(true);
		try {
			const result = await request<ColorScopesResult>(
				`/assets/${asset.id}/scopes?time=0`
			);
			setScopes(result);
		} catch (error) {
			onError(
				error instanceof Error ? error.message : "Color inspection failed."
			);
		} finally {
			setLoading(false);
		}
	};
	return (
		<>
			<Button
				aria-label={`Inspect color of ${asset.name}`}
				disabled={loading}
				onClick={() => void inspect()}
				size="sm"
				variant="ghost"
			>
				{loading ? "Inspecting…" : "Inspect color"}
			</Button>
			{scopes && (
				<small>
					Luma {Math.round(scopes.luma.average * 100)}% · Saturation{" "}
					{Math.round(scopes.saturation.average * 100)}% · Hue{" "}
					{Math.round(scopes.hueDegrees)}°
					{scopes.clipping.white ? " · white clip" : ""}
					{scopes.clipping.black ? " · black clip" : ""}
				</small>
			)}
		</>
	);
}
