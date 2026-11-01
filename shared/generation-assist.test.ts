import { describe, expect, test } from "bun:test";
import {
	enhancePromptRequest,
	formatMicroUsd,
	generationCostPreview,
	generationModelOptions,
	insertMention,
	MAX_PROMPT_DRAFTS,
	mentionQueryAt,
	mentionSuggestions,
	mentionToken,
	parseEnhancedPrompt,
	resolvePromptMentions,
	saveDraft,
} from "./generation-assist.ts";

const image = (id: string, name: string) => ({
	id,
	kind: "image" as const,
	name,
});

describe("generation model catalog", () => {
	test("lists the current model first, then configured providers' models", () => {
		const options = generationModelOptions(
			{
				current: { model: "flux-pro", provider: "fal" },
				providers: [
					{
						configured: true,
						id: "fal",
						label: "Fal",
						suggestedModels: ["flux-pro", "veo-3"],
					},
					{
						configured: false,
						id: "off",
						label: "Off",
						suggestedModels: ["hidden"],
					},
					{ id: "local", suggestedModels: ["sdxl"] },
				],
			},
			{ local: ["wan-2.2"] }
		);
		expect(options.map((option) => option.key)).toEqual([
			"fal/flux-pro",
			"fal/veo-3",
			"local/wan-2.2",
			"local/sdxl",
		]);
		expect(options[0]?.label).toBe("flux-pro · Fal");
	});

	test("an unreadable snapshot gives no options", () => {
		expect(generationModelOptions(null)).toEqual([]);
		expect(generationModelOptions({ providers: "nope" })).toEqual([]);
	});
});

describe("generation cost preview", () => {
	test("without a cap every request is admitted and nothing is remaining", () => {
		expect(generationCostPreview(undefined, null, "video")).toEqual({
			allowed: true,
			estimateMicroUsd: 1_000_000,
			limitMicroUsd: 0,
			remainingMicroUsd: null,
		});
	});

	test("with a cap the estimate is checked against what is committed", () => {
		const budget = {
			estimates: { audio: 100_000, image: 250_000, video: 1_000_000 },
			limitMicroUsd: 2_000_000,
		};
		const status = {
			atRiskMicroUsd: 250_000,
			reservedMicroUsd: 0,
			spentMicroUsd: 1_000_000,
		};
		expect(generationCostPreview(budget, status, "image")).toMatchObject({
			allowed: true,
			remainingMicroUsd: 750_000,
		});
		expect(generationCostPreview(budget, status, "video").allowed).toBe(false);
	});

	test("money reads as dollars", () => {
		expect(formatMicroUsd(250_000)).toBe("$0.25");
		expect(formatMicroUsd(5000)).toBe("$0.005");
		expect(formatMicroUsd(0)).toBe("$0.00");
	});
});

describe("@mentions", () => {
	const assets = [
		image("a", "Hero shot.png"),
		image("b", "logo.final.webp"),
		{ id: "c", kind: "video" as const, name: "clip.mp4" },
	];

	test("tokens drop the extension and replace spaces", () => {
		expect(mentionToken({ name: "Hero shot.png" })).toBe("Hero-shot");
		expect(mentionToken({ name: "logo.final.webp" })).toBe("logo.final");
		expect(mentionToken({ name: "???.png" })).toBe("asset");
	});

	test("mentions become numbered references in the prompt", () => {
		expect(
			resolvePromptMentions(
				"Put @logo.final on @hero-shot. Then @Hero-shot again, not @clip or @nobody.",
				assets
			)
		).toEqual({
			ids: ["b", "a"],
			prompt:
				"Put reference image 1 on reference image 2. Then reference image 2 again, not @clip or @nobody.",
			unknown: ["clip", "nobody"],
		});
		expect(resolvePromptMentions("email me at a@b.com", assets).ids).toEqual(
			[]
		);
	});

	test("more than four distinct references are refused", () => {
		const many = ["1", "2", "3", "4", "5"].map((id) =>
			image(id, `img${id}.png`)
		);
		expect(() =>
			resolvePromptMentions("@img1 @img2 @img3 @img4 @img5", many)
		).toThrow(/at most 4/);
	});

	test("suggestions and insertion follow the @query at the cursor", () => {
		const prompt = "A poster with @he";
		expect(mentionQueryAt(prompt, prompt.length)).toBe("he");
		expect(mentionQueryAt("no mention", 10)).toBeNull();
		expect(mentionSuggestions("he", assets).map((asset) => asset.id)).toEqual([
			"a",
		]);
		expect(mentionSuggestions("", assets)).toHaveLength(2);
		expect(
			insertMention(prompt, prompt.length, assets[0] ?? image("x", "x"))
		).toEqual({ cursor: 25, prompt: "A poster with @Hero-shot " });
	});
});

describe("prompt enhance", () => {
	test("the request keeps mentions and is specific to the kind", () => {
		const request = enhancePromptRequest("video", "  a cat @hero  ");
		expect(request.prompt).toBe("a cat @hero");
		expect(request.system).toContain("camera movement");
		expect(request.system).toContain("@mention");
	});

	test("replies are unwrapped and empty ones are refused", () => {
		expect(parseEnhancedPrompt('Prompt: "A tabby cat at dusk"')).toBe(
			"A tabby cat at dusk"
		);
		expect(parseEnhancedPrompt("```\nWide shot\n```")).toBe("Wide shot");
		expect(() => parseEnhancedPrompt("  ")).toThrow(/empty/);
	});
});

describe("prompt drafts", () => {
	test("saving the same text refreshes it at the top and the list is capped", () => {
		const first = saveDraft([], { kind: "image", prompt: " one " });
		const second = saveDraft(first, { kind: "image", prompt: "two" });
		const again = saveDraft(second, { kind: "image", prompt: "one" });
		expect(again.map((draft) => draft.prompt)).toEqual(["one", "two"]);
		expect(again[0]?.id).toBe(first[0]?.id);
		let many = again;
		for (let index = 0; index < 30; index++) {
			many = saveDraft(many, { kind: "video", prompt: `p${index}` });
		}
		expect(many).toHaveLength(MAX_PROMPT_DRAFTS);
		expect(saveDraft(many, { kind: "audio", prompt: "  " })).toHaveLength(
			MAX_PROMPT_DRAFTS
		);
	});
});
