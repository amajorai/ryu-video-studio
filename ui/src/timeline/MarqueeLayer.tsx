import { useRef } from "react";
import { useEditorProject } from "../editor/context.tsx";
import { useMarquee } from "./useMarquee.ts";

/**
 * Rubber-band selection rectangle. Mounted inside the lanes container; the
 * hook listens for presses on empty lane space there and this layer draws
 * the rectangle while one is dragged.
 */
export function MarqueeLayer({ zoom }: { zoom: number }) {
	const runtime = useEditorProject();
	const layerRef = useRef<HTMLDivElement>(null);
	const { rect } = useMarquee({ layerRef, runtime, zoom });
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[3]"
			data-marquee-layer=""
			ref={layerRef}
		>
			{rect && (
				<div
					className="absolute rounded-sm border border-primary bg-primary/15"
					data-marquee=""
					style={{
						height: rect.bottom - rect.top,
						left: rect.left,
						top: rect.top,
						width: rect.right - rect.left,
					}}
				/>
			)}
		</div>
	);
}
