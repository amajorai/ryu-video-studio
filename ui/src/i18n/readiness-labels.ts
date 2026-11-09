/**
 * Status codes in the reader's language. The sidecar reports a readiness
 * check, pipeline stage, activity event or transcript job's status as a code
 * (`blocked`, `canceled`, `interrupted`); a row shows its label ("Blocked")
 * through `tl`, never the bare code, which has no catalog entry of its own and
 * would stay English.
 */
import type { ProductionReadiness } from "../../../shared/production-readiness.ts";

export type ReadinessCheck = ProductionReadiness["checks"][number];
export type ReadinessStatus = ReadinessCheck["status"];

export const READINESS_STATUS_LABEL: Record<ReadinessStatus, string> = {
	blocked: "Blocked",
	optional: "Optional",
	ready: "Ready",
};

/**
 * Every status code the Plan and Transcript panels show: readiness, pipeline
 * stages (`production-stages.ts`), activity events (`production-activity.ts`:
 * gates, stages, generation and render jobs) and transcript jobs.
 */
export const STATUS_WORD_LABEL: Readonly<Record<string, string>> = {
	...READINESS_STATUS_LABEL,
	active: "Active",
	canceled: "Canceled",
	complete: "Complete",
	completed: "Completed",
	failed: "Failed",
	incomplete: "Incomplete",
	interrupted: "Interrupted",
	pending: "Pending",
	queued: "Queued",
	requested: "Requested",
	running: "Running",
	saved: "Saved",
	waiting: "Waiting",
};

type Translate = (text: string) => string;

/**
 * A status code's label in the reader's language. A code without a label (a
 * status a newer sidecar added) shows as reported rather than disappearing.
 */
export function statusWordLabel(tl: Translate, status: string): string {
	const label = Object.hasOwn(STATUS_WORD_LABEL, status)
		? STATUS_WORD_LABEL[status]
		: undefined;
	return label ? tl(label) : status;
}

/** The `{label}`, `{status}` and `{detail}` values of one readiness row. */
export function readinessCheckValues(
	tl: Translate,
	check: ReadinessCheck
): { detail: string; label: string; status: string } {
	return {
		detail: tl(check.detail),
		label: tl(check.label),
		status: tl(READINESS_STATUS_LABEL[check.status]),
	};
}
