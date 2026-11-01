import { z } from "zod";
import type { Asset } from "../../shared/project.ts";

export const generatedMediaResponseSchema = z.json();
export type GeneratedMediaResponse = z.infer<
	typeof generatedMediaResponseSchema
>;
const generatedMediaCandidateSchema = z.union([
	z.string(),
	z.object({ url: z.string() }).transform(({ url }) => url),
]);

export function generatedDataUrl(
	value: GeneratedMediaResponse | undefined,
	kind: Asset["kind"]
): string {
	const candidates = Array.isArray(value) ? value : [value];
	for (const candidate of candidates.slice(0, 16)) {
		const parsed = generatedMediaCandidateSchema.safeParse(candidate);
		if (
			parsed.success &&
			parsed.data.startsWith(`data:${kind}/`) &&
			parsed.data.includes(";base64,")
		) {
			return parsed.data;
		}
	}
	throw new Error(
		"Ryu did not return usable generated media. Check the selected model and try again."
	);
}
