/**
 * The whole-stack WebGL2 blend compositor. It draws a `CompositorPlan`
 * (`./plan.ts`) into one canvas: the canvas background, then every visible
 * media clip bottom to top, each blended onto the composite so far with the
 * render's per-mode maths (`./blend-glsl.ts`) and mixed by its alpha
 * (`out = base + (blend(base, layer) − base) · alpha`, as
 * `compositePixel` and the render's `alphamerge` + `overlay` do).
 *
 * The composite lives in 8-bit ping-pong framebuffers, like the render's
 * 8-bit planes. Clips with key, grade or effects passes run them first in
 * their own `createGlPipeline` (the same shaders the per-clip preview uses)
 * and the compositor samples that output.
 */
import type { PreviewQuality } from "../../editor/store.ts";
import {
	createGlPipeline,
	type GlPipeline,
	type GlSource,
	glSourceSize,
	glVertexShader,
} from "../gl/pipeline.ts";
import { previewCanvasSize } from "../quality.ts";
import { blendFunctionGlsl } from "./blend-glsl.ts";
import { MaskRasters, rasterizeMasks } from "./mask-rasters.ts";
import type { CompositorLayer, CompositorPlan } from "./plan.ts";

/**
 * How stale a clip's input may be and still be drawn: how long a clip that
 * had a frame may keep its last uploaded picture while the current one is
 * not ready (a re-seek dropping a video below HAVE_CURRENT_DATA), and how
 * old the previous mask raster drawn while the current one decodes may be.
 * Past this the frame is `waiting` and the caller falls back to the CSS
 * stack.
 */
export const STALE_INPUT_LIMIT_MS = 250;

const backgroundFragment = `#version 300 es
precision highp float;
uniform vec2 u_canvas;
uniform vec2 u_project;
uniform float u_gradient;
uniform vec3 u_from;
uniform vec3 u_to;
uniform vec3 u_coefficients;
out vec4 outColor;
void main() {
	vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y) * (u_project / u_canvas);
	vec2 pixel = floor(p);
	float t = clamp(dot(u_coefficients, vec3(pixel, 1.0)), 0.0, 1.0);
	outColor = vec4(u_gradient > 0.5 ? mix(u_from, u_to, t) : u_from, 1.0);
}
`;

const copyFragment = `#version 300 es
precision highp float;
uniform sampler2D u_base;
out vec4 outColor;
void main() {
	outColor = texelFetch(u_base, ivec2(gl_FragCoord.xy), 0);
}
`;

/** The layer pass; `blendColor` comes from `blendFunctionGlsl`. */
function layerFragment(layer: Pick<CompositorLayer, "mode">): string {
	return `#version 300 es
precision highp float;
uniform sampler2D u_base;
uniform sampler2D u_layer;
uniform sampler2D u_mask;
uniform float u_hasMask;
uniform vec2 u_canvas;
uniform vec2 u_project;
uniform vec2 u_center;
uniform vec2 u_drawn;
uniform float u_rotation;
uniform float u_clipUnrotated;
uniform vec2 u_flip;
uniform vec4 u_source;
uniform vec4 u_visible;
uniform vec4 u_maskWindow;
uniform float u_opacity;
out vec4 outColor;
${blendFunctionGlsl(layer.mode)}
float insideUnit(vec2 q) {
	return step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
}
void main() {
	vec4 base = texelFetch(u_base, ivec2(gl_FragCoord.xy), 0);
	// Project pixel at this fragment's centre, y down.
	vec2 p = vec2(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y) * (u_project / u_canvas);
	vec2 d = p - u_center;
	float c = cos(u_rotation);
	float s = sin(u_rotation);
	// Undo the clockwise rotation, then place in the drawn picture (0..1).
	vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / u_drawn + 0.5;
	float inside = insideUnit(q);
	if (u_clipUnrotated > 0.5) {
		inside *= insideUnit(d / u_drawn + 0.5);
	}
	// Masks are drawn on the flipped frame; the source is sampled unflipped.
	vec2 m = u_maskWindow.xy + q * u_maskWindow.zw;
	vec2 qs = mix(q, 1.0 - q, u_flip);
	vec2 uv = u_source.xy + qs * u_source.zw;
	inside *= step(u_visible.x, uv.x) * step(uv.x, u_visible.z) *
		step(u_visible.y, uv.y) * step(uv.y, u_visible.w);
	vec4 layer = texture(u_layer, uv);
	float mask = u_hasMask > 0.5 ? texture(u_mask, m).a : 1.0;
	float alpha = clamp(layer.a * u_opacity * mask * inside, 0.0, 1.0);
	vec3 below = clamp(base.rgb, 0.0, 1.0);
	vec3 blended = blendColor(below, clamp(layer.rgb, 0.0, 1.0));
	outColor = vec4(below + (blended - below) * alpha, 1.0);
}
`;
}

interface Program {
	program: WebGLProgram;
	uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Target {
	framebuffer: WebGLFramebuffer;
	texture: WebGLTexture;
}

interface LayerResources {
	/** Whether `texture` holds a frame of this clip (it may be stale). */
	hasFrame: boolean;
	maskKey?: HTMLCanvasElement;
	maskTexture: WebGLTexture;
	/** Offscreen canvas and pipeline for the clip's key/grade/effects passes. */
	passes?: { canvas: HTMLCanvasElement; pipeline: GlPipeline | null };
	/** When the clip first drew its previous picture in a row. */
	staleSince?: number;
	/** The still image last uploaded, and its URL (re-uploaded when either changes). */
	still?: { element: GlSource; src: string };
	texture: WebGLTexture;
}

/** What `render` did. */
export type CompositorDraw =
	/** The frame was drawn from every clip's current picture and mask. */
	| "drawn"
	/**
	 * The frame was drawn, but a clip whose current picture or mask is not
	 * ready yet drew its previous one (for at most `STALE_INPUT_LIMIT_MS`).
	 */
	| "stale"
	/**
	 * A clip's media or mask has no usable frame; nothing was drawn and the
	 * canvas still holds its previous frame, so the caller should hide it.
	 */
	| "waiting";

export interface BlendCompositor {
	dispose(): void;
	render(
		plan: Extract<CompositorPlan, { active: true }>,
		sourceOf: (layer: CompositorLayer) => GlSource | null | undefined,
		quality?: PreviewQuality,
		/** Clock for `STALE_INPUT_LIMIT_MS`, in milliseconds. */
		now?: number
	): CompositorDraw;
}

function compile(
	gl: WebGL2RenderingContext,
	type: number,
	source: string
): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) {
		throw new Error("WebGL could not allocate a shader.");
	}
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader) ?? "unknown error";
		gl.deleteShader(shader);
		throw new Error(`Blend compositor shader failed to compile: ${log}`);
	}
	return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string): Program {
	const program = gl.createProgram();
	const vertex = compile(gl, gl.VERTEX_SHADER, glVertexShader);
	const shader = compile(gl, gl.FRAGMENT_SHADER, fragment);
	gl.attachShader(program, vertex);
	gl.attachShader(program, shader);
	gl.linkProgram(program);
	gl.deleteShader(vertex);
	gl.deleteShader(shader);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program) ?? "unknown error";
		gl.deleteProgram(program);
		throw new Error(`Blend compositor shader failed to link: ${log}`);
	}
	return { program, uniforms: new Map() };
}

function newTexture(gl: WebGL2RenderingContext): WebGLTexture {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return texture;
}

function upload(
	gl: WebGL2RenderingContext,
	texture: WebGLTexture,
	source: TexImageSource
) {
	gl.bindTexture(gl.TEXTURE_2D, texture);
	// Row 0 is the top of the picture; colour is straight and unconverted,
	// so pixels reach the blend maths exactly as decoded.
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/**
 * A compositor on `canvas`, or null when WebGL2 is unavailable. `onReady` is
 * called when an asynchronous input (a mask raster) becomes available, so
 * a paused preview can draw again.
 */
export function createBlendCompositor(
	canvas: HTMLCanvasElement,
	onReady: () => void
): BlendCompositor | null {
	const gl = canvas.getContext("webgl2", {
		alpha: false,
		antialias: false,
		premultipliedAlpha: false,
		// Keeps the shown frame readable (frame grabs, parity tests).
		preserveDrawingBuffer: true,
	});
	if (!gl) {
		return null;
	}
	const programs = new Map<string, Program>();
	const layers = new Map<string, LayerResources>();
	const masks = new MaskRasters(onReady, rasterizeMasks);
	let targets: Target[] = [];
	let targetSize = { height: 0, width: 0 };

	const programOf = (key: string, fragment: () => string): Program => {
		let entry = programs.get(key);
		if (!entry) {
			entry = link(gl, fragment());
			programs.set(key, entry);
		}
		return entry;
	};
	const uniform = (entry: Program, name: string) => {
		if (!entry.uniforms.has(name)) {
			entry.uniforms.set(name, gl.getUniformLocation(entry.program, name));
		}
		return entry.uniforms.get(name) ?? null;
	};
	const ensureTargets = (width: number, height: number) => {
		if (
			targets.length === 2 &&
			targetSize.width === width &&
			targetSize.height === height
		) {
			return;
		}
		for (const target of targets) {
			gl.deleteFramebuffer(target.framebuffer);
			gl.deleteTexture(target.texture);
		}
		targets = [];
		targetSize = { height, width };
		for (let index = 0; index < 2; index++) {
			const texture = newTexture(gl);
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA8,
				width,
				height,
				0,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				null
			);
			const framebuffer = gl.createFramebuffer();
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(
				gl.FRAMEBUFFER,
				gl.COLOR_ATTACHMENT0,
				gl.TEXTURE_2D,
				texture,
				0
			);
			targets.push({ framebuffer, texture });
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	};
	const resourcesOf = (segmentId: string): LayerResources => {
		let entry = layers.get(segmentId);
		if (!entry) {
			entry = {
				hasFrame: false,
				maskTexture: newTexture(gl),
				texture: newTexture(gl),
			};
			layers.set(segmentId, entry);
		}
		return entry;
	};
	const releaseLayer = (entry: LayerResources) => {
		gl.deleteTexture(entry.texture);
		gl.deleteTexture(entry.maskTexture);
		entry.passes?.pipeline?.dispose();
	};

	/** Upload the layer's picture; false while it has no frame. */
	const uploadLayer = (
		layer: CompositorLayer,
		entry: LayerResources,
		source: GlSource,
		quality: PreviewQuality
	): boolean => {
		if (!glSourceSize(source)) {
			return false;
		}
		if (layer.glPasses.length > 0) {
			if (!entry.passes) {
				const passCanvas = document.createElement("canvas");
				entry.passes = {
					canvas: passCanvas,
					pipeline: createGlPipeline(passCanvas),
				};
			}
			const { canvas: passCanvas, pipeline } = entry.passes;
			if (!pipeline?.render(source, layer.glPasses, layer.elapsed, quality)) {
				return false;
			}
			upload(gl, entry.texture, passCanvas);
			entry.still = undefined;
			return true;
		}
		if ("videoWidth" in source) {
			upload(gl, entry.texture, source);
			entry.still = undefined;
			return true;
		}
		const src = source.currentSrc || source.src;
		if (!(entry.still?.element === source && entry.still.src === src)) {
			upload(gl, entry.texture, source);
			entry.still = { element: source, src };
		}
		return true;
	};

	const drawFullFrame = (target: Target | null) => {
		gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	};

	return {
		dispose() {
			for (const entry of layers.values()) {
				releaseLayer(entry);
			}
			layers.clear();
			for (const entry of programs.values()) {
				gl.deleteProgram(entry.program);
			}
			programs.clear();
			for (const target of targets) {
				gl.deleteFramebuffer(target.framebuffer);
				gl.deleteTexture(target.texture);
			}
			targets = [];
		},
		render(plan, sourceOf, quality = "full", now = performance.now()) {
			const size =
				quality === "full"
					? { height: plan.height, width: plan.width }
					: previewCanvasSize(plan.width, plan.height, quality);
			// Every input must be usable first, so a half-loaded stack never
			// replaces the last good frame. A clip that drew before may reuse
			// its last picture or mask briefly (a re-seek, a mask decoding).
			const ready: { entry: LayerResources; layer: CompositorLayer }[] = [];
			let stale = false;
			for (const layer of plan.layers) {
				if (layer.drawn[0] <= 0 || layer.drawn[1] <= 0 || layer.opacity <= 0) {
					continue;
				}
				// A clip without a media element (no source URL) is not drawn,
				// as in the CSS stack.
				const source = sourceOf(layer);
				if (!source) {
					continue;
				}
				const entry = resourcesOf(layer.segmentId);
				if (uploadLayer(layer, entry, source, quality)) {
					entry.hasFrame = true;
					entry.staleSince = undefined;
				} else if (entry.hasFrame) {
					entry.staleSince ??= now;
					if (now - entry.staleSince > STALE_INPUT_LIMIT_MS) {
						return "waiting";
					}
					stale = true;
				} else {
					return "waiting";
				}
				if (layer.masks.list.length > 0) {
					const mask = masks.get(
						layer.segmentId,
						layer.masks.frame,
						layer.masks.list,
						now
					);
					if (!mask || mask.age > STALE_INPUT_LIMIT_MS) {
						return "waiting";
					}
					stale ||= !mask.exact;
					if (entry.maskKey !== mask.raster) {
						upload(gl, entry.maskTexture, mask.raster);
						entry.maskKey = mask.raster;
					}
				}
				ready.push({ entry, layer });
			}
			const onScreen = new Set(plan.layers.map((layer) => layer.segmentId));
			masks.retain(onScreen);
			for (const [segmentId, entry] of layers) {
				if (!onScreen.has(segmentId)) {
					releaseLayer(entry);
					layers.delete(segmentId);
				}
			}
			if (canvas.width !== size.width || canvas.height !== size.height) {
				canvas.width = size.width;
				canvas.height = size.height;
			}
			ensureTargets(size.width, size.height);
			gl.viewport(0, 0, size.width, size.height);
			gl.disable(gl.BLEND);

			const background = programOf("background", () => backgroundFragment);
			gl.useProgram(background.program);
			gl.uniform2f(uniform(background, "u_canvas"), size.width, size.height);
			gl.uniform2f(uniform(background, "u_project"), plan.width, plan.height);
			const fill = plan.background;
			gl.uniform1f(
				uniform(background, "u_gradient"),
				fill.type === "gradient" ? 1 : 0
			);
			const from = fill.type === "gradient" ? fill.from : fill.color;
			gl.uniform3f(uniform(background, "u_from"), from[0], from[1], from[2]);
			if (fill.type === "gradient") {
				gl.uniform3f(uniform(background, "u_to"), ...fill.to);
				gl.uniform3f(
					uniform(background, "u_coefficients"),
					...fill.coefficients
				);
			}
			let current = 0;
			drawFullFrame(targets[current] ?? null);

			for (const { entry, layer } of ready) {
				const next = 1 - current;
				const program = programOf(`layer:${layer.mode}`, () =>
					layerFragment(layer)
				);
				gl.useProgram(program.program);
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, targets[current]?.texture ?? null);
				gl.uniform1i(uniform(program, "u_base"), 0);
				gl.activeTexture(gl.TEXTURE1);
				gl.bindTexture(gl.TEXTURE_2D, entry.texture);
				gl.uniform1i(uniform(program, "u_layer"), 1);
				gl.activeTexture(gl.TEXTURE2);
				gl.bindTexture(gl.TEXTURE_2D, entry.maskTexture);
				gl.uniform1i(uniform(program, "u_mask"), 2);
				gl.uniform1f(
					uniform(program, "u_hasMask"),
					layer.masks.list.length > 0 ? 1 : 0
				);
				gl.uniform2f(uniform(program, "u_canvas"), size.width, size.height);
				gl.uniform2f(uniform(program, "u_project"), plan.width, plan.height);
				gl.uniform2f(uniform(program, "u_center"), ...layer.center);
				gl.uniform2f(uniform(program, "u_drawn"), ...layer.drawn);
				gl.uniform1f(uniform(program, "u_rotation"), layer.rotation);
				gl.uniform1f(
					uniform(program, "u_clipUnrotated"),
					layer.clipUnrotated ? 1 : 0
				);
				gl.uniform2f(
					uniform(program, "u_flip"),
					layer.flip[0] ? 1 : 0,
					layer.flip[1] ? 1 : 0
				);
				const { source, visible, maskWindow } = layer;
				gl.uniform4f(
					uniform(program, "u_source"),
					source.left,
					source.top,
					source.width,
					source.height
				);
				gl.uniform4f(
					uniform(program, "u_visible"),
					visible.left,
					visible.top,
					visible.left + visible.width,
					visible.top + visible.height
				);
				gl.uniform4f(
					uniform(program, "u_maskWindow"),
					maskWindow.left,
					maskWindow.top,
					maskWindow.width,
					maskWindow.height
				);
				gl.uniform1f(uniform(program, "u_opacity"), layer.opacity);
				drawFullFrame(targets[next] ?? null);
				current = next;
			}

			const copy = programOf("copy", () => copyFragment);
			gl.useProgram(copy.program);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, targets[current]?.texture ?? null);
			gl.uniform1i(uniform(copy, "u_base"), 0);
			drawFullFrame(null);
			return stale ? "stale" : "drawn";
		},
	};
}
