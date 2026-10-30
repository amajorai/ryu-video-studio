import { clipAudioMutedOf } from "../../../shared/clip-speed.ts";
import { cutsInside } from "../../../shared/cut-ops.ts";
import {
	detachAudioState,
	extractableAudioRefusal,
} from "../../../shared/detach-audio.ts";
import type {
	Asset,
	ClipColorLabel,
	Project,
	Segment,
} from "../../../shared/project.ts";
import { placementKindOf } from "../../../shared/track-placement.ts";
import {
	CLIP_COLOR_LABELS,
	CLIP_COLOR_SWATCHES,
	clipColorName,
} from "./clip-meta.ts";

/**
 * Editor action ids the clip menu dispatches. Most exist in the shortcut
 * registry today (recover audio is registered by the menu from the audio
 * detach actions); the rest are reserved names for later features (nest,
 * agent handoff, AI edit). An id without a registered handler is
 * shown disabled as "Not available", so a feature lights up its menu item
 * just by registering a handler under that id.
 */
export const CLIP_MENU_ACTIONS = {
	askAgent: "ai.askAgent",
	copy: "clipboard.copy",
	cut: "clipboard.cut",
	delete: "clip.delete",
	detachAudio: "audio.detachSelected",
	duplicate: "clipboard.duplicate",
	editWithAi: "ai.editClip",
	hide: "tracks.toggleClipHidden",
	mute: "tracks.toggleClipMute",
	nest: "nest.nest",
	paste: "clipboard.paste",
	pasteSettings: "clipboard.pasteSettings",
	recoverAudio: "audio.recoverSelected",
	rippleDelete: "ripple.deleteSelection",
	selectAllOnTrack: "select.allOnTrack",
	split: "split.selected",
} as const;

/** Menu-local operations that call existing routes or editor helpers. */
export type ClipMenuCommand =
	| "duplicateToNewTrack"
	| "freezeFrame"
	| "moveToNewTrack"
	| "rename"
	| "revealInLibrary"
	| "reverse"
	| "speed"
	| "splitAtPointer";

/** What choosing a menu item does. */
export type ClipMenuRun =
	| { action: string; type: "action" }
	| { command: ClipMenuCommand; type: "command" }
	| { color: ClipColorLabel | undefined; type: "color" }
	| { assetId: string; type: "swap" };

export interface ClipMenuItem {
	/** Checkbox state for toggles (mute, hide, the current color). */
	checked?: boolean;
	/** Submenu entries; an item with children is a submenu trigger. */
	children?: ClipMenuItem[];
	destructive?: boolean;
	/** Why the item cannot run now; absent when it is enabled. */
	disabledReason?: string;
	id: string;
	label: string;
	run?: ClipMenuRun;
	/** Color swatch shown before the label. */
	swatch?: string;
}

export interface ClipMenuSection {
	id: "audio" | "edit" | "label" | "media" | "placement";
	items: ClipMenuItem[];
	label: string;
}

export interface ClipMenuContext {
	/** Media of the clicked clip, when it is still in the library. */
	asset?: Asset;
	assets: readonly Asset[];
	/** Whether the clip clipboard holds clips or overlays. */
	clipboardReady: boolean;
	/** Whether an editor action id has a registered handler. */
	hasHandler: (action: string) => boolean;
	/** Whether the clip sits on a locked track. */
	locked: boolean;
	/** Timeline time under the pointer when the menu opened. */
	pointerTime?: number;
	/** Full project: detach/recover state reads link groups and track locks. */
	project: Project;
	segment: Segment;
	/** Whether copied clip settings are waiting to be pasted. */
	settingsReady: boolean;
	/** Playhead time. */
	time: number;
}

/** Reason shown on items whose action has no handler yet. */
export const NOT_AVAILABLE = "Not available";
const LOCKED = "Unlock this track to edit the clip.";
/** Library assets listed in the Replace media submenu. */
export const MAX_SWAP_CHOICES = 24;

function actionItem(
	context: ClipMenuContext,
	id: string,
	label: string,
	action: string,
	extra: Omit<ClipMenuItem, "id" | "label" | "run"> = {}
): ClipMenuItem {
	return {
		...extra,
		disabledReason: context.hasHandler(action)
			? extra.disabledReason
			: NOT_AVAILABLE,
		id,
		label,
		run: { action, type: "action" },
	};
}

function commandItem(
	id: string,
	label: string,
	command: ClipMenuCommand,
	disabledReason?: string
): ClipMenuItem {
	return {
		disabledReason,
		id,
		label,
		run: { command, type: "command" },
	};
}

/** First reason in `reasons` that applies (a truthy string), if any. */
const firstReason = (...reasons: (string | false | undefined)[]) =>
	reasons.find((reason): reason is string => Boolean(reason));

function splitItem(context: ClipMenuContext): ClipMenuItem {
	const { locked, pointerTime, segment, time } = context;
	if (cutsInside(segment, time)) {
		return actionItem(
			context,
			"split",
			"Split at playhead",
			CLIP_MENU_ACTIONS.split,
			{ disabledReason: firstReason(locked && LOCKED) }
		);
	}
	return commandItem(
		"split",
		"Split here",
		"splitAtPointer",
		firstReason(
			locked && LOCKED,
			!(pointerTime !== undefined && cutsInside(segment, pointerTime)) &&
				"Place the playhead inside the clip to split it."
		)
	);
}

function editSection(context: ClipMenuContext): ClipMenuSection {
	const lockedReason = firstReason(context.locked && LOCKED);
	return {
		id: "edit",
		items: [
			splitItem(context),
			actionItem(context, "cut", "Cut", CLIP_MENU_ACTIONS.cut, {
				disabledReason: lockedReason,
			}),
			actionItem(context, "copy", "Copy", CLIP_MENU_ACTIONS.copy),
			actionItem(
				context,
				"paste",
				"Paste at playhead",
				CLIP_MENU_ACTIONS.paste,
				{
					disabledReason: firstReason(
						!context.clipboardReady && "Copy or cut clips first."
					),
				}
			),
			actionItem(
				context,
				"paste-settings",
				"Paste settings",
				CLIP_MENU_ACTIONS.pasteSettings,
				{
					disabledReason: firstReason(
						lockedReason,
						!(context.settingsReady || context.clipboardReady) &&
							"Copy a clip or its settings first."
					),
				}
			),
			actionItem(
				context,
				"duplicate",
				"Duplicate",
				CLIP_MENU_ACTIONS.duplicate
			),
			actionItem(
				context,
				"select-track",
				"Select all on track",
				CLIP_MENU_ACTIONS.selectAllOnTrack
			),
			actionItem(context, "delete", "Delete", CLIP_MENU_ACTIONS.delete, {
				destructive: true,
				disabledReason: lockedReason,
			}),
			actionItem(
				context,
				"ripple-delete",
				"Ripple delete",
				CLIP_MENU_ACTIONS.rippleDelete,
				{ destructive: true, disabledReason: lockedReason }
			),
		],
		label: "Edit",
	};
}

const hasSound = (asset: Asset | undefined) =>
	asset?.kind === "audio" || Boolean(asset?.hasAudio);

function labelSection(context: ClipMenuContext): ClipMenuSection {
	const { asset, segment } = context;
	const lockedReason = firstReason(context.locked && LOCKED);
	const colors: ClipMenuItem[] = [
		{
			checked: segment.color === undefined,
			id: "color-none",
			label: "No color",
			run: { color: undefined, type: "color" },
		},
		...CLIP_COLOR_LABELS.map(
			(color): ClipMenuItem => ({
				checked: segment.color === color,
				id: `color-${color}`,
				label: clipColorName(color),
				run: { color, type: "color" },
				swatch: CLIP_COLOR_SWATCHES[color],
			})
		),
	];
	return {
		id: "label",
		items: [
			actionItem(context, "mute", "Mute clip", CLIP_MENU_ACTIONS.mute, {
				checked: clipAudioMutedOf(segment),
				disabledReason: firstReason(
					lockedReason,
					!hasSound(asset) && "This clip has no audio."
				),
			}),
			actionItem(context, "hide", "Hide clip", CLIP_MENU_ACTIONS.hide, {
				checked: segment.hidden === true,
				disabledReason: firstReason(
					lockedReason,
					asset?.kind === "audio" && "Audio clips have no picture."
				),
			}),
			commandItem("rename", "Rename…", "rename", lockedReason),
			{
				children: colors.map((item) => ({
					...item,
					disabledReason: lockedReason,
				})),
				disabledReason: lockedReason,
				id: "color",
				label: "Color",
			},
		],
		label: "Label",
	};
}

/** Why Detach audio cannot run on a clip the shared rules reject. */
function detachRefusal(context: ClipMenuContext): string {
	const { asset } = context;
	if (context.locked) {
		return LOCKED;
	}
	if (!asset) {
		return "This clip's media is missing from the library.";
	}
	return (
		extractableAudioRefusal(asset) ??
		"This clip is already linked to an audio clip."
	);
}

/**
 * Recover or Detach, decided by the shared detach rules: a clip in a detached
 * pair (the camera clip or its extracted audio) recovers; anything else offers
 * Detach, disabled with the shared refusal when it cannot run.
 */
function audioSection(context: ClipMenuContext): ClipMenuSection {
	const { assets, project, segment } = context;
	const lockedReason = firstReason(context.locked && LOCKED);
	const state = detachAudioState(project, assets, segment.id);
	const item =
		state === "recover"
			? actionItem(
					context,
					"recover-audio",
					"Recover audio",
					CLIP_MENU_ACTIONS.recoverAudio,
					{ disabledReason: lockedReason }
				)
			: actionItem(
					context,
					"detach-audio",
					"Detach audio",
					CLIP_MENU_ACTIONS.detachAudio,
					{
						disabledReason:
							state === "detach" && !context.locked
								? undefined
								: detachRefusal(context),
					}
				);
	return { id: "audio", items: [item], label: "Audio" };
}

function mediaSection(context: ClipMenuContext): ClipMenuSection {
	const { asset, segment, time } = context;
	const lockedReason = firstReason(context.locked && LOCKED);
	const multicam = firstReason(
		segment.multicamGroupId !== undefined && "Multicam clips cannot do this."
	);
	const atPlayhead = cutsInside(segment, time);
	return {
		id: "media",
		items: [
			commandItem(
				"freeze-frame",
				atPlayhead ? "Freeze frame at playhead" : "Freeze last frame",
				"freezeFrame",
				firstReason(
					lockedReason,
					asset?.kind !== "video" &&
						"Freeze frames can only be made from video clips.",
					multicam
				)
			),
			commandItem(
				"reverse",
				asset?.derivation === "reverse" ? "Restore forward" : "Reverse",
				"reverse",
				firstReason(
					lockedReason,
					!(asset?.kind === "video" || asset?.kind === "audio") &&
						"Choose a video or audio clip to reverse.",
					multicam
				)
			),
			commandItem(
				"speed",
				"Speed and ramps…",
				"speed",
				firstReason(
					asset?.kind === "image" && "Still images have no playback speed."
				)
			),
		],
		label: "Media",
	};
}

function swapChoices(context: ClipMenuContext): ClipMenuItem[] {
	const { asset, assets, segment } = context;
	if (!asset) {
		return [];
	}
	const kind = placementKindOf(asset.kind);
	return assets
		.filter(
			(candidate) =>
				candidate.id !== segment.assetId &&
				placementKindOf(candidate.kind) === kind
		)
		.slice(0, MAX_SWAP_CHOICES)
		.map((candidate) => ({
			id: `swap-${candidate.id}`,
			label: candidate.name,
			run: { assetId: candidate.id, type: "swap" },
		}));
}

function placementSection(context: ClipMenuContext): ClipMenuSection {
	const { asset, segment } = context;
	const lockedReason = firstReason(context.locked && LOCKED);
	const choices = swapChoices(context);
	return {
		id: "placement",
		items: [
			commandItem(
				"reveal",
				"Reveal in library",
				"revealInLibrary",
				firstReason(!asset && "This clip's media is missing from the library.")
			),
			{
				children: choices,
				disabledReason: firstReason(
					lockedReason,
					segment.multicamGroupId !== undefined &&
						"Ungroup the multicam session before swapping its media.",
					!choices.length && "Import other media of the same kind first."
				),
				id: "replace",
				label: "Replace media",
			},
			commandItem(
				"move-new-track",
				"Move to new track",
				"moveToNewTrack",
				lockedReason
			),
			commandItem(
				"duplicate-new-track",
				"Duplicate to new track",
				"duplicateToNewTrack"
			),
			actionItem(context, "nest", "Nest", CLIP_MENU_ACTIONS.nest, {
				disabledReason: lockedReason,
			}),
			actionItem(context, "ask-agent", "Ask agent", CLIP_MENU_ACTIONS.askAgent),
			actionItem(
				context,
				"edit-with-ai",
				"Edit with AI",
				CLIP_MENU_ACTIONS.editWithAi,
				{ disabledReason: lockedReason }
			),
		],
		label: "Placement and AI",
	};
}

/**
 * The clip context menu, as data: sections of items with their enabled
 * state. Pure, so the rules are tested without rendering the menu.
 */
export function clipMenuModel(context: ClipMenuContext): ClipMenuSection[] {
	return [
		editSection(context),
		labelSection(context),
		audioSection(context),
		mediaSection(context),
		placementSection(context),
	];
}

/** Every item in `sections`, submenu entries included, depth first. */
export function flattenClipMenu(
	sections: readonly ClipMenuSection[]
): ClipMenuItem[] {
	const walk = (items: readonly ClipMenuItem[]): ClipMenuItem[] =>
		items.flatMap((item) => [item, ...walk(item.children ?? [])]);
	return sections.flatMap((section) => walk(section.items));
}
