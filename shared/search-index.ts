import { z } from "zod";
import type { Asset } from "./project.ts";
import type { Transcript } from "./transcript.ts";

export const searchDocumentSchema = z
	.object({
		format: z.literal("ryu.video-studio.transcript.v1"),
		assetId: z.uuid(),
		transcriptRevision: z.number().int().nonnegative(),
		start: z.number().min(0).max(7200),
		end: z.number().min(0).max(7200),
		text: z.string().min(1).max(8000),
	})
	.strict();
export const indexEntrySchema = z
	.object({
		key: z.string().min(1).max(100),
		title: z.string().min(1).max(300),
		source: z.string().max(12_000),
		docId: z.string().min(1).max(200).nullable(),
		ready: z.boolean(),
	})
	.strict();
export const searchIndexSchema = z
	.object({
		assetId: z.uuid(),
		spaceId: z.string().min(1).max(200),
		spaceName: z.string().min(1).max(200),
		transcriptRevision: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
		entries: z.array(indexEntrySchema).max(400),
		obsolete: z.array(indexEntrySchema).max(800),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export type SearchIndex = z.infer<typeof searchIndexSchema>;
export type SearchDocument = z.infer<typeof searchDocumentSchema>;
export function transcriptDocuments(asset: Asset, transcript: Transcript) {
	if (transcript.status !== "completed" || !transcript.cues.length) {
		throw new Error("Complete or import a source transcript before indexing.");
	}
	const groups: SearchDocument[] = [];
	for (const cue of [...transcript.cues].sort((a, b) => a.start - b.start)) {
		const last = groups.at(-1);
		if (
			last &&
			cue.end - last.start <= 30 &&
			last.text.length + cue.text.length < 8000
		) {
			last.end = Math.max(last.end, cue.end);
			last.text += `\n${cue.text}`;
		} else {
			groups.push({
				format: "ryu.video-studio.transcript.v1",
				assetId: asset.id,
				transcriptRevision: transcript.revision,
				start: cue.start,
				end: cue.end,
				text: cue.text,
			});
		}
	}
	if (groups.length > 400) {
		throw new Error("This transcript exceeds the searchable segment limit.");
	}
	return groups.map((group, index) => ({
		key: `${transcript.revision}:${index}`,
		title: `${asset.name} · ${group.start.toFixed(1)}–${group.end.toFixed(1)}s`,
		source: JSON.stringify(group),
		docId: null,
		ready: false,
	}));
}
export function verifiedSearchDocument(
	index: SearchIndex,
	docId: string,
	source: string
): SearchDocument | null {
	const entry = index.entries.find(
		(value) => value.ready && value.docId === docId
	);
	if (!entry || entry.source !== source) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return null;
	}
	const parsed = searchDocumentSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.assetId !== index.assetId ||
		parsed.data.transcriptRevision !== index.transcriptRevision ||
		parsed.data.end <= parsed.data.start
	) {
		return null;
	}
	return parsed.data;
}
