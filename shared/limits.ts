import { z } from "zod";

/** Highest zero-based timeline track index (32 tracks). */
export const MAX_TRACK_INDEX = 31;
/** Number of addressable timeline tracks. */
export const MAX_TRACKS = MAX_TRACK_INDEX + 1;
/** Timeline clips per project. */
export const MAX_SEGMENTS = 5000;
/** Titles or graphics per project (each list is bounded separately). */
export const MAX_OVERLAYS = 1000;
/**
 * Largest clip offset `x`/`y`, in canvas half-widths (half-heights). Beyond
 * ±1 a clip's centre leaves the canvas; a box wider than the canvas (an auto
 * reframe pan box) needs the extra reach to bring its far edge into view.
 */
export const MAX_CLIP_OFFSET = 3;
/** Longest canvas edge, in pixels. */
export const MAX_CANVAS = 8192;
/**
 * Longest edge of a local Lanczos upscale derivative. Upscales stay at UHD on
 * purpose: the bound protects memory and render time, not the canvas size.
 */
export const MAX_UPSCALE_EDGE = 3840;

export const trackIndexSchema = z.number().int().min(0).max(MAX_TRACK_INDEX);
