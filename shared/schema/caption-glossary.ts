import { z } from "zod";

/** Most wrong→right pairs one project keeps. */
export const MAX_GLOSSARY_ENTRIES = 200;

/**
 * One "fix names and terms" pair: every whole-word (or whole-phrase) match
 * of `from`, ignoring case, becomes `to` exactly as written.
 */
export const glossaryEntrySchema = z
	.object({
		from: z.string().trim().min(1).max(100),
		to: z.string().trim().min(1).max(100),
	})
	.strict();
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export const captionGlossarySchema = z
	.array(glossaryEntrySchema)
	.max(MAX_GLOSSARY_ENTRIES);
