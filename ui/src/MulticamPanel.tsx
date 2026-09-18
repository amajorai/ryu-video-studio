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
import { useEffect, useState } from "react";
import type { Asset, Project } from "../../shared/project.ts";

export function MulticamPanel({
	assets,
	busy,
	onChange,
	onCreate,
	onUngroup,
	project,
}: {
	assets: Asset[];
	busy: boolean;
	onChange: (
		groupId: string,
		entries: Array<{ angle: string; end: number; start: number }>
	) => void;
	onCreate: (input: {
		duration?: number;
		masterAssetId?: string;
		members: Array<{
			assetId: string;
			kind: "angle" | "mic";
			label: string;
		}>;
		name?: string;
	}) => void;
	onUngroup: (groupId: string) => void;
	project: Project;
}) {
	const [angleIds, setAngleIds] = useState<string[]>([]);
	const videoAssets = assets.filter((asset) => asset.kind === "video");
	const programAssets = assets.filter(
		(asset) =>
			asset.hasAudio && asset.kind !== "image" && !angleIds.includes(asset.id)
	);
	const [micId, setMicId] = useState("");
	const [name, setName] = useState("");
	const [groupId, setGroupId] = useState("");
	const [switchAngle, setSwitchAngle] = useState("");
	const [switchStart, setSwitchStart] = useState(0);
	const [switchEnd, setSwitchEnd] = useState(1);
	useEffect(() => {
		if (!project.multicamGroups.some((group) => group.id === groupId)) {
			setGroupId(project.multicamGroups[0]?.id ?? "");
		}
	}, [groupId, project.multicamGroups]);
	const selectedGroup = project.multicamGroups.find(
		(group) => group.id === groupId
	);
	useEffect(() => {
		const firstAngle = selectedGroup?.members.find((member) =>
			["angle", "both"].includes(member.kind)
		);
		setSwitchAngle(
			selectedGroup?.switches[0]?.angle ?? firstAngle?.label ?? ""
		);
		if (selectedGroup) {
			setSwitchStart(selectedGroup.start);
			setSwitchEnd(
				Math.min(
					selectedGroup.start + selectedGroup.duration,
					selectedGroup.start + 1
				)
			);
		}
	}, [selectedGroup]);
	return (
		<RyuAppSection title="Multicam sessions">
			<p>
				Build a named camera session with a program-audio track, then switch the
				full-frame angle over bounded timeline ranges. Ungrouping leaves its
				ordinary clips in place for further editing.
			</p>
			<RyuAppField label="Camera angles">
				{videoAssets.length ? (
					videoAssets.map((asset) => {
						const selected = angleIds.includes(asset.id);
						return (
							<Button
								aria-pressed={selected}
								disabled={busy}
								key={asset.id}
								onClick={() =>
									setAngleIds((current) =>
										selected
											? current.filter((id) => id !== asset.id)
											: [...current, asset.id]
									)
								}
								size="sm"
								variant="outline"
							>
								{asset.name}
							</Button>
						);
					})
				) : (
					<small>Import at least two video assets first.</small>
				)}
			</RyuAppField>
			<RyuAppField label="Program audio">
				<NativeSelect
					aria-label="Multicam program audio"
					disabled={busy}
					onChange={(event) => setMicId(event.target.value)}
					value={micId}
				>
					<NativeSelectOption value="">
						Choose mic or camera audio
					</NativeSelectOption>
					{programAssets.map((asset) => (
						<NativeSelectOption key={asset.id} value={asset.id}>
							{asset.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Session name">
				<Input
					aria-label="Multicam session name"
					disabled={busy}
					maxLength={120}
					onChange={(event) => setName(event.target.value)}
					value={name}
				/>
			</RyuAppField>
			<RyuAppActions>
				<Button
					disabled={busy || angleIds.length < 2 || !micId}
					onClick={() => {
						onCreate({
							masterAssetId: micId,
							members: [
								...angleIds.map((id) => ({
									assetId: id,
									kind: "angle" as const,
									label:
										assets.find((asset) => asset.id === id)?.name ?? "Camera",
								})),
								{
									assetId: micId,
									kind: "mic",
									label:
										assets.find((asset) => asset.id === micId)?.name ??
										"Recorder",
								},
							],
							...(name.trim() ? { name: name.trim() } : {}),
						});
						setAngleIds([]);
						setName("");
					}}
				>
					Create multicam session
				</Button>
			</RyuAppActions>
			{project.multicamGroups.length > 0 && (
				<>
					<RyuAppField label="Session">
						<NativeSelect
							aria-label="Multicam session"
							disabled={busy}
							onChange={(event) => setGroupId(event.target.value)}
							value={groupId}
						>
							{project.multicamGroups.map((group) => (
								<NativeSelectOption key={group.id} value={group.id}>
									{group.name} · {group.start.toFixed(2)}–
									{(group.start + group.duration).toFixed(2)}s
								</NativeSelectOption>
							))}
						</NativeSelect>
					</RyuAppField>
					{selectedGroup && (
						<>
							<RyuAppField label="Switch angle">
								<NativeSelect
									aria-label="Multicam switch angle"
									disabled={busy}
									onChange={(event) => setSwitchAngle(event.target.value)}
									value={switchAngle}
								>
									{selectedGroup.members
										.filter((member) => ["angle", "both"].includes(member.kind))
										.map((member) => (
											<NativeSelectOption
												key={member.label}
												value={member.label}
											>
												{member.label}
											</NativeSelectOption>
										))}
								</NativeSelect>
							</RyuAppField>
							<div className="studio-inline-fields">
								<Input
									aria-label="Multicam switch start"
									disabled={busy}
									max={selectedGroup.start + selectedGroup.duration}
									min={selectedGroup.start}
									onChange={(event) =>
										setSwitchStart(Number(event.target.value))
									}
									step={0.01}
									type="number"
									value={switchStart}
								/>
								<Input
									aria-label="Multicam switch end"
									disabled={busy}
									max={selectedGroup.start + selectedGroup.duration}
									min={selectedGroup.start}
									onChange={(event) => setSwitchEnd(Number(event.target.value))}
									step={0.01}
									type="number"
									value={switchEnd}
								/>
							</div>
							<RyuAppActions>
								<Button
									disabled={busy || !switchAngle || switchEnd <= switchStart}
									onClick={() =>
										onChange(selectedGroup.id, [
											{
												angle: switchAngle,
												end: switchEnd,
												start: switchStart,
											},
										])
									}
								>
									Switch camera over range
								</Button>
								<Button
									disabled={busy}
									onClick={() => onUngroup(selectedGroup.id)}
									variant="outline"
								>
									Ungroup session
								</Button>
							</RyuAppActions>
							<small>
								{selectedGroup.switches.length} full-frame angle range
								{selectedGroup.switches.length === 1 ? "" : "s"} · program audio
								on track 2
							</small>
						</>
					)}
				</>
			)}
		</RyuAppSection>
	);
}
