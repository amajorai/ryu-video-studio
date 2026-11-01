import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { segmentDuration } from "../../../shared/project.ts";
import type { ClipSlotProps } from "./clip-slot-props.ts";
import {
	FILMSTRIP_DISPLAY_HEIGHT,
	type FilmstripSprite,
	filmstripCache,
	filmstripKey,
	filmstripTiles,
	loadFilmstrip,
	planFilmstrip,
} from "./clip-visual-cache.ts";
import { clipDrawSpan } from "./virtualize.ts";

type FilmstripStyle = CSSProperties & {
	"--studio-filmstrip-image": string;
	"--studio-filmstrip-size": string;
};

/**
 * Video thumbnail strip behind the clip. Thumbnails keep their aspect ratio
 * and repeat across the clip; each shows the frame for its slice of the
 * clip's source range. The sprite is shared through `filmstripCache`. A
 * clip wider than the draw window lays out only the tiles near the
 * viewport.
 */
export function ClipFilmstrip({
	asset,
	drawWindow,
	segment,
	zoom,
}: ClipSlotProps) {
	const clipWidth = Math.max(12, segmentDuration(segment) * zoom);
	const { assetId, sourceIn, sourceOut } = segment;
	const plan = useMemo(
		() => planFilmstrip(asset, { assetId, sourceIn, sourceOut }, clipWidth),
		[asset, assetId, sourceIn, sourceOut, clipWidth]
	);
	const key = plan ? filmstripKey(plan) : null;
	const [loaded, setLoaded] = useState<{
		key: string;
		sprite: FilmstripSprite;
	} | null>(null);
	useEffect(() => {
		if (!plan) {
			return;
		}
		const planKey = filmstripKey(plan);
		if (filmstripCache.peek(planKey)) {
			return;
		}
		let live = true;
		loadFilmstrip(plan).then(
			(sprite) => {
				if (live) {
					setLoaded({ key: planKey, sprite });
				}
			},
			() => {
				// Thumbnails are decoration; the clip stays usable without them.
			}
		);
		return () => {
			live = false;
		};
	}, [plan]);
	const sprite =
		key === null
			? undefined
			: loaded?.key === key
				? loaded.sprite
				: filmstripCache.peek(key);
	if (!(key && sprite)) {
		return null;
	}
	const thumbWidth = Math.max(
		1,
		Math.round(
			(sprite.frameWidth * FILMSTRIP_DISPLAY_HEIGHT) / sprite.frameHeight
		)
	);
	// The sprite URL and size are set once on the strip; tiles only pick
	// their frame, so a long clip never repeats the data URL per tile.
	const stripStyle: FilmstripStyle = {
		"--studio-filmstrip-image": `url("${sprite.url}")`,
		"--studio-filmstrip-size": `${thumbWidth * sprite.count}px 100%`,
	};
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 overflow-hidden opacity-45"
			data-filmstrip={key}
			style={stripStyle}
		>
			{filmstripTiles(
				clipWidth,
				thumbWidth,
				sprite.count,
				clipDrawSpan(segment, drawWindow, zoom)
			).map((tile) => (
				<span
					className="absolute inset-y-0 bg-no-repeat"
					data-frame={tile.frame}
					key={tile.left}
					style={{
						backgroundImage: "var(--studio-filmstrip-image)",
						backgroundPosition: `${-tile.frame * thumbWidth}px 0`,
						backgroundSize: "var(--studio-filmstrip-size)",
						left: `${tile.left}px`,
						width: `${thumbWidth}px`,
					}}
				/>
			))}
		</span>
	);
}
