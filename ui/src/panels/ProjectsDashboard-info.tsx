import { useLiteralMessages } from "@ryu/i18n/react";
import type { ProjectSummary } from "../../../shared/project-summary.ts";
import {
	formatProjectDate,
	formatProjectDuration,
} from "../projects/dashboard-model.ts";

/** Details of one project, shown below the dashboard list. */
export function ProjectsDashboardInfo({ info }: { info: ProjectSummary }) {
	const tl = useLiteralMessages();
	return (
		<dl
			aria-label={tl("About {title}", { title: info.title })}
			className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"
		>
			<dt className="text-muted-foreground">Title</dt>
			<dd className="min-w-0 truncate">{info.title}</dd>
			<dt className="text-muted-foreground">Duration</dt>
			<dd>{formatProjectDuration(info.duration)}</dd>
			<dt className="text-muted-foreground">Clips</dt>
			<dd>{info.segmentCount}</dd>
			<dt className="text-muted-foreground">Canvas</dt>
			<dd>
				{info.width} × {info.height}
			</dd>
			<dt className="text-muted-foreground">Created</dt>
			<dd>{formatProjectDate(info.createdAt)}</dd>
			<dt className="text-muted-foreground">Modified</dt>
			<dd>{formatProjectDate(info.updatedAt)}</dd>
			<dt className="text-muted-foreground">Revision</dt>
			<dd>{info.revision}</dd>
		</dl>
	);
}
