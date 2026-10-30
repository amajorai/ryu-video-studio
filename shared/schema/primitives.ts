import { z } from "zod";

/** Seconds on the project timeline (two-hour ceiling). */
export const timeSchema = z.number().finite().min(0).max(7200);
export const idSchema = z.uuid();
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A finite number bounded to `[min, max]`. */
export const bounded = (min: number, max: number) =>
	z.number().finite().min(min).max(max);
