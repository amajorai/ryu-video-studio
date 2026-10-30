/**
 * Send to Outpost (G86): hand a finished export to the Outpost app, which
 * owns social accounts, OAuth (through its Gateway-vaulted broker),
 * per-platform validation and scheduling. Video Studio adds no OAuth or
 * platform client of its own; it only uses the optional `social:crud` grant:
 *
 * 1. stream the render from the sidecar into an Outpost media-import session
 *    (`POST /media/import`, chunks, finish with `metadata.txt` text);
 * 2. create one draft per target platform with the media attached and the
 *    preset's title, description and chapters as the post text;
 * 3. open Outpost so the person reviews, picks accounts and schedules.
 *
 * Nothing is published from here. Whether a platform accepts the upload is
 * decided later by Outpost and the platform.
 */
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { z } from "zod";
import type { PublishPresetId } from "../../../shared/publish-presets.ts";
import { request, type StudioSocialRequest } from "../bridge.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** Outpost platform ids for the publish presets that have one. */
export const OUTPOST_PLATFORMS: Partial<Record<PublishPresetId, string>> = {
	"instagram-reels": "instagram",
	linkedin: "linkedin",
	tiktok: "tiktok",
	x: "x",
	"youtube-1080p": "youtube",
	"youtube-4k": "youtube",
	"youtube-shorts": "youtube",
};

export const OUTPOST_PLATFORM_LABELS: Record<string, string> = {
	instagram: "Instagram",
	linkedin: "LinkedIn",
	tiktok: "TikTok",
	x: "X",
	youtube: "YouTube",
};

/** Outpost's social bridge, or undefined when the host has none. */
export type SocialBridge = NonNullable<NonNullable<Window["ryu"]>["social"]>;

export function hostSocialBridge(): SocialBridge | undefined {
	return window.ryu?.social;
}

/**
 * Whether Outpost can take a handoff: the host has the social bridge, the
 * optional grant is approved, and Outpost answers. Resolves a reason when
 * it cannot, so the Export panel can say why instead of hiding the action.
 */
export async function outpostAvailability(
	social: SocialBridge | undefined = hostSocialBridge(),
	tl: LiteralMessage = englishMessages
): Promise<{ available: boolean; reason?: string }> {
	if (!social) {
		return {
			available: false,
			reason:
				"Send to Outpost needs Ryu with Outpost installed and Video Studio's optional Outpost access approved.",
		};
	}
	try {
		await social.request({ method: "GET", path: "/platforms" });
		return { available: true };
	} catch (error) {
		return {
			available: false,
			reason: tl(
				"Outpost is not reachable: {reason}. Install Outpost and approve Video Studio's Outpost access.",
				{ reason: error instanceof Error ? error.message : tl("unknown error") }
			),
		};
	}
}

interface ParsedMetadata {
	chapters: string[];
	description: string;
	title: string;
}

/** Read the `metadata.txt` a preset export writes (title, description, chapters). */
export function parsePublishMetadata(text: string): ParsedMetadata {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const title =
		lines
			.find((line) => line.startsWith("Title: "))
			?.slice(7)
			.trim() ?? "";
	const descriptionStart = lines.indexOf("Description:");
	const chaptersStart = lines.indexOf("Chapters:");
	const description =
		descriptionStart < 0
			? ""
			: lines
					.slice(
						descriptionStart + 1,
						chaptersStart > descriptionStart ? chaptersStart : undefined
					)
					.join("\n")
					.trim()
					.replace(/^\(no description\)$/, "");
	const chapters =
		chaptersStart < 0
			? []
			: lines
					.slice(chaptersStart + 1)
					.map((line) => line.trim())
					.filter(Boolean);
	return { chapters, description, title };
}

/**
 * The draft text for `platform`: title and description, plus chapter lines
 * where the platform shows them (YouTube).
 */
export function draftTextFor(
	metadata: ParsedMetadata,
	platform: string
): string {
	const parts = [metadata.title, metadata.description].filter(Boolean);
	if (platform === "youtube" && metadata.chapters.length) {
		parts.push(metadata.chapters.join("\n"));
	}
	return parts.join("\n\n").trim();
}

const importStartSchema = z.object({
	chunk_size: z.number().int().positive(),
	id: z.string().min(1),
});
const importFinishSchema = z.object({
	media: z.object({
		id: z.string(),
		mime_type: z.string().nullable().optional(),
		name: z.string(),
		path: z.string(),
	}),
	metadata_path: z.string().nullable().optional(),
});
const accountsSchema = z.object({
	accounts: z.array(z.object({ id: z.string(), platform: z.string() })),
});
const draftSchema = z.object({ id: z.string() });
const renderChunkSchema = z.object({
	data: z.string(),
	done: z.boolean(),
	size: z.number(),
});

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const step = 0x80_00;
	for (let offset = 0; offset < bytes.length; offset += step) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
	}
	return btoa(binary);
}

export interface OutpostHandoff {
	draftIds: Record<string, string>;
	mediaPath: string;
	/** Target platforms with no connected Outpost account yet. */
	withoutAccounts: string[];
}

/**
 * Stream export `jobId` into Outpost and create one draft per platform.
 * `read` pulls sidecar render chunks (`GET /renders/:id/data`); it is
 * injectable for tests.
 */
export async function sendToOutpost(input: {
	fileName: string;
	jobId: string;
	metadata: string;
	mimeType: string;
	onProgress?: (fraction: number) => void;
	platforms: readonly string[];
	read?: (offset: number) => Promise<z.infer<typeof renderChunkSchema>>;
	social: SocialBridge;
}): Promise<OutpostHandoff> {
	if (!input.platforms.length) {
		throw new Error("Choose at least one platform to draft for.");
	}
	const call = async <T>(schema: z.ZodType<T>, body: StudioSocialRequest) =>
		schema.parse(await input.social.request(body));
	const read =
		input.read ??
		(async (offset: number) =>
			await request(
				renderChunkSchema,
				`/renders/${input.jobId}/data?offset=${offset}`
			));
	let offset = 0;
	let first = await read(0);
	const size = first.size;
	const session = await call(importStartSchema, {
		body: { mime_type: input.mimeType, name: input.fileName, size },
		method: "POST",
		path: "/media/import",
	});
	try {
		let pending = new Uint8Array(0);
		let sent = 0;
		const flush = async (bytes: Uint8Array) => {
			await input.social.request({
				body: { data: toBase64(bytes), offset: sent },
				method: "POST",
				path: `/media/import/${encodeURIComponent(session.id)}/chunks`,
			});
			sent += bytes.length;
			input.onProgress?.(size ? sent / size : 1);
		};
		for (;;) {
			const bytes = Uint8Array.from(atob(first.data), (c) => c.charCodeAt(0));
			const merged = new Uint8Array(pending.length + bytes.length);
			merged.set(pending);
			merged.set(bytes, pending.length);
			pending = merged;
			offset += bytes.length;
			while (pending.length >= session.chunk_size) {
				await flush(pending.subarray(0, session.chunk_size));
				pending = pending.slice(session.chunk_size);
			}
			if (first.done) {
				break;
			}
			if (!bytes.length) {
				throw new Error("The export stream ended early.");
			}
			first = await read(offset);
		}
		if (pending.length) {
			await flush(pending);
		}
		if (sent !== size) {
			throw new Error("The export stream ended early.");
		}
	} catch (error) {
		await input.social
			.request({
				method: "DELETE",
				path: `/media/import/${encodeURIComponent(session.id)}`,
			})
			.catch(() => undefined);
		throw error;
	}
	const finished = await call(importFinishSchema, {
		body: { metadata_text: input.metadata },
		method: "POST",
		path: `/media/import/${encodeURIComponent(session.id)}/finish`,
	});
	const { accounts } = await call(accountsSchema, {
		method: "GET",
		path: "/accounts",
	});
	const metadata = parsePublishMetadata(input.metadata);
	const media = [
		{
			mime_type: finished.media.mime_type ?? input.mimeType,
			name: finished.media.name,
			path: finished.media.path,
		},
	];
	const draftIds: Record<string, string> = {};
	const withoutAccounts: string[] = [];
	for (const platform of new Set(input.platforms)) {
		const accountIds = accounts
			.filter((account) => account.platform === platform)
			.map((account) => account.id);
		if (!accountIds.length) {
			withoutAccounts.push(platform);
		}
		const text = draftTextFor(metadata, platform);
		const draft = await call(draftSchema, {
			body: {
				body: {
					account_ids: accountIds,
					media,
					segments: [{ media, text }],
					text,
				},
			},
			method: "POST",
			path: "/drafts",
		});
		draftIds[platform] = draft.id;
	}
	return { draftIds, mediaPath: finished.media.path, withoutAccounts };
}
