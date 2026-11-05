import type { PreviewQuality } from "../../editor/store.ts";
import { previewCanvasSize } from "../quality.ts";
import type { GlPass, GlUniformValue } from "./pass.ts";

/**
 * Minimal WebGL2 pass runner for the preview. The clip's media is uploaded
 * once per draw, then each pass renders a full-frame triangle into a
 * ping-pong framebuffer; the last pass draws to the canvas.
 */

export const glVertexShader = `#version 300 es
out vec2 v_uv;
void main() {
	vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	v_uv = corner;
	gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const fragmentHeader = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_time;
in vec2 v_uv;
out vec4 outColor;
`;

/** The complete fragment shader source for a pass. */
export function glFragmentSource(pass: Pick<GlPass, "fragment">): string {
	return `${fragmentHeader}${pass.fragment}`;
}

export type GlSource = HTMLVideoElement | HTMLImageElement;

/** Pixel size of a media element, or null while it has no decodable frame. */
export function glSourceSize(
	source: GlSource
): { height: number; width: number } | null {
	if ("videoWidth" in source) {
		// HAVE_CURRENT_DATA: a frame is available to upload.
		return source.readyState >= 2 && source.videoWidth > 0
			? { height: source.videoHeight, width: source.videoWidth }
			: null;
	}
	return source.complete && source.naturalWidth > 0
		? { height: source.naturalHeight, width: source.naturalWidth }
		: null;
}

export interface GlPipeline {
	dispose(): void;
	/**
	 * Draw one frame. `time` is the clip-relative time in seconds (`u_time`).
	 * Returns false when the source has no frame yet.
	 */
	render(
		source: GlSource,
		passes: readonly GlPass[],
		time: number,
		/** Preview quality; below full the canvas is `previewCanvasSize` of the source. */
		quality?: PreviewQuality
	): boolean;
}

interface CompiledPass {
	program: WebGLProgram;
	uniforms: Map<string, WebGLUniformLocation | null>;
}

interface Target {
	framebuffer: WebGLFramebuffer;
	texture: WebGLTexture;
}

function compileShader(
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
		throw new Error(`Preview shader failed to compile: ${log}`);
	}
	return shader;
}

function linkProgram(
	gl: WebGL2RenderingContext,
	fragment: string
): WebGLProgram {
	const program = gl.createProgram();
	const vertexShader = compileShader(gl, gl.VERTEX_SHADER, glVertexShader);
	const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);
	gl.deleteShader(vertexShader);
	gl.deleteShader(fragmentShader);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program) ?? "unknown error";
		gl.deleteProgram(program);
		throw new Error(`Preview shader failed to link: ${log}`);
	}
	return program;
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return texture;
}

function setUniform(
	gl: WebGL2RenderingContext,
	location: WebGLUniformLocation | null,
	value: GlUniformValue
) {
	if (!location) {
		return;
	}
	if (typeof value === "number") {
		gl.uniform1f(location, value);
	} else if (value.length === 2) {
		gl.uniform2f(location, value[0], value[1]);
	} else if (value.length === 3) {
		gl.uniform3f(location, value[0], value[1], value[2]);
	} else {
		gl.uniform4f(location, value[0], value[1], value[2], value[3]);
	}
}

/** Create a pipeline on `canvas`, or null when WebGL2 is unavailable. */
export function createGlPipeline(canvas: HTMLCanvasElement): GlPipeline | null {
	const gl = canvas.getContext("webgl2", {
		antialias: false,
		premultipliedAlpha: false,
		preserveDrawingBuffer: false,
	});
	if (!gl) {
		return null;
	}
	const programs = new Map<string, CompiledPass>();
	const sourceTexture = createTexture(gl);
	let targets: Target[] = [];
	let targetSize = { height: 0, width: 0 };

	const compiled = (pass: GlPass): CompiledPass => {
		const key = `${pass.id}\n${pass.fragment}`;
		let entry = programs.get(key);
		if (!entry) {
			entry = {
				program: linkProgram(gl, glFragmentSource(pass)),
				uniforms: new Map(),
			};
			programs.set(key, entry);
		}
		return entry;
	};
	const location = (entry: CompiledPass, name: string) => {
		if (!entry.uniforms.has(name)) {
			entry.uniforms.set(name, gl.getUniformLocation(entry.program, name));
		}
		return entry.uniforms.get(name) ?? null;
	};
	const releaseTargets = () => {
		for (const target of targets) {
			gl.deleteFramebuffer(target.framebuffer);
			gl.deleteTexture(target.texture);
		}
		targets = [];
	};
	const ensureTargets = (width: number, height: number) => {
		if (
			targets.length === 2 &&
			targetSize.width === width &&
			targetSize.height === height
		) {
			return;
		}
		releaseTargets();
		targetSize = { height, width };
		for (let index = 0; index < 2; index++) {
			const texture = createTexture(gl);
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA,
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

	return {
		dispose() {
			releaseTargets();
			for (const entry of programs.values()) {
				gl.deleteProgram(entry.program);
			}
			programs.clear();
			gl.deleteTexture(sourceTexture);
		},
		render(source, passes, time, quality = "full") {
			const sourceSize = glSourceSize(source);
			if (!sourceSize || passes.length === 0) {
				return false;
			}
			const size =
				quality === "full"
					? sourceSize
					: previewCanvasSize(sourceSize.width, sourceSize.height, quality);
			if (canvas.width !== size.width || canvas.height !== size.height) {
				canvas.width = size.width;
				canvas.height = size.height;
			}
			if (passes.length > 1) {
				ensureTargets(size.width, size.height);
			}
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
			// Flip so texture row 0 is the bottom, matching framebuffer output.
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
			gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				source
			);
			gl.viewport(0, 0, size.width, size.height);
			let input = sourceTexture;
			for (const [index, pass] of passes.entries()) {
				const last = index === passes.length - 1;
				const target = last ? null : (targets[index % 2] ?? null);
				gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
				const entry = compiled(pass);
				gl.useProgram(entry.program);
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, input);
				gl.uniform1i(location(entry, "u_source"), 0);
				gl.uniform2f(location(entry, "u_resolution"), size.width, size.height);
				gl.uniform1f(location(entry, "u_time"), time);
				for (const [name, value] of Object.entries(pass.uniforms)) {
					setUniform(gl, location(entry, name), value);
				}
				gl.drawArrays(gl.TRIANGLES, 0, 3);
				if (target) {
					input = target.texture;
				}
			}
			return true;
		},
	};
}
