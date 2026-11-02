import { afterAll, describe, expect, test } from "bun:test";
import {
	draftTextFor,
	outpostAvailability,
	parsePublishMetadata,
	type SocialBridge,
	sendToOutpost,
} from "./outpost-handoff.ts";

const ownsWindow = !("window" in globalThis);
if (ownsWindow) {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: globalThis,
	});
}
afterAll(() => {
	if (ownsWindow) {
		Reflect.deleteProperty(globalThis, "window");
	}
});

const METADATA = [
	"Title: Launch day",
	"Platform: YouTube 1080p",
	"Duration: 01:30",
	"",
	"Description:",
	"Our first launch.",
	"",
	"Chapters:",
	"00:00 Start",
	"00:42 Demo",
	"",
].join("\n");

/** A fake Outpost that keeps imported bytes and drafts. */
function fakeOutpost(
	options: {
		accounts?: { id: string; platform: string }[];
		failChunk?: number;
	} = {}
) {
	const calls: { method?: string; path: string }[] = [];
	const imported: number[] = [];
	const drafts: unknown[] = [];
	let size = 0;
	let chunks = 0;
	const social: SocialBridge = {
		open: async () => null,
		request: async (input) => {
			calls.push({ method: input.method, path: input.path });
			const body = input.body as Record<string, unknown> | undefined;
			if (input.path === "/platforms") {
				return { platforms: [] };
			}
			if (input.path === "/media/import") {
				size = Number(body?.size);
				return { chunk_size: 1024 * 1024, id: "imp-1", max_bytes: 1 };
			}
			if (input.path.endsWith("/chunks")) {
				chunks += 1;
				if (options.failChunk === chunks) {
					throw new Error("disk full");
				}
				if (body?.offset !== imported.length) {
					throw new Error(
						`chunk offset ${String(body?.offset)} is out of order`
					);
				}
				for (const byte of Buffer.from(String(body?.data), "base64")) {
					imported.push(byte);
				}
				return { received: imported.length };
			}
			if (input.path.endsWith("/finish")) {
				if (imported.length !== size || body?.metadata_text !== METADATA) {
					throw new Error("finish before every byte, or without the metadata");
				}
				return {
					media: {
						id: "m1",
						mime_type: "video/mp4",
						name: "Launch.mp4",
						path: "/root/social-media/imports/u/Launch.mp4",
					},
					metadata_path: "/root/social-media/imports/u/Launch-metadata.txt",
				};
			}
			if (input.path === "/accounts") {
				return { accounts: options.accounts ?? [] };
			}
			if (input.path === "/drafts") {
				drafts.push(body);
				return { id: `d${drafts.length}` };
			}
			if (input.method === "DELETE") {
				return { ok: true };
			}
			throw new Error(`unexpected ${input.path}`);
		},
	};
	return { calls, drafts, imported, social };
}

/** Sidecar render chunks of 512 KiB over `bytes`. */
function reader(bytes: Uint8Array) {
	return async (offset: number) => {
		const part = bytes.subarray(offset, offset + 512 * 1024);
		return {
			data: Buffer.from(part).toString("base64"),
			done: offset + 512 * 1024 >= bytes.length,
			size: bytes.length,
		};
	};
}

describe("Send to Outpost", () => {
	test("metadata becomes the draft text, with chapters only for YouTube", () => {
		const parsed = parsePublishMetadata(METADATA);
		expect(parsed).toEqual({
			chapters: ["00:00 Start", "00:42 Demo"],
			description: "Our first launch.",
			title: "Launch day",
		});
		expect(draftTextFor(parsed, "youtube")).toBe(
			"Launch day\n\nOur first launch.\n\n00:00 Start\n00:42 Demo"
		);
		expect(draftTextFor(parsed, "tiktok")).toBe(
			"Launch day\n\nOur first launch."
		);
	});

	test("the render streams into an import session and one draft per platform is created", async () => {
		const outpost = fakeOutpost({
			accounts: [
				{ id: "yt-1", platform: "youtube" },
				{ id: "x-1", platform: "x" },
			],
		});
		const render = new Uint8Array(2.5 * 1024 * 1024).map(
			(_, index) => index % 251
		);
		const progress: number[] = [];
		const result = await sendToOutpost({
			fileName: "Launch.mp4",
			jobId: "job-1",
			metadata: METADATA,
			mimeType: "video/mp4",
			onProgress: (fraction) => progress.push(fraction),
			platforms: ["youtube", "tiktok"],
			read: reader(render),
			social: outpost.social,
		});
		expect(outpost.imported).toEqual([...render]);
		// 1 MiB, 1 MiB, then the 0.5 MiB tail.
		expect(
			outpost.calls.filter((call) => call.path.endsWith("/chunks"))
		).toHaveLength(3);
		expect(progress.at(-1)).toBe(1);
		expect(outpost.drafts).toEqual([
			{
				body: {
					account_ids: ["yt-1"],
					media: [
						{
							mime_type: "video/mp4",
							name: "Launch.mp4",
							path: "/root/social-media/imports/u/Launch.mp4",
						},
					],
					segments: [
						{
							media: [
								{
									mime_type: "video/mp4",
									name: "Launch.mp4",
									path: "/root/social-media/imports/u/Launch.mp4",
								},
							],
							text: "Launch day\n\nOur first launch.\n\n00:00 Start\n00:42 Demo",
						},
					],
					text: "Launch day\n\nOur first launch.\n\n00:00 Start\n00:42 Demo",
				},
			},
			expect.objectContaining({
				body: expect.objectContaining({
					account_ids: [],
					text: "Launch day\n\nOur first launch.",
				}),
			}),
		]);
		expect(result).toEqual({
			draftIds: { tiktok: "d2", youtube: "d1" },
			mediaPath: "/root/social-media/imports/u/Launch.mp4",
			withoutAccounts: ["tiktok"],
		});
	});

	test("a failed chunk cancels the import session and creates no draft", async () => {
		const outpost = fakeOutpost({ failChunk: 2 });
		await expect(
			sendToOutpost({
				fileName: "Launch.mp4",
				jobId: "job-1",
				metadata: METADATA,
				mimeType: "video/mp4",
				platforms: ["youtube"],
				read: reader(new Uint8Array(3 * 1024 * 1024)),
				social: outpost.social,
			})
		).rejects.toThrow("disk full");
		expect(outpost.calls.at(-1)).toEqual({
			method: "DELETE",
			path: "/media/import/imp-1",
		});
		expect(outpost.drafts).toEqual([]);
	});

	test("availability names the missing grant or app instead of hiding the action", async () => {
		expect((await outpostAvailability(undefined)).reason).toContain(
			"optional Outpost access"
		);
		const down: SocialBridge = {
			open: async () => null,
			request: async () => {
				throw new Error("social.request is not available");
			},
		};
		const result = await outpostAvailability(down);
		expect(result.available).toBe(false);
		expect(result.reason).toContain("not reachable");
		expect((await outpostAvailability(fakeOutpost().social)).available).toBe(
			true
		);
	});
});
