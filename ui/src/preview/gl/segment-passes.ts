import type { Segment } from "../../../../shared/project.ts";
import { type GlPass, orderedGlPasses } from "./pass.ts";
import { effectsPass } from "./passes/effects.ts";
import { gradePass } from "./passes/grade.ts";
import { keyPass } from "./passes/key.ts";

/** The active WebGL passes for a clip, in render order. Empty means "no GL". */
export function segmentGlPasses(segment: Segment, elapsed: number): GlPass[] {
	return orderedGlPasses({
		effects: effectsPass(segment, elapsed),
		grade: gradePass(segment, elapsed),
		key: keyPass(segment, elapsed),
	});
}
