import { animationExpression, type Segment } from "../../../shared/project.ts";

/** Static opacity, or a per-pixel alpha expression when opacity is keyframed. */
export function opacityFilter(segment: Segment): string {
	if (!segment.keyframes.some((frame) => frame.property === "opacity")) {
		return `colorchannelmixer=aa=${segment.opacity}`;
	}
	const opacity = animationExpression(segment, "opacity", "T");
	return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacity})'`;
}
