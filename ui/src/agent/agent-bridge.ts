import { z } from "zod";
import {
	type Asset,
	type Marker,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
} from "../../../shared/project.ts";
import { timelineSummary } from "../../../shared/timeline-summary.ts";

/** `chat.send` rejects longer text; the handoff stays inside it. */
export const MAX_HANDOFF_CHARS = 8000;
/** The viewer's own question keeps at most this much of the budget. */
export const MAX_HANDOFF_QUESTION_CHARS = 2000;
/** The host grant the handoff needs (`chat.list` and `chat.send`). */
export const AGENT_HANDOFF_GRANT = "chat.sendFollowUp";

export interface HandoffRange {
	end: number;
	start: number;
}

/** What the agent is asked about: clips, a time range, or both. */
export interface HandoffScope {
	clipIds: string[];
	/**
	 * Markers handed off explicitly ("Ask agent about this marker"). Markers
	 * overlapping the range are listed either way.
	 */
	markerIds?: string[];
	/** Null asks about the whole timeline. */
	range: HandoffRange | null;
}

/** The handoff scope for one review marker: its time (or span) and the marker. */
export function markerHandoffScope(marker: Marker): HandoffScope {
	const end = marker.time + Math.max(marker.duration ?? 0, 0);
	return {
		clipIds: [],
		markerIds: [marker.id],
		range: {
			end: Math.max(end, marker.time + RANGE_EPSILON * 2),
			start: marker.time,
		},
	};
}

const RANGE_EPSILON = 0.000_001;

const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);

/**
 * The range a fresh editor starts with (`App.tsx`, `openFresh`). The editor
 * always holds some range, so this default means "nothing was marked".
 */
export const EDITOR_DEFAULT_RANGE: Readonly<HandoffRange> = {
	end: 1,
	start: 0,
};

const sameRange = (a: HandoffRange, b: HandoffRange) =>
	Math.abs(a.start - b.start) <= RANGE_EPSILON &&
	Math.abs(a.end - b.end) <= RANGE_EPSILON;

/**
 * The range the viewer marked, or null when none was. An explicit
 * `rangeMarked` flag wins; without one, the editor's untouched default range
 * and empty ranges count as unmarked.
 */
export function markedRange(
	range: HandoffRange,
	rangeMarked?: boolean
): HandoffRange | null {
	if (range.end - range.start <= RANGE_EPSILON) {
		return null;
	}
	const marked = rangeMarked ?? !sameRange(range, EDITOR_DEFAULT_RANGE);
	return marked ? { end: range.end, start: range.start } : null;
}

/**
 * The handoff scope for the editor's selection and marked range. A marked
 * range wins; otherwise the selected clips' span is used; with neither, the
 * scope is the whole timeline. Unknown clip ids are dropped.
 */
export function handoffScope(input: {
	/** The range the viewer marked; null when none was (see `markedRange`). */
	range: HandoffRange | null;
	segments: readonly Segment[];
	selectedIds: readonly string[];
}): HandoffScope {
	const selected = input.segments.filter((segment) =>
		input.selectedIds.includes(segment.id)
	);
	const clipIds = selected.map((segment) => segment.id);
	if (input.range && input.range.end - input.range.start > RANGE_EPSILON) {
		return {
			clipIds,
			range: { end: input.range.end, start: input.range.start },
		};
	}
	if (selected.length === 0) {
		return { clipIds, range: null };
	}
	return {
		clipIds,
		range: {
			end: Math.max(...selected.map(clipEnd)),
			start: Math.min(...selected.map((segment) => segment.start)),
		},
	};
}

const seconds = (value: number) => `${value.toFixed(3)}s`;

function clipLine(segment: Segment, assets: ReadonlyMap<string, Asset>) {
	const asset = assets.get(segment.assetId);
	const name = asset?.name ?? "Missing media";
	return `- ${segment.id}: "${name}" (${asset?.kind ?? "media"}) on track ${segment.track}, timeline ${seconds(segment.start)}-${seconds(clipEnd(segment))}, source ${seconds(segment.sourceIn)}-${seconds(segment.sourceOut)}, speed ${segment.speed}x`;
}

const markerEnd = (marker: Marker) => marker.time + (marker.duration ?? 0);

/** Markers in the handoff: the explicit ones first, then those in the range. */
export function handoffMarkers(
	markers: readonly Marker[],
	scope: HandoffScope
): Marker[] {
	const explicit = new Set(scope.markerIds ?? []);
	const inRange = (marker: Marker) =>
		scope.range !== null &&
		marker.time <= scope.range.end + RANGE_EPSILON &&
		markerEnd(marker) >= scope.range.start - RANGE_EPSILON;
	return [
		...markers.filter((marker) => explicit.has(marker.id)),
		...markers
			.filter((marker) => !explicit.has(marker.id) && inRange(marker))
			.sort((a, b) => a.time - b.time),
	];
}

const MAX_MARKER_COMMENT_CHARS = 400;

function markerLine(marker: Marker) {
	const span = marker.duration
		? `${seconds(marker.time)}-${seconds(markerEnd(marker))}`
		: `at ${seconds(marker.time)}`;
	const status = marker.status ? `, status ${marker.status}` : "";
	const comment = marker.comment?.trim()
		? `, comment "${marker.comment.trim().replace(/\s+/g, " ").slice(0, MAX_MARKER_COMMENT_CHARS)}"`
		: "";
	return `- ${marker.id}: "${marker.label}" ${span}${status}${comment}`;
}

const overlaps = (segment: Segment, range: HandoffRange | null) =>
	!range ||
	(segment.start < range.end - RANGE_EPSILON &&
		clipEnd(segment) > range.start + RANGE_EPSILON);

/** Room kept for the "...and N more" lines so they always fit. */
const OMISSION_RESERVE = 120;
const MAX_TITLE_CHARS = 200;

/**
 * Append `entries` under `label` while they fit `budget`; the rest are
 * counted in one "...and N more" line. Returns the new text length.
 */
function appendBudgeted(
	lines: string[],
	length: number,
	budget: number,
	label: string,
	entries: readonly string[],
	noun = "clip(s)"
): number {
	if (entries.length === 0) {
		return length;
	}
	let used = length;
	let omitted = 0;
	const labelCost = label.length + 1;
	if (used + labelCost + (entries[0]?.length ?? 0) + 1 > budget) {
		omitted = entries.length;
	} else {
		lines.push(label);
		used += labelCost;
		for (const entry of entries) {
			if (omitted > 0 || used + entry.length + 1 > budget) {
				omitted++;
				continue;
			}
			lines.push(entry);
			used += entry.length + 1;
		}
	}
	if (omitted > 0) {
		const note =
			omitted === entries.length
				? `${label.replace(/:$/, "")}: ${omitted} ${noun} not listed`
				: `- ...and ${omitted} more ${noun} not listed`;
		lines.push(note);
		used += note.length + 1;
	}
	return used;
}

/**
 * The message the agent receives: the viewer's question, then the project
 * id and revision, the scope, the selected clips, and a compact timeline
 * summary. Selected and other clip lines share one budget; lines outside it
 * are counted, not sent, so the text always fits `chat.send` and keeps its
 * closing instructions.
 */
export function composeAgentHandoff(input: {
	assets: readonly Asset[];
	/** Local edits not yet saved; the agent only sees the saved revision. */
	dirty: boolean;
	project: Project;
	question: string;
	scope: HandoffScope;
}): string {
	const { project, scope } = input;
	const question =
		input.question.trim().slice(0, MAX_HANDOFF_QUESTION_CHARS) ||
		"Please review this part of my Video Studio timeline.";
	const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
	const summary = timelineSummary(project, [...input.assets]);
	const duration = projectDuration(project);
	const selected = project.segments.filter((segment) =>
		scope.clipIds.includes(segment.id)
	);
	const lines = [
		question,
		"",
		"---",
		"Video Studio context",
		`- Project: "${project.title.slice(0, MAX_TITLE_CHARS)}" (id ${project.id}, saved revision ${project.revision}${input.dirty ? "; the editor has unsaved changes that are not in this revision" : ""})`,
		`- Canvas: ${project.width}x${project.height} at ${project.fps} fps, duration ${seconds(duration)}, ${summary.tracks.length} track(s), ${project.segments.length} clip(s), ${summary.captions} caption(s)`,
		scope.range
			? `- Time range: ${seconds(scope.range.start)}-${seconds(scope.range.end)}`
			: "- Time range: the whole timeline",
	];
	const tail = [
		"",
		`Read the full timeline with GET /api/video-studio/projects/${project.id}/timeline; edits take the saved revision.`,
	];
	const candidates = project.segments
		.filter(
			(segment) =>
				overlaps(segment, scope.range) && !scope.clipIds.includes(segment.id)
		)
		.sort((a, b) => a.start - b.start || a.track - b.track);
	// Each "...and N more" line is reserved up front, one per group.
	const budget =
		MAX_HANDOFF_CHARS - tail.join("\n").length - 1 - 3 * OMISSION_RESERVE;
	let length = lines.join("\n").length;
	const markers = handoffMarkers(project.markers, scope);
	length = appendBudgeted(
		lines,
		length,
		budget,
		scope.markerIds?.length
			? `- Review markers (${markers.length}; the first is the one asked about):`
			: `- Review markers in range (${markers.length}):`,
		markers.map(markerLine),
		"marker(s)"
	);
	length = appendBudgeted(
		lines,
		length,
		budget,
		`- Selected clips (${selected.length}):`,
		selected.map((segment) => clipLine(segment, assets))
	);
	appendBudgeted(
		lines,
		length,
		budget,
		scope.range ? "- Other clips in range:" : "- Timeline clips:",
		candidates.map((segment) => clipLine(segment, assets))
	);
	const text = [...lines, ...tail].join("\n");
	// Unreachable with the reserves above; kept so chat.send never rejects.
	return text.length > MAX_HANDOFF_CHARS
		? text.slice(0, MAX_HANDOFF_CHARS)
		: text;
}

/** One existing chat the handoff can post into. */
export interface HandoffConversation {
	id: string;
	title: string;
	updatedAt: number;
}

const conversationSchema = z.object({
	archived: z.boolean().optional(),
	id: z.string().min(1),
	last_message_at: z.number().optional(),
	title: z.string().nullable(),
	updated_at: z.number(),
});
const sendResultSchema = z.object({
	conversation_id: z.string(),
	status: z.literal("accepted"),
});

const CHAT_ACCESS_MESSAGE = `Ask agent needs chat access. Approve the ${AGENT_HANDOFF_GRANT} permission for Video Studio.`;

/**
 * The chat bridge is missing or the host refused it for lack of the
 * `chat.sendFollowUp` grant. The host installs `window.ryu.chat` whether or
 * not the grant is approved, so only an RPC answer can tell.
 */
export class ChatAccessError extends Error {
	constructor(cause?: unknown) {
		super(CHAT_ACCESS_MESSAGE, cause === undefined ? undefined : { cause });
		this.name = "ChatAccessError";
	}
}

/**
 * True when a host RPC rejection means the capability is not granted: the
 * coded `denied` error of the app bridge, or the legacy capability message.
 */
export function isChatAccessDenied(error: unknown): boolean {
	if (error instanceof ChatAccessError) {
		return true;
	}
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as Error & { code?: unknown }).code;
	return (
		code === "denied" || error.message.startsWith("Capability not granted")
	);
}

async function callChat<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		throw isChatAccessDenied(error) ? new ChatAccessError(error) : error;
	}
}

/** The host chat bridge as a companion frame sees it (grant not implied). */
export interface StudioChat {
	list: () => Promise<unknown>;
	send: (input: { conversationId: string; text: string }) => Promise<unknown>;
}

/**
 * The host chat bridge, or undefined outside Ryu. Its presence does not mean
 * the grant is approved; calls reject with `ChatAccessError` when it is not.
 */
export function hostChat(): StudioChat | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}
	const host = window.ryu as
		| (NonNullable<typeof window.ryu> & { chat?: Partial<StudioChat> })
		| undefined;
	const chat = host?.chat;
	if (typeof chat?.list === "function" && typeof chat.send === "function") {
		return { list: chat.list, send: chat.send };
	}
	return undefined;
}

/** Visible, unarchived chats, most recently active first. */
export function handoffConversations(raw: unknown): HandoffConversation[] {
	return z
		.array(conversationSchema)
		.parse(raw)
		.filter((conversation) => !conversation.archived)
		.map((conversation) => ({
			id: conversation.id,
			title: conversation.title?.trim() || "Untitled chat",
			updatedAt: Math.max(
				conversation.updated_at,
				conversation.last_message_at ?? 0
			),
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function listHandoffConversations(
	chat: StudioChat | undefined = hostChat()
): Promise<HandoffConversation[]> {
	if (!chat) {
		throw new ChatAccessError();
	}
	return handoffConversations(await callChat(() => chat.list()));
}

/** Post the handoff as one user turn; resolves once the host accepts it. */
export async function sendAgentHandoff(
	conversationId: string,
	text: string,
	chat: StudioChat | undefined = hostChat()
): Promise<{ conversationId: string }> {
	if (!chat) {
		throw new ChatAccessError();
	}
	if (!conversationId.trim()) {
		throw new Error("Choose a chat to send the question to.");
	}
	if (!text.trim() || text.length > MAX_HANDOFF_CHARS) {
		throw new Error("The agent message is empty or too long.");
	}
	const result = sendResultSchema.parse(
		await callChat(() => chat.send({ conversationId, text }))
	);
	return { conversationId: result.conversation_id };
}
