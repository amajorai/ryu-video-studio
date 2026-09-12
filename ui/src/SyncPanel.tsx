import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useMemo, useState } from "react";
import type { Asset, Project } from "../../shared/project.ts";

type SyncMode = "auto" | "manual" | "timecode";

export function SyncPanel({
	assets,
	busy,
	onSync,
	project,
}: {
	assets: Asset[];
	busy: boolean;
	onSync: (input: {
		offsetSeconds?: number;
		mode: SyncMode;
		referenceClipId: string;
		targetClipIds: string[];
	}) => void;
	project: Project;
}) {
	const syncClips = useMemo(
		() =>
			project.segments.filter((segment) => {
				const asset = assets.find(
					(candidate) => candidate.id === segment.assetId
				);
				return asset?.kind !== "image" && Boolean(asset?.hasAudio);
			}),
		[assets, project.segments]
	);
	const timecodeClips = useMemo(
		() =>
			syncClips.filter((clip) => {
				const asset = assets.find((candidate) => candidate.id === clip.assetId);
				return Boolean(asset?.timecodeStart);
			}),
		[assets, syncClips]
	);
	const [referenceClipId, setReferenceClipId] = useState(
		syncClips[0]?.id ?? ""
	);
	const [targetClipIds, setTargetClipIds] = useState<string[]>([]);
	const [mode, setMode] = useState<SyncMode>("auto");
	const [offsetSeconds, setOffsetSeconds] = useState(0);
	const selectedTimecodeReady =
		timecodeClips.some((clip) => clip.id === referenceClipId) &&
		targetClipIds.length > 0 &&
		targetClipIds.every((id) => timecodeClips.some((clip) => clip.id === id));
	useEffect(() => {
		setReferenceClipId((current) =>
			syncClips.some((clip) => clip.id === current)
				? current
				: (syncClips[0]?.id ?? "")
		);
		setTargetClipIds((current) => {
			const next = current.filter((id) =>
				syncClips.some((clip) => clip.id === id)
			);
			return next.length === current.length &&
				next.every((id, index) => id === current[index])
				? current
				: next;
		});
	}, [project.id, project.revision, syncClips]);
	useEffect(() => {
		if (mode === "timecode" && !selectedTimecodeReady) {
			setMode("auto");
		}
	}, [mode, selectedTimecodeReady]);
	const clipLabel = (clip: Project["segments"][number]) => {
		const asset = assets.find((candidate) => candidate.id === clip.assetId);
		return `${asset?.name ?? "Media"} · Track ${clip.track + 1} · ${clip.start.toFixed(2)}s`;
	};
	return (
		<RyuAppSection title="Sync clips">
			<p>
				Align camera, recorder, and external microphone clips on the timeline.
				Audio correlation uses completed local source analysis; embedded
				timecode is available when both sources provide it. Use a manual offset
				when the sources do not share enough sound.
			</p>
			{syncClips.length < 2 ? (
				<small>
					Add two audio-bearing video or audio clips to the timeline first.
				</small>
			) : (
				<>
					<RyuAppField label="Reference clip">
						<NativeSelect
							aria-label="Sync reference clip"
							disabled={busy}
							onChange={(event) => {
								const next = event.target.value;
								setReferenceClipId(next);
								setTargetClipIds((current) =>
									current.filter((id) => id !== next)
								);
							}}
							value={referenceClipId}
						>
							{syncClips.map((clip) => (
								<NativeSelectOption key={clip.id} value={clip.id}>
									{clipLabel(clip)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Target clips">
						{syncClips
							.filter((clip) => clip.id !== referenceClipId)
							.map((clip) => {
								const selected = targetClipIds.includes(clip.id);
								return (
									<Button
										aria-pressed={selected}
										disabled={busy}
										key={clip.id}
										onClick={() =>
											setTargetClipIds((current) =>
												selected
													? current.filter((id) => id !== clip.id)
													: [...current, clip.id]
											)
										}
										size="sm"
										variant="outline"
									>
										{clipLabel(clip)}
									</Button>
								);
							})}
					</RyuAppField>
					<RyuAppField label="Alignment method">
						<NativeSelect
							aria-label="Sync alignment method"
							disabled={busy}
							onChange={(event) => setMode(event.target.value as SyncMode)}
							value={mode}
						>
							<NativeSelectOption value="auto">
								Audio correlation
							</NativeSelectOption>
							<NativeSelectOption
								disabled={!selectedTimecodeReady}
								value="timecode"
							>
								Embedded timecode
							</NativeSelectOption>
							<NativeSelectOption value="manual">
								Manual offset
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					{mode === "manual" && (
						<RyuAppField label="Shift target clips by seconds">
							<Input
								aria-label="Sync manual offset"
								disabled={busy}
								max={600}
								min={-600}
								onChange={(event) =>
									setOffsetSeconds(Number(event.target.value))
								}
								step={0.01}
								type="number"
								value={offsetSeconds}
							/>
						</RyuAppField>
					)}
					<small>
						{targetClipIds.length
							? `${targetClipIds.length} target clip${targetClipIds.length === 1 ? "" : "s"} selected.`
							: "Select one or more target clips."}
					</small>
					{mode === "timecode" && (
						<small>
							Uses embedded source timecode and frame rates from the selected
							media.
						</small>
					)}
					<RyuAppActions>
						<Button
							disabled={busy || !referenceClipId || targetClipIds.length === 0}
							onClick={() =>
								onSync({
									...(mode === "manual" ? { offsetSeconds } : {}),
									mode,
									referenceClipId,
									targetClipIds,
								})
							}
						>
							Align selected clips
						</Button>
					</RyuAppActions>
				</>
			)}
		</RyuAppSection>
	);
}
