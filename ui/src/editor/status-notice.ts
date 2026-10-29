import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../../../shared/project.ts";

/** How long a transient notice stays in the status line. */
export const STATUS_NOTICE_MS = 6000;

/**
 * When a status message goes away by itself: `"edit"` on the next timeline
 * edit (adding the imported media is one) or after `STATUS_NOTICE_MS`,
 * whichever comes first; a number clears it after that many milliseconds.
 * Without options a message stays until the next one.
 */
export interface StatusOptions {
	clearOn: "edit" | number;
}

/**
 * The parts of a project an edit replaces. Saves and rebases keep these
 * arrays, so only a real timeline edit changes the stamp.
 */
export function editStamp(project: Project | null): readonly unknown[] {
	return project
		? [
				project.segments,
				project.titles,
				project.captions,
				project.captionTracks,
				project.graphics,
				project.markers,
				project.trackSettings,
				project.adjustmentLayers,
			]
		: [];
}

const sameStamp = (left: readonly unknown[], right: readonly unknown[]) =>
	left.length === right.length &&
	left.every((value, index) => Object.is(value, right[index]));

interface PendingNotice {
	clearOnEdit: boolean;
	stamp: readonly unknown[];
	text: string;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Status-line notices that expire. `setStatus(text, options)` shows `text`;
 * with options it clears itself (only if it is still the shown message) on
 * the next edit or after its timeout.
 */
export function createStatusNotices(
	show: (update: string | ((current: string) => string)) => void,
	scheduler: {
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
		setTimeout: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
	} = globalThis
) {
	let pending: PendingNotice | null = null;
	const clear = () => {
		const notice = pending;
		if (!notice) {
			return;
		}
		scheduler.clearTimeout(notice.timer);
		pending = null;
		show((current) => (current === notice.text ? "" : current));
	};
	return {
		/** Stop the pending timer (unmount). */
		dispose: () => {
			if (pending) {
				scheduler.clearTimeout(pending.timer);
				pending = null;
			}
		},
		/** The project changed: clear an edit-bound notice on a real edit. */
		projectChanged: (stamp: readonly unknown[]) => {
			if (pending?.clearOnEdit && !sameStamp(pending.stamp, stamp)) {
				clear();
			}
		},
		set: (text: string, stamp: readonly unknown[], options?: StatusOptions) => {
			if (pending) {
				scheduler.clearTimeout(pending.timer);
				pending = null;
			}
			show(text);
			if (!options) {
				return;
			}
			const ms =
				options.clearOn === "edit" ? STATUS_NOTICE_MS : options.clearOn;
			pending = {
				clearOnEdit: options.clearOn === "edit",
				stamp,
				text,
				timer: scheduler.setTimeout(clear, ms),
			};
		},
	};
}

/** The editor's status line, with expiring notices bound to `project`. */
export function useStatusLine(initial: string, project: Project | null) {
	const [status, setText] = useState(initial);
	const [notices] = useState(() => createStatusNotices(setText));
	const projectRef = useRef(project);
	projectRef.current = project;
	useEffect(() => notices.dispose, [notices]);
	useEffect(() => {
		notices.projectChanged(editStamp(project));
	}, [notices, project]);
	const setStatus = useCallback(
		(text: string, options?: StatusOptions) =>
			notices.set(text, editStamp(projectRef.current), options),
		[notices]
	);
	return { setStatus, status };
}
