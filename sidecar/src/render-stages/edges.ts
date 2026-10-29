import type { Segment } from "../../../shared/project.ts";

/** Rounded corners as an alpha mask, then edge softness as an alpha blur. */
export function edgeFilters(segment: Segment): string[] {
	const filters: string[] = [];
	if (segment.edgeRounding > 0) {
		const radius = `min(W,H)*${segment.edgeRounding}`;
		const corners = [
			`lt(X,${radius})*lt(Y,${radius})*lte(hypot(X-${radius},Y-${radius}),${radius})`,
			`gte(X,W-${radius})*lt(Y,${radius})*lte(hypot(X-(W-${radius}),Y-${radius}),${radius})`,
			`lt(X,${radius})*gte(Y,H-${radius})*lte(hypot(X-${radius},Y-(H-${radius})),${radius})`,
			`gte(X,W-${radius})*gte(Y,H-${radius})*lte(hypot(X-(W-${radius}),Y-(H-${radius})),${radius})`,
		];
		const mask = `gt(between(X,${radius},W-${radius})+between(Y,${radius},H-${radius})+${corners.join("+")},0)`;
		filters.push(
			`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${mask},alpha(X,Y),0)'`
		);
	}
	if (segment.edgeSoftness > 0) {
		filters.push(`boxblur=lr=0:lp=0:cr=0:cp=0:ar=${segment.edgeSoftness}:ap=1`);
	}
	return filters;
}
