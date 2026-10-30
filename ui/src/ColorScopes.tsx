import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	colorScopesDetailSchema,
	DEFAULT_SCOPE_COLUMNS,
	type ScopeWaveforms,
	scopeIntensity,
	scopePeak,
} from "../../shared/color-scopes.ts";
import type { Asset } from "../../shared/project.ts";
import { request } from "./bridge.ts";

interface ColorScopesResult {
	clipping: { black: boolean; white: boolean };
	hueDegrees: number;
	luma: { average: number; max: number; min: number };
	saturation: { average: number; max: number; min: number };
	waveforms: ScopeWaveforms;
}

/** One filled cell of a scope drawing, in canvas pixels. */
export interface ScopeCell {
	alpha: number;
	/** Parade channel; histogram and vectorscope cells use the text color. */
	channel?: "r" | "g" | "b";
	height: number;
	width: number;
	x: number;
	y: number;
}

/** Height of the histogram canvas in pixels. */
export const HISTOGRAM_HEIGHT = 64;
/** Blank columns between parade channels. */
export const PARADE_GAP = 4;
/**
 * The parade draws measured channel data, so each panel uses its own
 * primary rather than a theme token.
 */
const PARADE_COLORS = {
	b: "rgb(80 140 255)",
	g: "rgb(64 210 110)",
	r: "rgb(255 80 80)",
} as const;

/** Histogram bars: one column per code value, log-scaled to the peak. */
export function histogramCells(histogram: readonly number[]): ScopeCell[] {
	const peak = scopePeak(histogram);
	const cells: ScopeCell[] = [];
	for (const [x, count] of histogram.entries()) {
		const height = Math.round(scopeIntensity(count, peak) * HISTOGRAM_HEIGHT);
		if (height > 0) {
			cells.push({
				alpha: 1,
				height,
				width: 1,
				x,
				y: HISTOGRAM_HEIGHT - height,
			});
		}
	}
	return cells;
}

/** Width of the parade canvas: three channel panels and two gaps. */
export const paradeWidth = (parade: ScopeWaveforms["parade"]) =>
	parade.columns * 3 + PARADE_GAP * 2;

/** Parade cells: R, G, B panels left to right, bright values at the top. */
export function paradeCells(parade: ScopeWaveforms["parade"]): ScopeCell[] {
	const cells: ScopeCell[] = [];
	const channels = ["r", "g", "b"] as const;
	for (const [panel, channel] of channels.entries()) {
		const rows = parade[channel];
		const peak = scopePeak(rows);
		const offset = panel * (parade.columns + PARADE_GAP);
		for (const [column, bins] of rows.entries()) {
			for (const [bin, count] of bins.entries()) {
				const alpha = scopeIntensity(count, peak);
				if (alpha > 0) {
					cells.push({
						alpha,
						channel,
						height: 1,
						width: 1,
						x: offset + column,
						y: parade.bins - 1 - bin,
					});
				}
			}
		}
	}
	return cells;
}

/** Vectorscope cells: Cb to the right, Cr upward, grey in the centre. */
export function vectorscopeCells(
	vectorscope: ScopeWaveforms["vectorscope"]
): ScopeCell[] {
	const peak = scopePeak(vectorscope.cells);
	const cells: ScopeCell[] = [];
	for (const [y, row] of vectorscope.cells.entries()) {
		for (const [x, count] of row.entries()) {
			const alpha = scopeIntensity(count, peak);
			if (alpha > 0) {
				cells.push({ alpha, height: 1, width: 1, x, y });
			}
		}
	}
	return cells;
}

function ScopeCanvas({
	cells,
	className,
	height,
	label,
	width,
}: {
	cells: readonly ScopeCell[];
	className: string;
	height: number;
	label: string;
	width: number;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const element = canvas.current;
		const context = element?.getContext("2d");
		if (!(element && context)) {
			return;
		}
		const ink = getComputedStyle(element).color || "currentColor";
		context.clearRect(0, 0, width, height);
		for (const cell of cells) {
			context.globalAlpha = cell.alpha;
			context.fillStyle = cell.channel ? PARADE_COLORS[cell.channel] : ink;
			context.fillRect(cell.x, cell.y, cell.width, cell.height);
		}
		context.globalAlpha = 1;
	}, [cells, height, width]);
	return (
		<canvas
			aria-label={label}
			className={className}
			height={height}
			ref={canvas}
			role="img"
			style={{ imageRendering: "pixelated" }}
			width={width}
		/>
	);
}

/** Histogram, RGB parade, and vectorscope canvases for one measured frame. */
export function ScopeCanvases({ waveforms }: { waveforms: ScopeWaveforms }) {
	const { histogram, parade, vectorscope } = waveforms;
	const histogramDrawing = useMemo(
		() => histogramCells(histogram),
		[histogram]
	);
	const paradeDrawing = useMemo(() => paradeCells(parade), [parade]);
	const vectorDrawing = useMemo(
		() => vectorscopeCells(vectorscope),
		[vectorscope]
	);
	return (
		<div className="grid w-full grid-cols-[2fr_3fr_1fr] items-end gap-2">
			<ScopeCanvas
				cells={histogramDrawing}
				className="h-16 w-full rounded-sm bg-muted text-foreground"
				height={HISTOGRAM_HEIGHT}
				label="Luma histogram"
				width={histogram.length}
			/>
			<ScopeCanvas
				cells={paradeDrawing}
				className="h-16 w-full rounded-sm bg-muted"
				height={parade.bins}
				label="RGB parade"
				width={paradeWidth(parade)}
			/>
			<ScopeCanvas
				cells={vectorDrawing}
				className="aspect-square w-full rounded-full bg-muted text-foreground"
				height={vectorscope.size}
				label="Vectorscope"
				width={vectorscope.size}
			/>
		</div>
	);
}

export function ColorScopes({
	asset,
	onError,
}: {
	asset: Asset;
	onError: (message: string) => void;
}) {
	const tl = useLiteralMessages();
	const [scopes, setScopes] = useState<ColorScopesResult | null>(null);
	const [loading, setLoading] = useState(false);
	const inspect = async () => {
		setLoading(true);
		try {
			const result = await request(
				colorScopesDetailSchema,
				`/assets/${asset.id}/scopes?time=0&detail=full&columns=${DEFAULT_SCOPE_COLUMNS}`
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
		<div className="col-span-full flex basis-full flex-wrap items-center gap-2">
			<Button
				aria-label={tl("Inspect color of {name}", { name: asset.name })}
				className="shrink-0"
				disabled={loading}
				onClick={() => void inspect()}
				size="sm"
				variant="ghost"
			>
				{loading ? "Inspecting…" : "Inspect color"}
			</Button>
			{scopes && (
				<small>
					{tl(
						"Luma {luma}% · Saturation {saturation}% · Hue {hue}°{whiteClip, select, yes { · white clip} other {}}{blackClip, select, yes { · black clip} other {}}",
						{
							blackClip: scopes.clipping.black ? "yes" : "no",
							hue: Math.round(scopes.hueDegrees),
							luma: Math.round(scopes.luma.average * 100),
							saturation: Math.round(scopes.saturation.average * 100),
							whiteClip: scopes.clipping.white ? "yes" : "no",
						}
					)}
				</small>
			)}
			{scopes && <ScopeCanvases waveforms={scopes.waveforms} />}
		</div>
	);
}
