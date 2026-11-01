import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	download,
	mediaBlob,
	request,
	studioResponseSchema,
} from "../bridge.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock, type Job } from "../editor/format.ts";
import { retryExport } from "../editor/project-actions.ts";
import { exportFileName, jobFileFormat } from "./export-form.ts";

const jobStatusLabel = (job: Job) =>
	job.status === "running"
		? job.progress < 0.9
			? "Encoding video…"
			: "Checking output…"
		: job.status;

/** The Exports tab: this project's render queue with review, cancel, retry, and download. */
export function ExportHistoryPanel() {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const { busy, jobs, project } = runtime;
	const projectJobs = jobs.filter((job) => job.projectId === project.id);
	return (
		<RyuAppSection title="Export history">
			{!projectJobs.length && (
				<p className="text-muted-foreground">
					Your finished videos will appear here.
				</p>
			)}
			{projectJobs.map((job) => (
				<div className="studio-scene" key={job.id}>
					<small>
						{tl("Saved version {revision} · {format}{range}", {
							format: jobFileFormat(job).label,
							range: job.export?.range
								? ` · ${clock(job.export.range.start)}–${clock(job.export.range.end)}`
								: "",
							revision: String(job.revision),
						})}
					</small>
					<strong>{jobStatusLabel(job)}</strong>
					{job.error && <p>{job.error}</p>}
					{job.review && (
						<>
							<small>
								{job.review.width} × {job.review.height} ·{" "}
								{job.review.frameRate
									? tl("{frameRate} fps · ", {
											frameRate: String(job.review.frameRate),
										})
									: ""}
								{clock(job.review.duration)} ·{" "}
								{(job.review.bytes / 1e6).toFixed(1)} MB
								{job.review.hasAudio ? " · Audio" : ""}
							</small>
							<details>
								<summary>
									{tl("Delivery review · {result}", {
										result: job.review.checks
											? job.review.passed
												? tl("Passed")
												: tl("Needs review")
											: tl("Legacy metadata"),
									})}
								</summary>
								{job.review.checks ? (
									<ul>
										{job.review.checks.map((check) => (
											<li key={check.id}>
												<strong>{check.label}:</strong> {check.message}
											</li>
										))}
									</ul>
								) : (
									<p>This export predates delivery review checks.</p>
								)}
							</details>
						</>
					)}
					{["pending", "running"].includes(job.status) && (
						<Button
							onClick={() =>
								void runtime.act(async () => {
									await request(
										studioResponseSchema,
										`/renders/${job.id}/cancel`,
										"POST"
									);
								})
							}
							size="sm"
							variant="outline"
						>
							Cancel export
						</Button>
					)}
					{["failed", "canceled"].includes(job.status) &&
						job.revision === project.revision && (
							<Button
								disabled={busy}
								onClick={() => void retryExport(runtime, job)}
								size="sm"
								variant="outline"
							>
								Retry export
							</Button>
						)}
					{job.status === "completed" && (
						<Button
							disabled={busy}
							onClick={() =>
								void runtime.act(async () => {
									const format = jobFileFormat(job);
									download(
										await mediaBlob(`/renders/${job.id}/data`, format.mime),
										exportFileName(project.title, format, job.export?.range)
									);
									runtime.setStatus(
										job.export && job.export.kind !== "video"
											? tl("Downloaded the {format} export.", {
													format: format.label,
												})
											: "Rendered video downloaded."
									);
								})
							}
							size="sm"
						>
							{tl("Download {format}", { format: jobFileFormat(job).label })}
						</Button>
					)}
				</div>
			))}
		</RyuAppSection>
	);
}
