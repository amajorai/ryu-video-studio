/**
 * Lip-sync link upkeep for timeline edits. It imports only types from
 * `project.ts`, so edit modules that `project.ts` itself loads (ripple) can
 * use it without an import cycle.
 */
import type { Avatar, Project } from "./project.ts";

/**
 * Unpin lip-sync links from clips an edit removed or re-minted: the link keeps
 * its media (the avatar then follows that media from its own start) and loses
 * only `segmentId`, as clip deletes do. Ops that remove clips internally
 * (ripple delete, speed ramps) run this before `validateProject`. Returns the
 * same project object when nothing changes.
 */
export function unpinRemovedLipSyncClips(project: Project): Project {
	const segmentIds = new Set(project.segments.map((segment) => segment.id));
	const removed = (avatar: Avatar) =>
		avatar.lipSync?.segmentId !== undefined &&
		!segmentIds.has(avatar.lipSync.segmentId);
	if (!project.avatars.some(removed)) {
		return project;
	}
	return {
		...project,
		avatars: project.avatars.map((avatar) => {
			if (!(removed(avatar) && avatar.lipSync)) {
				return avatar;
			}
			const { segmentId: _removed, ...lipSync } = avatar.lipSync;
			return { ...avatar, lipSync };
		}),
	};
}
