import { describe, expect, test } from "bun:test";
import {
	aiEditRequest,
	type GenerationOutcomeInput,
	type GenerationRequest,
	generationRequestSchema,
} from "../../../shared/generation.ts";
import type { Asset } from "../../../shared/project.ts";
import { StudioRequestError } from "../bridge.ts";
import {
	BUDGET_EXCEEDED_MESSAGE,
	bridgeSupports,
	budgetAdmits,
	bytesDataUrl,
	type GenerationServices,
	imageBridgeInput,
	inputImageDataUrl,
	type MediaBridge,
	recordFailureMessage,
	requestGeneratedMedia,
	runGeneration,
	sniffImageMime,
} from "./media-bridge.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function still(name = "still.png"): Asset {
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

function editRequest(source: string, references: string[] = []) {
	return aiEditRequest({
		id: crypto.randomUUID(),
		model: "edit-model",
		projectId: PROJECT,
		prompt: "Add rain",
		purpose: "ai-edit",
		referenceAssetIds: references,
		sourceAssetId: source,
	});
}

/** Mocked sidecar and host services that log every call in order. */
function mockServices(
	bridge: MediaBridge | undefined,
	overrides: Partial<GenerationServices> = {}
) {
	const calls: string[] = [];
	const outcomes: GenerationOutcomeInput[] = [];
	const recorded: GenerationRequest[] = [];
	const uploads: File[] = [];
	const services: GenerationServices = {
		admit: async () => {
			calls.push("admit");
		},
		bridge,
		finish: async (_id, outcome) => {
			calls.push(`finish:${outcome.status}`);
			outcomes.push(outcome);
		},
		readImage: async (asset) => {
			calls.push(`read:${asset.name}`);
			return `data:image/png;base64,${btoa(asset.name)}`;
		},
		record: async (generation) => {
			calls.push("record");
			recorded.push(generation);
		},
		upload: async (file) => {
			calls.push("upload");
			uploads.push(file);
			return { ...still(file.name), name: file.name };
		},
		...overrides,
	};
	return { calls, outcomes, recorded, services, uploads };
}

describe("request shaping", () => {
	test("image input sends one output and only the fields that are set", () => {
		const request = generationRequestSchema.parse({
			id: crypto.randomUUID(),
			kind: "image",
			projectId: PROJECT,
			prompt: "A lighthouse",
		});
		expect(imageBridgeInput(request, [])).toEqual({
			count: 1,
			project_id: PROJECT,
			prompt: "A lighthouse",
			request_id: request.id,
		});
	});

	test("image edit input carries the provider, model, and input images", () => {
		const request = editRequest(crypto.randomUUID());
		expect(imageBridgeInput(request, [PNG, PNG])).toEqual({
			count: 1,
			input_images: [PNG, PNG],
			model: "edit-model",
			project_id: PROJECT,
			prompt: "Add rain",
			request_id: request.id,
		});
	});

	test("requestGeneratedMedia routes by kind and validates the result", async () => {
		const seen: unknown[] = [];
		const bridge: MediaBridge = {
			image: async (input) => {
				seen.push(input);
				return [PNG];
			},
			tts: async (input) => {
				seen.push(input);
				return "data:audio/wav;base64,UklGRg==";
			},
			video: async () => [{ mediaType: "video/mp4", url: PNG }],
		};
		const image = editRequest(crypto.randomUUID());
		expect(await requestGeneratedMedia(bridge, image, [PNG])).toBe(PNG);
		const narration = generationRequestSchema.parse({
			id: crypto.randomUUID(),
			kind: "audio",
			language: "en-us",
			projectId: PROJECT,
			prompt: "Hello",
			speed: 1.5,
		});
		await requestGeneratedMedia(bridge, narration);
		expect(seen[1]).toEqual({
			language: "en-us",
			project_id: PROJECT,
			request_id: narration.id,
			speed: 1.5,
			text: "Hello",
		});
		const video = generationRequestSchema.parse({
			id: crypto.randomUUID(),
			kind: "video",
			projectId: PROJECT,
			prompt: "Waves",
		});
		// The host returned an image where a video was expected.
		await expect(requestGeneratedMedia(bridge, video)).rejects.toThrow(
			"usable generated media"
		);
		await expect(requestGeneratedMedia(bridge, video, [PNG])).rejects.toThrow(
			"does not accept input images"
		);
		await expect(requestGeneratedMedia(undefined, image)).rejects.toThrow(
			"unavailable"
		);
	});

	test("bridgeSupports checks the bridge method for each kind", () => {
		const bridge: MediaBridge = { image: async () => [PNG] };
		expect(bridgeSupports(bridge, "image")).toBe(true);
		expect(bridgeSupports(bridge, "video")).toBe(false);
		expect(bridgeSupports(bridge, "audio")).toBe(false);
		expect(bridgeSupports(undefined, "image")).toBe(false);
	});
});

describe("budgetAdmits", () => {
	const status = { atRiskMicroUsd: 0, reservedMicroUsd: 0, spentMicroUsd: 0 };
	test("unlimited budgets always admit", () => {
		expect(budgetAdmits({ ...status, spentMicroUsd: 9e8 }, {}, "video")).toBe(
			true
		);
	});

	test("admits only when the kind's estimate still fits the limit", () => {
		const budget = { limitMicroUsd: 1_000_000 };
		expect(
			budgetAdmits({ ...status, spentMicroUsd: 750_000 }, budget, "image")
		).toBe(true);
		expect(
			budgetAdmits(
				{ ...status, reservedMicroUsd: 500_000, spentMicroUsd: 300_000 },
				budget,
				"image"
			)
		).toBe(false);
		expect(budgetAdmits(status, budget, "video")).toBe(true);
		expect(
			budgetAdmits({ ...status, atRiskMicroUsd: 1 }, budget, "video")
		).toBe(false);
	});

	test("the refusal message matches the sidecar's budget refusal", () => {
		expect(
			recordFailureMessage(new StudioRequestError("x", "BUDGET_EXCEEDED"))
		).toBe(BUDGET_EXCEEDED_MESSAGE);
	});
});

describe("image encoding", () => {
	test("sniffs BMP and refuses unknown signatures", () => {
		expect(
			sniffImageMime(Uint8Array.of(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
		).toBe("image/bmp");
		expect(sniffImageMime(Uint8Array.of(0, 1, 2, 3))).toBeUndefined();
	});

	test("input images keep their type; BMP is converted to PNG; unknown is refused", async () => {
		const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
		const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
		const bmp = Uint8Array.of(0x42, 0x4d, 1, 2, 3, 4);
		const conversions: string[] = [];
		const transcode = async (_bytes: Uint8Array, mime: string) => {
			conversions.push(mime);
			return png;
		};
		expect(await inputImageDataUrl(jpeg, "a.jpg", transcode)).toBe(
			bytesDataUrl(jpeg, "image/jpeg")
		);
		expect(conversions).toEqual([]);
		expect(await inputImageDataUrl(bmp, "b.bmp", transcode)).toBe(
			bytesDataUrl(png, "image/png")
		);
		expect(conversions).toEqual(["image/bmp"]);
		await expect(
			inputImageDataUrl(Uint8Array.of(1, 2, 3), "c.tif", transcode)
		).rejects.toThrow("is not a PNG, JPEG, WebP, GIF, or BMP image");
		await expect(
			inputImageDataUrl(bmp, "d.bmp", async () => bmp)
		).rejects.toThrow("could not be converted to PNG");
	});

	test("sniffs PNG, JPEG, WebP, and GIF signatures", () => {
		expect(sniffImageMime(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe(
			"image/jpeg"
		);
		expect(
			sniffImageMime(
				Uint8Array.from(
					[..."RIFF"]
						.map((c) => c.charCodeAt(0))
						.concat(
							[0, 0, 0, 0],
							[..."WEBP"].map((c) => c.charCodeAt(0))
						)
				)
			)
		).toBe("image/webp");
		expect(sniffImageMime(Uint8Array.of(0x47, 0x49, 0x46, 0x38))).toBe(
			"image/gif"
		);
		expect(sniffImageMime(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe(
			"image/png"
		);
	});

	test("encodes large buffers in chunks without changing the bytes", () => {
		const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
		const url = bytesDataUrl(bytes, "image/png");
		const decoded = Uint8Array.from(
			atob(url.slice("data:image/png;base64,".length)),
			(character) => character.charCodeAt(0)
		);
		expect(decoded).toEqual(bytes);
	});
});

describe("runGeneration", () => {
	test("records, reads inputs in order, calls the host, saves, then completes", async () => {
		const source = still("source.png");
		const reference = still("reference.png");
		let hostInput: unknown;
		const { calls, outcomes, services, uploads } = mockServices({
			image: async (input) => {
				hostInput = input;
				return [PNG];
			},
		});
		const request = editRequest(source.id, [reference.id]);
		const saved = await runGeneration(services, request, [source, reference]);
		expect(calls).toEqual([
			"record",
			"read:source.png",
			"read:reference.png",
			"upload",
			"finish:completed",
		]);
		expect(hostInput).toMatchObject({
			input_images: [
				`data:image/png;base64,${btoa("source.png")}`,
				`data:image/png;base64,${btoa("reference.png")}`,
			],
		});
		expect(uploads[0]?.name).toBe("AI edit — Add rain.png");
		expect(uploads[0]?.type).toBe("image/png");
		expect(outcomes[0]).toEqual({
			assetIds: [saved.asset.id],
			message: "",
			status: "completed",
		});
		expect(saved.historyWarning).toBeUndefined();
	});

	test("a budget refusal stops before the host is called", async () => {
		let hostCalls = 0;
		const { calls, services } = mockServices(
			{
				image: async () => {
					hostCalls += 1;
					return [PNG];
				},
			},
			{
				record: async () => {
					throw new StudioRequestError("Budget", "BUDGET_EXCEEDED");
				},
			}
		);
		await expect(
			runGeneration(services, editRequest(crypto.randomUUID()), [still()])
		).rejects.toThrow("generation budget cannot admit");
		expect(hostCalls).toBe(0);
		expect(calls).toEqual([]);
	});

	test("refuses before recording when the host has no bridge for the kind", async () => {
		const { calls, services } = mockServices(undefined);
		await expect(
			runGeneration(services, editRequest(crypto.randomUUID()))
		).rejects.toThrow("unavailable in this host");
		expect(calls).toEqual([]);
	});

	test("a host failure records an incomplete outcome and saves nothing", async () => {
		const { calls, outcomes, services } = mockServices({
			image: async () => {
				throw new Error("Model declined the edit.");
			},
		});
		await expect(
			runGeneration(services, editRequest(crypto.randomUUID()))
		).rejects.toThrow("Model declined the edit.");
		expect(calls).toEqual(["record", "finish:incomplete"]);
		expect(outcomes[0]).toMatchObject({
			assetIds: [],
			message: "Model declined the edit.",
		});
	});

	test("a failed outcome update keeps the saved media and warns", async () => {
		const { services } = mockServices(
			{ image: async () => [PNG] },
			{
				finish: async () => {
					throw new Error("offline");
				},
			}
		);
		const saved = await runGeneration(
			services,
			editRequest(crypto.randomUUID())
		);
		expect(saved.asset.name).toBe("AI edit — Add rain.png");
		expect(saved.historyWarning).toContain("history update failed: offline");
	});

	test("explains conflicts and other record failures", () => {
		expect(recordFailureMessage(new StudioRequestError("x", "CONFLICT"))).toBe(
			"This request was already recorded. Review generation history before retrying."
		);
		expect(recordFailureMessage(new Error("Project not found."))).toBe(
			"Project not found."
		);
	});
});
