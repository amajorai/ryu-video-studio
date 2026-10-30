import { Button } from "@ryu/blocks/companion/controls";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	OFFLINE_REASON_LABELS,
	type OfflineAssetReport,
	offlineAssetReportSchema,
	RELINK_DURATION_TOLERANCE_SECONDS,
} from "../../../shared/relink.ts";
import { request } from "../bridge.ts";
import { useEditor } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import {
	type BatchRelinkSummary,
	type RelinkTransport,
	refreshOfflineMedia,
	relinkFolder,
	relinkWithFile,
	sidecarRelinkTransport,
	useOfflineMedia,
} from "./offline-media.ts";

const ACCEPT_BY_KIND: Record<OfflineAssetReport["kind"], string> = {
	audio: "audio/*",
	image: "image/*",
	video: "video/*",
};

const probeResponseSchema = z.object({
	offline: z.array(offlineAssetReportSchema),
});

/** Re-scan with FFprobe so files that are present but damaged show too. */
function scanDamagedMedia() {
	return refreshOfflineMedia(() =>
		request(probeResponseSchema, "/offline-assets?probe=1")
	);
}

function usageText(report: OfflineAssetReport, tl: LiteralMessage): string {
	if (!report.projects.length) {
		return "Not used on any timeline.";
	}
	return tl("Used in {projects}.", {
		projects: report.projects
			.map(
				(use) =>
					`${use.title} (${use.clipCount} ${use.clipCount === 1 ? "clip" : "clips"})`
			)
			.join(", "),
	});
}

export function batchSummaryText(summary: BatchRelinkSummary): string {
	if (!summary.uploaded) {
		return "No chosen file is named like the offline media.";
	}
	const total = summary.relinked + summary.unmatched + summary.failed.length;
	const parts = [
		`Relinked ${summary.relinked} of ${total} offline ${total === 1 ? "file" : "files"}.`,
	];
	if (summary.unmatched) {
		parts.push(`${summary.unmatched} still offline.`);
	}
	if (summary.failed.length) {
		parts.push(summary.failed.join(" "));
	}
	return parts.join(" ");
}

function OfflineRow({
	busy,
	onPick,
	report,
}: {
	busy: boolean;
	onPick: (report: OfflineAssetReport, file: File) => void;
	report: OfflineAssetReport;
}) {
	const picker = useRef<HTMLInputElement>(null);
	const tl = useLiteralMessages();
	return (
		<li className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm">{report.name}</p>
				<p className="text-muted-foreground text-xs">
					{report.kind}
					{report.kind === "image" ? "" : ` · ${clock(report.duration)}`} ·{" "}
					{OFFLINE_REASON_LABELS[report.reason]}
				</p>
				<p className="text-muted-foreground text-xs">{usageText(report, tl)}</p>
			</div>
			<input
				accept={ACCEPT_BY_KIND[report.kind]}
				aria-label={tl("Replacement file for {name}", { name: report.name })}
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) {
						onPick(report, file);
					}
				}}
				ref={picker}
				type="file"
			/>
			<Button
				disabled={busy}
				onClick={() => picker.current?.click()}
				size="sm"
				variant="outline"
			>
				Choose replacement
			</Button>
		</li>
	);
}

/**
 * Relink offline media: list library assets whose stored file is missing or
 * damaged, relink one to a chosen file, or relink many from a folder by file
 * name and duration. Replacements are validated by the sidecar (same kind,
 * duration within the tolerance); refused uploads are removed again.
 */
export function RelinkDialog({
	onClose,
	open,
	transport = sidecarRelinkTransport,
}: {
	onClose: () => void;
	open: boolean;
	transport?: RelinkTransport;
}) {
	const runtime = useEditor();
	const tl = useLiteralMessages();
	const reports = useOfflineMedia();
	const folder = useRef<HTMLInputElement | null>(null);
	// `webkitdirectory` is not a typed React prop. The dialog content mounts
	// only while open, so set it whenever the input element appears.
	const folderRef = useCallback((input: HTMLInputElement | null) => {
		folder.current = input;
		input?.setAttribute("webkitdirectory", "");
	}, []);
	const [working, setWorking] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => {
		if (open) {
			setMessage("");
			refreshOfflineMedia().catch(() => undefined);
		}
	}, [open]);
	const busy = working || runtime.busy;
	const run = async (operation: () => Promise<string>) => {
		setWorking(true);
		try {
			setMessage(await operation());
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Relink failed.");
		} finally {
			setWorking(false);
		}
	};
	const relinkOne = (report: OfflineAssetReport, file: File) =>
		run(async () => {
			setMessage(`Uploading ${file.name}…`);
			const warnings = await relinkWithFile(
				runtime,
				report,
				file,
				() => undefined,
				transport
			);
			return [`${report.name} relinked to ${file.name}.`, ...warnings].join(
				" "
			);
		});
	const relinkMany = (files: File[]) =>
		run(async () => {
			const summary = await relinkFolder(
				runtime,
				reports,
				files,
				(done, total) =>
					setMessage(
						tl("Uploading {done} of {total}…", {
							done: String(done),
							total: String(total),
						})
					),
				transport
			);
			return batchSummaryText(summary);
		});
	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Relink offline media</DialogTitle>
					<DialogDescription>
						{tl(
							"Choose the original file again for media whose stored copy is missing or damaged. A replacement must be the same kind of media and, for video and audio, last within {toleranceSeconds} seconds of the original. Clips, captions and analysis stay attached.",
							{ toleranceSeconds: String(RELINK_DURATION_TOLERANCE_SECONDS) }
						)}
					</DialogDescription>
				</DialogHeader>
				{reports.length ? (
					<ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
						{reports.map((report) => (
							<OfflineRow
								busy={busy}
								key={report.assetId}
								onPick={(item, file) => void relinkOne(item, file)}
								report={report}
							/>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">
						All library media is online.
					</p>
				)}
				<p aria-live="polite" className="min-h-5 text-sm" role="status">
					{message}
				</p>
				<input
					aria-label="Folder with replacement files"
					className="hidden"
					multiple
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = "";
						if (files.length) {
							relinkMany(files).catch(() => undefined);
						}
					}}
					ref={folderRef}
					type="file"
				/>
				<DialogFooter className="flex-wrap gap-2">
					<Button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const next = await scanDamagedMedia();
								return `Checked every file: ${next.reports.length} offline.`;
							})
						}
						variant="ghost"
					>
						Check for damaged files
					</Button>
					<Button
						disabled={busy || !reports.length}
						onClick={() => folder.current?.click()}
						variant="outline"
					>
						Relink from folder
					</Button>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
