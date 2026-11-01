import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import { z } from "zod";
import { PUBLISH_PRESETS } from "../../../shared/publish-presets.ts";
import { request } from "../bridge.ts";
import { useEditorProject } from "../editor/context.tsx";
import { message } from "../editor/format.ts";
import { exportFileName, jobFileFormat, jobMetadata } from "./export-form.ts";
import {
	hostSocialBridge,
	OUTPOST_PLATFORM_LABELS,
	OUTPOST_PLATFORMS,
	outpostAvailability,
	sendToOutpost,
} from "./outpost-handoff.ts";

const PLATFORMS = Object.keys(OUTPOST_PLATFORM_LABELS);

/** The Outpost platform a preset export was made for, from its metadata. */
export function platformFromMetadata(
	metadata: string | undefined
): string | undefined {
	const label = metadata
		?.split("\n")
		.find((line) => line.startsWith("Platform: "))
		?.slice(10)
		.trim();
	const preset = PUBLISH_PRESETS.find((item) => item.label === label);
	return preset ? OUTPOST_PLATFORMS[preset.id] : undefined;
}

/**
 * Send to Outpost (G86): after an export, hand the file and its metadata to
 * the Outpost app as one draft per platform, then open Outpost. Shown only
 * as a reason when the host has no Outpost access.
 */
export function OutpostHandoff() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { busy, jobs, project } = runtime;
	const finished = jobs.filter(
		(job) => job.projectId === project.id && job.status === "completed"
	);
	const [availability, setAvailability] = useState<{
		available: boolean;
		reason?: string;
	}>();
	const [jobId, setJobId] = useState("");
	const [platforms, setPlatforms] = useState<string[]>([]);
	const [working, setWorking] = useState(false);
	useEffect(() => {
		let active = true;
		outpostAvailability().then((value) => {
			if (active) {
				setAvailability(value);
			}
		});
		return () => {
			active = false;
		};
	}, []);
	if (!finished.length) {
		return null;
	}
	const selected = jobId || finished.at(-1)?.id || "";
	const send = async () => {
		const social = hostSocialBridge();
		if (!(social && selected) || working) {
			return;
		}
		setWorking(true);
		runtime.setStatus("Sending the export to Outpost…");
		try {
			const details = await request(z.json(), `/renders/${selected}`);
			const format = jobFileFormat(details);
			const metadata =
				jobMetadata(details) ??
				`Title: ${project.title}\n\nDescription:\n${project.brief.trim() || "(no description)"}\n`;
			const targets = platforms.length
				? platforms
				: [platformFromMetadata(metadata) ?? "youtube"];
			const result = await sendToOutpost({
				fileName: exportFileName(project.title, format),
				jobId: selected,
				metadata,
				mimeType: format.mime,
				onProgress: (fraction) =>
					runtime.setStatus(
						tl("Sending the export to Outpost · {percent}%", {
							percent: String(Math.round(fraction * 100)),
						})
					),
				platforms: targets,
				social,
			});
			await social.open({ title: project.title }).catch(() => undefined);
			const missing = result.withoutAccounts.map(
				(platform) => OUTPOST_PLATFORM_LABELS[platform] ?? platform
			);
			const draftCount = Object.keys(result.draftIds).length;
			const created = tl(
				"Created {draftCount, plural, one {{draftLabel} Outpost draft} other {{draftLabel} Outpost drafts}} with the export attached. Schedule them in Outpost: it uploads the file when it publishes to YouTube or TikTok; for Instagram, LinkedIn and X, upload the export on the platform.",
				{ draftCount, draftLabel: String(draftCount) }
			);
			const connect = missing.length
				? ` ${tl("Connect a {platforms} account in Outpost before publishing.", { platforms: missing.join(" and ") })}`
				: "";
			runtime.setStatus(`${created}${connect}`);
		} catch (error) {
			runtime.setStatus(
				tl("Send to Outpost failed: {error}", { error: message(error) })
			);
		} finally {
			setWorking(false);
		}
	};
	return (
		<RyuAppField
			description="Creates a draft per platform in Outpost with the file, title, description and chapters. Outpost owns your accounts and publishing; nothing is posted until you schedule it there."
			label="Send to Outpost"
		>
			{availability?.available === false ? (
				<p className="text-xs">{availability.reason}</p>
			) : (
				<div className="flex flex-col gap-2">
					<NativeSelect
						aria-label="Export to send to Outpost"
						disabled={busy || working}
						onChange={(event) => setJobId(event.target.value)}
						value={selected}
					>
						{finished.map((job) => (
							<NativeSelectOption key={job.id} value={job.id}>
								{tl("Version {revision} · {codec}", {
									codec: job.codec ?? "file",
									revision: String(job.revision),
								})}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<div className="flex flex-wrap gap-3">
						{PLATFORMS.map((platform) => (
							<label
								className="flex items-center gap-1.5 text-sm"
								key={platform}
							>
								<Checkbox
									aria-label={tl("Draft for {platform}", {
										platform: OUTPOST_PLATFORM_LABELS[platform] ?? platform,
									})}
									checked={platforms.includes(platform)}
									disabled={busy || working}
									onCheckedChange={(checked) =>
										setPlatforms((current) =>
											checked === true
												? [...current, platform]
												: current.filter((item) => item !== platform)
										)
									}
								/>
								{OUTPOST_PLATFORM_LABELS[platform]}
							</label>
						))}
					</div>
					<p className="text-xs">
						Outpost publishes YouTube and TikTok drafts by uploading the file
						through its Composio connection when the post goes out. Instagram,
						LinkedIn and X drafts still need a public media URL, so upload the
						export on those platforms yourself.
					</p>
					<p className="text-xs">
						Large exports can take several minutes to upload. If Outpost reports
						that an upload's outcome is unknown, check the platform before
						publishing again.
					</p>
					<p className="text-muted-foreground text-xs">
						No platform checked drafts for the export's publish preset (YouTube
						when it has none).
					</p>
					<RyuAppActions>
						<Button
							disabled={busy || working || !availability?.available}
							onClick={() => void send()}
							size="sm"
							variant="outline"
						>
							{working ? "Sending…" : "Send to Outpost"}
						</Button>
					</RyuAppActions>
				</div>
			)}
		</RyuAppField>
	);
}
