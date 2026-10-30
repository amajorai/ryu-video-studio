import { describe, expect, test } from "bun:test";
import { newSegment, type Project } from "../../../shared/project.ts";
import { testProject, testVideo } from "../editor/test-runtime.ts";
import {
	ChatAccessError,
	composeAgentHandoff,
	EDITOR_DEFAULT_RANGE,
	handoffConversations,
	handoffMarkers,
	handoffScope,
	isChatAccessDenied,
	listHandoffConversations,
	MAX_HANDOFF_CHARS,
	markedRange,
	markerHandoffScope,
	type StudioChat,
	sendAgentHandoff,
} from "./agent-bridge.ts";

function project(): { asset: ReturnType<typeof testVideo>; project: Project } {
	const { asset, project: base } = testProject();
	return { asset, project: { ...base, revision: 7 } };
}

describe("handoff scope", () => {
	test("a marked range wins and keeps the selected clips", () => {
		const { project: timeline } = project();
		const [first] = timeline.segments;
		expect(
			handoffScope({
				range: { end: 4, start: 1 },
				segments: timeline.segments,
				selectedIds: [first?.id ?? "", "missing"],
			})
		).toEqual({ clipIds: [first?.id ?? ""], range: { end: 4, start: 1 } });
	});

	test("without a range the selected clips' span is used", () => {
		const { project: timeline } = project();
		const ids = timeline.segments.map((segment) => segment.id);
		expect(
			handoffScope({
				range: null,
				segments: timeline.segments,
				selectedIds: ids,
			})
		).toEqual({ clipIds: ids, range: { end: 15, start: 0 } });
	});

	test("with nothing selected the scope is the whole timeline", () => {
		const { project: timeline } = project();
		expect(
			handoffScope({
				range: null,
				segments: timeline.segments,
				selectedIds: [],
			})
		).toEqual({ clipIds: [], range: null });
	});

	test("the editor's default range is not a marked range", () => {
		expect(markedRange(EDITOR_DEFAULT_RANGE)).toBeNull();
		expect(markedRange({ end: 2, start: 2 })).toBeNull();
		expect(markedRange({ end: 4, start: 1 })).toEqual({ end: 4, start: 1 });
		// An explicit flag wins over the default-range heuristic.
		expect(markedRange(EDITOR_DEFAULT_RANGE, true)).toEqual({
			end: 1,
			start: 0,
		});
		expect(markedRange({ end: 4, start: 1 }, false)).toBeNull();
		expect(markedRange({ end: 4, start: 4 }, true)).toBeNull();
	});
});

describe("handoff message", () => {
	test("carries the question, project id, revision, clips, and range", () => {
		const { asset, project: timeline } = project();
		const [first, second] = timeline.segments;
		const text = composeAgentHandoff({
			assets: [asset],
			dirty: true,
			project: timeline,
			question: "  Tighten this cut  ",
			scope: { clipIds: [first?.id ?? ""], range: { end: 12, start: 0 } },
		});
		expect(text.startsWith("Tighten this cut\n")).toBe(true);
		expect(text).toContain(`id ${timeline.id}, saved revision 7`);
		expect(text).toContain("unsaved changes");
		expect(text).toContain("- Time range: 0.000s-12.000s");
		expect(text).toContain("- Selected clips (1):");
		expect(text).toContain(`- ${first?.id}: "clip.mp4" (video) on track 0`);
		expect(text).toContain("- Other clips in range:");
		expect(text).toContain(`- ${second?.id}:`);
		expect(text).toContain(
			`/api/video-studio/projects/${timeline.id}/timeline`
		);
	});

	test("clips outside the range are left out and a blank question gets a default", () => {
		const { asset, project: timeline } = project();
		const [, second] = timeline.segments;
		const text = composeAgentHandoff({
			assets: [asset],
			dirty: false,
			project: timeline,
			question: "   ",
			scope: { clipIds: [], range: { end: 3, start: 0 } },
		});
		expect(text.startsWith("Please review")).toBe(true);
		expect(text).not.toContain(second?.id ?? "-");
		expect(text).not.toContain("unsaved");
	});

	test("large timelines stay inside the chat.send limit", () => {
		const asset = testVideo("long-source-name.mp4", 7200);
		const { project: timeline } = project();
		const segments = Array.from({ length: 400 }, (_, index) => ({
			...newSegment(asset, index * 2),
			sourceOut: 2,
		}));
		const text = composeAgentHandoff({
			assets: [asset],
			dirty: false,
			project: { ...timeline, segments },
			question: "x".repeat(5000),
			scope: { clipIds: [], range: null },
		});
		expect(text.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
		expect(text).toMatch(/\.\.\.and \d+ more clip\(s\) not listed/);
		expect(text).toContain("/timeline; edits take the saved revision.");
	});

	test("many selected clips share the budget and keep the closing lines", () => {
		const asset = testVideo("clip.mp4", 7200);
		const { project: timeline } = project();
		const segments = Array.from({ length: 120 }, (_, index) => ({
			...newSegment(asset, index * 2),
			sourceOut: 2,
		}));
		const extra = Array.from({ length: 40 }, (_, index) => ({
			...newSegment(asset, index * 2),
			sourceOut: 2,
			track: 1,
		}));
		const text = composeAgentHandoff({
			assets: [asset],
			dirty: false,
			project: { ...timeline, segments: [...segments, ...extra] },
			question: "x".repeat(5000),
			scope: { clipIds: segments.map((segment) => segment.id), range: null },
		});
		expect(text.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
		expect(text).toContain("- Selected clips (120):");
		expect(text).toMatch(/- \.\.\.and \d+ more clip\(s\) not listed/);
		expect(text).toContain("- Timeline clips: 40 clip(s) not listed");
		expect(text.endsWith("/timeline; edits take the saved revision.")).toBe(
			true
		);
		const listed = text
			.split("\n")
			.filter((line) => line.startsWith("- ") && line.includes('"clip.mp4"'));
		const omitted = Number(text.match(/and (\d+) more/)?.[1]);
		expect(listed.length + omitted).toBe(120);
	});
});

describe("host chat bridge", () => {
	const raw = [
		{ archived: false, id: "old", title: "Old", updated_at: 1 },
		{ id: "new", last_message_at: 50, title: null, updated_at: 5 },
		{ archived: true, id: "gone", title: "Archived", updated_at: 99 },
	];

	test("lists unarchived chats, most recent first", () => {
		expect(handoffConversations(raw)).toEqual([
			{ id: "new", title: "Untitled chat", updatedAt: 50 },
			{ id: "old", title: "Old", updatedAt: 1 },
		]);
	});

	test("sends one message and reports the accepted chat", async () => {
		const sent: unknown[] = [];
		const chat: StudioChat = {
			list: async () => raw,
			send: async (input) => {
				sent.push(input);
				return { conversation_id: input.conversationId, status: "accepted" };
			},
		};
		expect(await listHandoffConversations(chat)).toHaveLength(2);
		expect(await sendAgentHandoff("new", "hello", chat)).toEqual({
			conversationId: "new",
		});
		expect(sent).toEqual([{ conversationId: "new", text: "hello" }]);
	});

	test("refuses without the grant, a chat, or a valid message", async () => {
		const chat: StudioChat = {
			list: async () => [],
			send: async () => ({ status: "rejected" }),
		};
		await expect(listHandoffConversations(undefined)).rejects.toThrow(
			"chat.sendFollowUp"
		);
		await expect(sendAgentHandoff("", "hi", chat)).rejects.toThrow(
			"Choose a chat"
		);
		await expect(
			sendAgentHandoff("a", "x".repeat(MAX_HANDOFF_CHARS + 1), chat)
		).rejects.toThrow("too long");
		await expect(sendAgentHandoff("a", "hi", chat)).rejects.toThrow();
	});

	test("a host capability refusal reads as missing chat access", async () => {
		const denied = Object.assign(
			new Error(
				"Capability not granted: chat.sendFollowUp (required by chat.list)"
			),
			{ code: "denied" }
		);
		const chat: StudioChat = {
			list: () => Promise.reject(denied),
			send: () => Promise.reject(denied),
		};
		expect(isChatAccessDenied(denied)).toBe(true);
		expect(isChatAccessDenied(new Error("Capability not granted: x"))).toBe(
			true
		);
		expect(isChatAccessDenied(new Error("network down"))).toBe(false);
		await expect(listHandoffConversations(chat)).rejects.toBeInstanceOf(
			ChatAccessError
		);
		await expect(sendAgentHandoff("a", "hi", chat)).rejects.toBeInstanceOf(
			ChatAccessError
		);
		const broken: StudioChat = {
			list: () => Promise.reject(new Error("network down")),
			send: async () => ({}),
		};
		await expect(listHandoffConversations(broken)).rejects.toThrow(
			"network down"
		);
	});
});

describe("marker handoff", () => {
	const markers = [
		{
			comment: "Audio  pops\nhere",
			id: crypto.randomUUID(),
			label: "Pop",
			status: "open" as const,
			time: 2,
		},
		{ duration: 3, id: crypto.randomUUID(), label: "Act two", time: 5 },
		{ id: crypto.randomUUID(), label: "Credits", time: 20 },
	];

	test("a marker's scope covers its span and names it", () => {
		expect(markerHandoffScope(markers[1] as (typeof markers)[number])).toEqual({
			clipIds: [],
			markerIds: [markers[1]?.id ?? ""],
			range: { end: 8, start: 5 },
		});
	});

	test("explicit markers come first, then markers overlapping the range", () => {
		const scope = {
			clipIds: [],
			markerIds: [markers[2]?.id ?? ""],
			range: { end: 6, start: 1 },
		};
		expect(
			handoffMarkers(markers, scope).map((marker) => marker.label)
		).toEqual(["Credits", "Pop", "Act two"]);
		expect(handoffMarkers(markers, { clipIds: [], range: null })).toHaveLength(
			0
		);
	});

	test("the message lists marker label, time, status and comment", () => {
		const { project } = testProject();
		const text = composeAgentHandoff({
			assets: [],
			dirty: false,
			project: { ...project, markers },
			question: "Fix this",
			scope: markerHandoffScope(markers[0] as (typeof markers)[number]),
		});
		expect(text).toContain("the first is the one asked about");
		expect(text).toContain(
			`- ${markers[0]?.id}: "Pop" at 2.000s, status open, comment "Audio pops here"`
		);
		expect(text).not.toContain("Credits");
	});
});
