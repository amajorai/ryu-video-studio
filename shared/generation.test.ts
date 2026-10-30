import { describe, expect, test } from "bun:test";
import {
	aiEditRequest,
	type GenerationJob,
	generatedAssetStamp,
	generatedMediaFileName,
	generationJobSchema,
	generationProvenance,
	generationRequestLabel,
	generationRequestSchema,
	MAX_REFERENCE_IMAGES,
	referenceImageIds,
	regenerationRequest,
	requestInputImageIds,
	stampGeneratedAsset,
} from "./generation.ts";
import { type Asset, assetSchema } from "./project.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function image(name: string): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 5,
		hasAudio: false,
		height: 720,
		id: crypto.randomUUID(),
		kind: "image",
		name,
		width: 1280,
	};
}

function job(
	request: Parameters<typeof generationRequestSchema.parse>[0],
	assetIds: string[],
	updatedAt = "2026-01-01T00:00:00.000Z",
	status: GenerationJob["status"] = "completed"
): GenerationJob {
	const parsed = generationRequestSchema.parse(request);
	return generationJobSchema.parse({
		assetIds,
		createdAt: updatedAt,
		id: parsed.id,
		message: "",
		projectRevision: 1,
		request: parsed,
		status,
		updatedAt,
	});
}

describe("generation request schema", () => {
	test("legacy requests parse without the AI edit fields", () => {
		const request = generationRequestSchema.parse({
			id: crypto.randomUUID(),
			kind: "image",
			projectId: PROJECT,
			prompt: "A harbor at dusk",
		});
		expect("purpose" in request).toBe(false);
		expect("sourceAssetId" in request).toBe(false);
		expect("inputAssetIds" in request).toBe(false);
		// The sidecar's idempotency check compares serialized requests.
		expect(JSON.stringify(generationRequestSchema.parse(request))).toBe(
			JSON.stringify(request)
		);
	});

	test("only image requests take a source still or references", () => {
		const base = {
			id: crypto.randomUUID(),
			kind: "video" as const,
			projectId: PROJECT,
			prompt: "Waves",
		};
		expect(() =>
			generationRequestSchema.parse({
				...base,
				sourceAssetId: crypto.randomUUID(),
			})
		).toThrow("source still");
		expect(() =>
			generationRequestSchema.parse({
				...base,
				inputAssetIds: [crypto.randomUUID()],
			})
		).toThrow("image references");
	});

	test("references are capped at four", () => {
		expect(() =>
			generationRequestSchema.parse({
				id: crypto.randomUUID(),
				inputAssetIds: Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, () =>
					crypto.randomUUID()
				),
				kind: "image",
				projectId: PROJECT,
				prompt: "Collage",
			})
		).toThrow();
	});
});

describe("referenceImageIds", () => {
	test("keeps order, removes duplicates and the edited still", () => {
		const [a, b, source] = [image("a"), image("b"), image("source")];
		expect(
			referenceImageIds(
				[a, b, source],
				[b.id, a.id, b.id, source.id],
				source.id
			)
		).toEqual([b.id, a.id]);
	});

	test("rejects missing media, non-images, and more than four", () => {
		const still = image("still");
		const video: Asset = { ...image("clip"), kind: "video" };
		expect(() => referenceImageIds([still], [crypto.randomUUID()])).toThrow(
			"no longer in the library"
		);
		expect(() => referenceImageIds([video], [video.id])).toThrow(
			"still images"
		);
		const five = Array.from({ length: 5 }, (_, index) => image(`${index}`));
		expect(() =>
			referenceImageIds(
				five,
				five.map((asset) => asset.id)
			)
		).toThrow("at most 4");
	});
});

describe("aiEditRequest", () => {
	test("shapes an image edit with the source first, then references", () => {
		const source = crypto.randomUUID();
		const reference = crypto.randomUUID();
		const request = aiEditRequest({
			id: crypto.randomUUID(),
			projectId: PROJECT,
			prompt: "Make it snow",
			purpose: "ai-edit",
			referenceAssetIds: [reference],
			sourceAssetId: source,
		});
		expect(request.kind).toBe("image");
		expect(request.purpose).toBe("ai-edit");
		expect(requestInputImageIds(request)).toEqual([source, reference]);
		expect(generationRequestLabel(request)).toBe("AI edit · Image");
		expect(generatedMediaFileName(request)).toBe("AI edit — Make it snow.png");
	});

	test("omits references when there are none", () => {
		const request = aiEditRequest({
			id: crypto.randomUUID(),
			projectId: PROJECT,
			prompt: "Warmer light",
			purpose: "edit-frame",
			sourceAssetId: crypto.randomUUID(),
		});
		expect("inputAssetIds" in request).toBe(false);
		expect(generationRequestLabel(request)).toBe("Edited frame · Image");
	});
});

describe("generationProvenance", () => {
	test("is undefined for media that was not generated", () => {
		expect(generationProvenance(image("plain"), [])).toBeUndefined();
	});

	test("prefers the asset's own generation metadata", () => {
		const source = crypto.randomUUID();
		const reference = crypto.randomUUID();
		const asset: Asset = {
			...image("edited"),
			derivation: "ai-edit",
			derivedFromAssetId: source,
			generation: {
				inputAssetIds: [source, reference],
				kind: "image",
				model: "edit-model",
				prompt: "Add fog",
				requestId: "req-1",
			},
		};
		expect(generationProvenance(asset, [])).toEqual({
			kind: "image",
			language: "",
			model: "edit-model",
			prompt: "Add fog",
			provider: "",
			referenceAssetIds: [reference],
			requestId: "req-1",
			sourceAssetId: source,
			speed: 1,
			voice: "",
		});
	});

	test("falls back to the latest completed request that saved the asset", () => {
		const asset = image("generated");
		const older = job(
			{
				id: crypto.randomUUID(),
				kind: "image",
				projectId: PROJECT,
				prompt: "First take",
			},
			[asset.id],
			"2026-01-01T00:00:00.000Z"
		);
		const newer = job(
			{
				id: crypto.randomUUID(),
				kind: "image",
				model: "m2",
				projectId: PROJECT,
				prompt: "Second take",
				provider: "p2",
			},
			[asset.id],
			"2026-02-01T00:00:00.000Z"
		);
		const failed = job(
			{
				id: crypto.randomUUID(),
				kind: "image",
				projectId: PROJECT,
				prompt: "Failed take",
			},
			[],
			"2026-03-01T00:00:00.000Z",
			"incomplete"
		);
		const provenance = generationProvenance(asset, [older, newer, failed]);
		expect(provenance?.prompt).toBe("Second take");
		expect(provenance?.provider).toBe("p2");
		expect(provenance?.requestId).toBe(newer.id);
	});
});

describe("regenerationRequest", () => {
	test("re-requests an image edit with the same inputs", () => {
		const source = crypto.randomUUID();
		const reference = crypto.randomUUID();
		const assetId = crypto.randomUUID();
		const edit = aiEditRequest({
			id: crypto.randomUUID(),
			model: "m",
			projectId: PROJECT,
			prompt: "Neon sign",
			provider: "p",
			purpose: "ai-edit",
			referenceAssetIds: [reference],
			sourceAssetId: source,
		});
		const provenance = generationProvenance(
			{ ...image("edited"), id: assetId },
			[job(edit, [assetId])]
		);
		if (!provenance) {
			throw new Error("Expected provenance.");
		}
		const id = crypto.randomUUID();
		const request = regenerationRequest(provenance, {
			assetId,
			id,
			projectId: PROJECT,
		});
		expect(request).toMatchObject({
			id,
			inputAssetIds: [reference],
			kind: "image",
			model: "m",
			prompt: "Neon sign",
			provider: "p",
			purpose: "regenerate",
			regeneratesAssetId: assetId,
			sourceAssetId: source,
		});
		expect(generatedMediaFileName(request)).toBe("Regenerated — Neon sign.png");
	});

	test("keeps narration voice settings and drops provider fields for audio", () => {
		const assetId = crypto.randomUUID();
		const narration = job(
			{
				id: crypto.randomUUID(),
				kind: "audio",
				language: "en-us",
				projectId: PROJECT,
				prompt: "Welcome back",
				speed: 1.2,
				voice: "warm",
			},
			[assetId]
		);
		const provenance = generationProvenance(
			{ ...image("vo"), id: assetId, kind: "audio" },
			[narration]
		);
		if (!provenance) {
			throw new Error("Expected provenance.");
		}
		const request = regenerationRequest(provenance, {
			assetId,
			id: crypto.randomUUID(),
			projectId: PROJECT,
		});
		expect(request).toMatchObject({
			kind: "audio",
			language: "en-us",
			model: "",
			provider: "",
			speed: 1.2,
			voice: "warm",
		});
		expect(requestInputImageIds(request)).toEqual([]);
		expect("engine" in request).toBe(false);
	});

	test("keeps the chosen speech engine, which only narration may name", () => {
		const assetId = crypto.randomUUID();
		const narration = job(
			{
				engine: "kokoro",
				id: crypto.randomUUID(),
				kind: "audio",
				projectId: PROJECT,
				prompt: "Bonsoir",
				voice: "ff_siwis",
			},
			[assetId]
		);
		const provenance = generationProvenance(
			{ ...image("vo"), id: assetId, kind: "audio" },
			[narration]
		);
		expect(provenance?.engine).toBe("kokoro");
		const request = regenerationRequest(provenance ?? expect.unreachable(), {
			assetId,
			id: crypto.randomUUID(),
			projectId: PROJECT,
		});
		expect(request).toMatchObject({ engine: "kokoro", voice: "ff_siwis" });
		expect(() =>
			generationRequestSchema.parse({
				engine: "kokoro",
				id: crypto.randomUUID(),
				kind: "image",
				projectId: PROJECT,
				prompt: "Harbor",
			})
		).toThrow("Only narration requests name a speech engine.");
	});
});

describe("generated asset stamp", () => {
	test("an AI edit is stamped ai-edit, derived from its source, inputs source first", () => {
		const source = image("poster.png");
		const reference = image("style.png");
		const request = aiEditRequest({
			id: crypto.randomUUID(),
			model: "edit-model",
			projectId: PROJECT,
			prompt: "Night",
			provider: "cloud",
			purpose: "ai-edit",
			referenceAssetIds: [reference.id],
			sourceAssetId: source.id,
		});
		const stamped = assetSchema.parse(
			stampGeneratedAsset(image("AI edit — Night.png"), request)
		);
		expect(stamped).toMatchObject({
			derivation: "ai-edit",
			derivedFromAssetId: source.id,
			generation: {
				inputAssetIds: [source.id, reference.id],
				kind: "image",
				model: "edit-model",
				prompt: "Night",
				provider: "cloud",
				requestId: request.id,
			},
		});
		// Provenance read back from the stamp alone (no job history).
		const provenance = generationProvenance(stamped, []);
		expect(provenance).toMatchObject({
			model: "edit-model",
			prompt: "Night",
			provider: "cloud",
			referenceAssetIds: [reference.id],
			requestId: request.id,
			sourceAssetId: source.id,
		});
		const again = regenerationRequest(provenance ?? expect.unreachable(), {
			assetId: stamped.id,
			id: crypto.randomUUID(),
			projectId: PROJECT,
		});
		expect(requestInputImageIds(again)).toEqual([source.id, reference.id]);
	});

	test("plain generations carry no derivation and omit empty fields", () => {
		const request = generationRequestSchema.parse({
			id: crypto.randomUUID(),
			kind: "video",
			projectId: PROJECT,
			prompt: "Waves",
		});
		expect(generatedAssetStamp(request)).toEqual({
			generation: { kind: "video", prompt: "Waves", requestId: request.id },
		});
	});

	test("existing derivations are kept; the recorded job wins for narration", () => {
		const cutout = { ...image("cut.png"), derivation: "cutout" as const };
		const request = generationRequestSchema.parse({
			id: crypto.randomUUID(),
			kind: "image",
			projectId: PROJECT,
			prompt: "Fox",
			sourceAssetId: crypto.randomUUID(),
		});
		expect(stampGeneratedAsset(cutout, request).derivation).toBe("cutout");
		const narration = job(
			{
				id: crypto.randomUUID(),
				kind: "audio",
				language: "fr",
				projectId: PROJECT,
				prompt: "Bonjour",
				speed: 1.25,
				voice: "alloy",
			},
			[]
		);
		const voice = stampGeneratedAsset(
			{ ...image("vo.wav"), hasAudio: true, kind: "audio" },
			narration.request
		);
		expect(generationProvenance(voice, [narration])).toMatchObject({
			language: "fr",
			speed: 1.25,
			voice: "alloy",
		});
		expect(generationProvenance(voice, [])?.voice).toBe("");
	});
});
