/**
 * A WebGL2 preview pass: one full-frame fragment shader applied to the
 * previous pass's output (or the clip's media for the first pass).
 *
 * The shader is GLSL ES 3.00 *body* code. The pipeline prepends:
 *
 * ```glsl
 * #version 300 es
 * precision highp float;
 * uniform sampler2D u_source;   // previous pass, straight (non-premultiplied) RGBA
 * uniform vec2 u_resolution;    // output size in pixels
 * uniform float u_time;         // clip-relative time in seconds
 * in vec2 v_uv;                 // 0..1 texture coordinates, (0, 0) is the frame's bottom-left
 * out vec4 outColor;
 * ```
 *
 * and the pass declares its own uniforms and `void main()`.
 */
export type GlUniformValue =
	| number
	| readonly [number, number]
	| readonly [number, number, number]
	| readonly [number, number, number, number];

export interface GlPass {
	fragment: string;
	/** Stable id; also the program cache key together with `fragment`. */
	id: string;
	uniforms: Readonly<Record<string, GlUniformValue>>;
}

/** Fixed pass order, mirroring the render stage order: key, grade, effects. */
export const glPassOrder = ["key", "grade", "effects"] as const;
export type GlPassStage = (typeof glPassOrder)[number];

/** Drop inactive passes while preserving the fixed stage order. */
export function orderedGlPasses(
	passes: Readonly<Partial<Record<GlPassStage, GlPass | null>>>
): GlPass[] {
	const active: GlPass[] = [];
	for (const stage of glPassOrder) {
		const pass = passes[stage];
		if (pass) {
			active.push(pass);
		}
	}
	return active;
}

/**
 * Value identity for a pass list (ids, shader bodies and uniforms), so a
 * freshly built but unchanged list does not trigger another draw.
 */
export function glPassesKey(passes: readonly GlPass[]): string {
	return JSON.stringify(
		passes.map((pass) => [
			pass.id,
			pass.fragment,
			Object.entries(pass.uniforms).sort(([a], [b]) => (a < b ? -1 : 1)),
		])
	);
}
