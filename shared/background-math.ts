/**
 * Gradient and blur-fill math for canvas backgrounds (see `background.ts`).
 * Everything here is pure and deterministic.
 */

/** Gaussian sigma, in canvas pixels, of a blur fill at `amount` 1. */
export const BLUR_SIGMA_PER_AMOUNT = 60;

/**
 * Width of the working grid the blur fill is computed on. Filling and
 * blurring a small grid is cheap and already soft; the result is scaled up.
 */
export const BLUR_GRID_WIDTH = 96;

/** Width of the grid a gradient is evaluated on before it is scaled up. */
export const GRADIENT_GRID_WIDTH = 64;

export const round = (value: number, digits = 6) => {
	const rounded = Number(value.toFixed(digits));
	return Object.is(rounded, -0) ? 0 : rounded;
};

export interface Rgb {
	b: number;
	g: number;
	r: number;
}

/** `#rrggbb` to 0..255 channels. */
export function hexToRgb(hex: string): Rgb {
	const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
	if (!match) {
		throw new Error(`Expected a #rrggbb color, got ${hex}.`);
	}
	return {
		b: Number.parseInt(match[3] ?? "0", 16),
		g: Number.parseInt(match[2] ?? "0", 16),
		r: Number.parseInt(match[1] ?? "0", 16),
	};
}

/** Start and end of a CSS gradient line, in pixels of a `width`x`height` frame. */
export interface GradientLine {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

/**
 * The CSS gradient line for `angle` degrees: it passes through the frame
 * center, points along `(sin a, -cos a)` (y grows downwards) and is long
 * enough that the two corners farthest along it land exactly on the stops.
 */
export function gradientLine(
	angle: number,
	width: number,
	height: number
): GradientLine {
	const radians = (angle * Math.PI) / 180;
	const dx = Math.sin(radians);
	const dy = -Math.cos(radians);
	const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
	return {
		x0: round(width / 2 - dx * half),
		x1: round(width / 2 + dx * half),
		y0: round(height / 2 - dy * half),
		y1: round(height / 2 + dy * half),
	};
}

/** Position (0 at the first stop, 1 at the second) of point x, y on a line. */
export function gradientPosition(
	line: GradientLine,
	x: number,
	y: number
): number {
	const lx = line.x1 - line.x0;
	const ly = line.y1 - line.y0;
	const lengthSquared = lx * lx + ly * ly;
	if (lengthSquared === 0) {
		return 0;
	}
	const t = ((x - line.x0) * lx + (y - line.y0) * ly) / lengthSquared;
	return Math.min(1, Math.max(0, t));
}

/** Linear coefficients of the gradient position over grid pixel indices. */
export interface GradientCoefficients {
	/** Per grid column. */
	a: number;
	/** Per grid row. */
	b: number;
	/** At grid pixel 0, 0. */
	c: number;
}

/**
 * The gradient position at the center of grid pixel (X, Y) is
 * `a*X + b*Y + c` when a `width`x`height` frame is sampled on a
 * `gridWidth`x`gridHeight` grid. The position is linear over the frame, so a
 * small grid scaled up bilinearly reproduces the full-size gradient.
 */
export function gradientCoefficients(
	angle: number,
	frame: { height: number; width: number },
	grid: { height: number; width: number }
): GradientCoefficients {
	const line = gradientLine(angle, frame.width, frame.height);
	const lx = line.x1 - line.x0;
	const ly = line.y1 - line.y0;
	const lengthSquared = lx * lx + ly * ly;
	const stepX = frame.width / grid.width;
	const stepY = frame.height / grid.height;
	return {
		a: round((stepX * lx) / lengthSquared, 9),
		b: round((stepY * ly) / lengthSquared, 9),
		c: round(
			((stepX / 2 - line.x0) * lx + (stepY / 2 - line.y0) * ly) / lengthSquared,
			9
		),
	};
}

/** Grid a gradient is evaluated on for a frame: fixed width, frame aspect. */
export function gradientGrid(
	width: number,
	height: number
): { height: number; width: number } {
	const gridWidth = Math.min(width, GRADIENT_GRID_WIDTH);
	return {
		height: Math.min(
			height,
			Math.max(2, Math.round((gridWidth * height) / width))
		),
		width: gridWidth,
	};
}

/** Gaussian sigma of a blur fill, in canvas pixels. */
export function blurSigma(amount: number): number {
	return round(amount * BLUR_SIGMA_PER_AMOUNT, 4);
}

/** Brightness multiplier of a blur fill (1 keeps it, 0 is black). */
export function blurBrightness(dim: number): number {
	return round(1 - dim, 4);
}

/**
 * Grid sizes of the blur fill's push-pull pyramid: the working grid (at most
 * `BLUR_GRID_WIDTH` wide, frame aspect), then halved (rounding up) down to
 * a single pixel.
 */
export function pushPullLevels(
	width: number,
	height: number,
	gridWidth = BLUR_GRID_WIDTH
): Array<{ height: number; width: number }> {
	const first = Math.max(1, Math.min(width, gridWidth));
	let level = {
		height: Math.max(1, Math.min(height, Math.round((first * height) / width))),
		width: first,
	};
	const levels = [level];
	while (level.width > 1 || level.height > 1) {
		level = {
			height: Math.ceil(level.height / 2),
			width: Math.ceil(level.width / 2),
		};
		levels.push(level);
	}
	return levels;
}
