import { type Project, trackSettingFor } from "./project.ts";

export function timelineDeletion(
	project: Project,
	selectedIds: readonly string[]
) {
	const ids = new Set(selectedIds);
	const linkedGroups = new Set(
		project.segments
			.filter((segment) => ids.has(segment.id) && segment.linkGroupId)
			.map((segment) => segment.linkGroupId)
	);
	for (const segment of project.segments) {
		if (segment.linkGroupId && linkedGroups.has(segment.linkGroupId)) {
			ids.add(segment.id);
		}
	}
	return {
		ids,
		locked: project.segments.some(
			(segment) =>
				ids.has(segment.id) && trackSettingFor(project, segment.track).locked
		),
	};
}
