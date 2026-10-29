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
import { z } from "zod";
import {
	type Layout,
	layoutLabel,
	layoutRange,
	layoutSchema,
	layoutSupported,
} from "../../shared/layouts.ts";
import type {
	MulticamChangeEntry,
	MulticamExpansion,
} from "../../shared/multicam.ts";
import { expandMulticamSwitches } from "../../shared/multicam.ts";
import type { Asset, MulticamGroup, Project } from "../../shared/project.ts";

/** Layouts a multicam switch can show (more than one angle at once). */
export const MULTICAM_LAYOUTS = layoutSchema.options.filter(
	(layout) => layout !== "single" && layoutSupported(layout)
);

const switchKindSchema = z.enum(["angle", "mic", "layout"]);
type SwitchKind = z.infer<typeof switchKindSchema>;
const fitSchema = z.enum(["fit", "fill"]);

/** Human summary of the program ranges, one line per picture range. */
export function programSummary(expansion: MulticamExpansion): string[] {
	return expansion.video.map((range) => {
		const mic = expansion.audio.find(
			(audio) => audio.start <= range.start && range.start < audio.end
		)?.mic;
		const picture = range.layout
			? `${layoutLabel(range.layout.layout)}: ${range.angles.join(", ")}`
			: range.angles[0];
		return `${range.start.toFixed(2)}–${range.end.toFixed(2)}s · ${picture}${mic ? ` · mic ${mic}` : ""}`;
	});
}

/** The switch entry the switcher form describes, or null when incomplete. */
export function switcherEntry(input: {
	angle: string;
	end: number;
	fit: "fit" | "fill";
	kind: SwitchKind;
	layout: Layout;
	layoutAngles: string[];
	mic: string;
	start: number;
}): MulticamChangeEntry | null {
	if (!(input.end > input.start)) {
		return null;
	}
	const range = { end: input.end, start: input.start };
	if (input.kind === "angle") {
		return input.angle ? { ...range, angle: input.angle } : null;
	}
	if (input.kind === "mic") {
		return input.mic ? { ...range, audio: input.mic } : null;
	}
	const { max, min } = layoutRange(input.layout);
	return input.layoutAngles.length >= min && input.layoutAngles.length <= max
		? {
				...range,
				layout: {
					angles: input.layoutAngles,
					fit: input.fit,
					layout: input.layout,
				},
			}
		: null;
}

const angleLabels = (group: MulticamGroup | undefined) =>
	(group?.members ?? [])
		.filter((member) => member.kind !== "mic")
		.map((member) => member.label);
const micLabels = (group: MulticamGroup | undefined) =>
	(group?.members ?? [])
		.filter((member) => member.kind !== "angle")
		.map((member) => member.label);

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
	onChange: (groupId: string, entries: MulticamChangeEntry[]) => void;
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
	const [extraMicIds, setExtraMicIds] = useState<string[]>([]);
	const [name, setName] = useState("");
	const [groupId, setGroupId] = useState("");
	const [switchKind, setSwitchKind] = useState<SwitchKind>("angle");
	const [switchAngle, setSwitchAngle] = useState("");
	const [switchMic, setSwitchMic] = useState("");
	const [layout, setLayout] = useState<Layout>(
		MULTICAM_LAYOUTS[0] ?? "side-by-side"
	);
	const [layoutAngles, setLayoutAngles] = useState<string[]>([]);
	const [fit, setFit] = useState<"fit" | "fill">("fit");
	const [switchStart, setSwitchStart] = useState(0);
	const [switchEnd, setSwitchEnd] = useState(1);
	useEffect(() => {
		if (!project.multicamGroups.some((group) => group.id === groupId)) {
			setGroupId(project.multicamGroups[0]?.id ?? "");
		}
	}, [groupId, project.multicamGroups]);
	useEffect(() => {
		setExtraMicIds((current) =>
			current.filter((id) => id !== micId && !angleIds.includes(id))
		);
	}, [angleIds, micId]);
	const selectedGroup = project.multicamGroups.find(
		(group) => group.id === groupId
	);
	// Reset the switcher only when a different session (or its range) is
	// picked: a server commit hands in a new group object with the same id,
	// and that must keep the user's slot order and range.
	const selectedId = selectedGroup?.id;
	const groupStart = selectedGroup?.start;
	const groupDuration = selectedGroup?.duration;
	const firstAngle = angleLabels(selectedGroup)[0] ?? "";
	const firstMic = micLabels(selectedGroup)[0] ?? "";
	useEffect(() => {
		if (
			selectedId === undefined ||
			groupStart === undefined ||
			groupDuration === undefined
		) {
			return;
		}
		setSwitchAngle(firstAngle);
		setSwitchMic(firstMic);
		setLayoutAngles([]);
		setSwitchStart(groupStart);
		setSwitchEnd(Math.min(groupStart + groupDuration, groupStart + 1));
	}, [firstAngle, firstMic, groupDuration, groupStart, selectedId]);
	const entry = switcherEntry({
		angle: switchAngle,
		end: switchEnd,
		fit,
		kind: switchKind,
		layout,
		layoutAngles,
		mic: switchMic,
		start: switchStart,
	});
	const range = layoutRange(layout);
	const assetName = (id: string, fallback: string) =>
		assets.find((asset) => asset.id === id)?.name ?? fallback;
	return (
		<RyuAppSection title="Multicam sessions">
			<p>
				Build a named camera session with a program-audio track, then switch the
				camera angle, the microphone you hear, or a split-screen layout over
				bounded timeline ranges. Ungrouping leaves its ordinary clips in place
				for further editing.
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
			{micId && programAssets.length > 1 && (
				<RyuAppField label="More microphones">
					{programAssets
						.filter((asset) => asset.id !== micId)
						.map((asset) => {
							const selected = extraMicIds.includes(asset.id);
							return (
								<Button
									aria-pressed={selected}
									disabled={busy}
									key={asset.id}
									onClick={() =>
										setExtraMicIds((current) =>
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
						})}
				</RyuAppField>
			)}
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
						const input: Parameters<typeof onCreate>[0] = {
							masterAssetId: micId,
							members: [
								...angleIds.map((id) => ({
									assetId: id,
									kind: "angle" as const,
									label: assetName(id, "Camera"),
								})),
								...[micId, ...extraMicIds].map((id) => ({
									assetId: id,
									kind: "mic" as const,
									label: assetName(id, "Recorder"),
								})),
							],
						};
						if (name.trim()) {
							input.name = name.trim();
						}
						onCreate(input);
						setAngleIds([]);
						setExtraMicIds([]);
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
							<RyuAppField label="Switch">
								<NativeSelect
									aria-label="Multicam switch type"
									disabled={busy}
									onChange={(event) =>
										setSwitchKind(switchKindSchema.parse(event.target.value))
									}
									value={switchKind}
								>
									<NativeSelectOption value="angle">
										Camera angle
									</NativeSelectOption>
									<NativeSelectOption
										disabled={micLabels(selectedGroup).length < 2}
										value="mic"
									>
										Microphone
									</NativeSelectOption>
									<NativeSelectOption value="layout">
										Split-screen layout
									</NativeSelectOption>
								</NativeSelect>
							</RyuAppField>
							{switchKind === "angle" && (
								<RyuAppField label="Switch angle">
									<NativeSelect
										aria-label="Multicam switch angle"
										disabled={busy}
										onChange={(event) => setSwitchAngle(event.target.value)}
										value={switchAngle}
									>
										{angleLabels(selectedGroup).map((label) => (
											<NativeSelectOption key={label} value={label}>
												{label}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</RyuAppField>
							)}
							{switchKind === "mic" && (
								<RyuAppField label="Program microphone">
									<NativeSelect
										aria-label="Multicam switch microphone"
										disabled={busy}
										onChange={(event) => setSwitchMic(event.target.value)}
										value={switchMic}
									>
										{micLabels(selectedGroup).map((label) => (
											<NativeSelectOption key={label} value={label}>
												{label}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</RyuAppField>
							)}
							{switchKind === "layout" && (
								<>
									<RyuAppField label="Layout">
										<NativeSelect
											aria-label="Multicam switch layout"
											disabled={busy}
											onChange={(event) =>
												setLayout(layoutSchema.parse(event.target.value))
											}
											value={layout}
										>
											{MULTICAM_LAYOUTS.map((option) => (
												<NativeSelectOption key={option} value={option}>
													{layoutLabel(option)}
												</NativeSelectOption>
											))}
										</NativeSelect>
										<NativeSelect
											aria-label="Multicam layout fit"
											disabled={busy}
											onChange={(event) =>
												setFit(fitSchema.parse(event.target.value))
											}
											value={fit}
										>
											<NativeSelectOption value="fit">
												Fit each angle
											</NativeSelectOption>
											<NativeSelectOption value="fill">
												Fill each slot
											</NativeSelectOption>
										</NativeSelect>
									</RyuAppField>
									<RyuAppField
										label={`Angles in slot order (${range.min === range.max ? range.min : `${range.min}-${range.max}`})`}
									>
										{angleLabels(selectedGroup).map((label) => {
											const slot = layoutAngles.indexOf(label);
											return (
												<Button
													aria-pressed={slot >= 0}
													disabled={
														busy ||
														(slot < 0 && layoutAngles.length >= range.max)
													}
													key={label}
													onClick={() =>
														setLayoutAngles((current) =>
															slot >= 0
																? current.filter((angle) => angle !== label)
																: [...current, label]
														)
													}
													size="sm"
													variant="outline"
												>
													{slot >= 0 ? `${slot + 1}. ${label}` : label}
												</Button>
											);
										})}
									</RyuAppField>
								</>
							)}
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
									disabled={busy || !entry}
									onClick={() => {
										if (entry) {
											onChange(selectedGroup.id, [entry]);
										}
									}}
								>
									{switchKind === "angle"
										? "Switch camera over range"
										: switchKind === "mic"
											? "Switch microphone over range"
											: "Show layout over range"}
								</Button>
								<Button
									disabled={busy}
									onClick={() => onUngroup(selectedGroup.id)}
									variant="outline"
								>
									Ungroup session
								</Button>
							</RyuAppActions>
							<ul aria-label="Multicam program ranges">
								{programSummary(expandMulticamSwitches(selectedGroup)).map(
									(line) => (
										<li key={line}>
											<small>{line}</small>
										</li>
									)
								)}
							</ul>
							<small>
								Program audio on track 2. With the playhead inside the session,
								press 1-9 to cut to an angle and Alt+1-9 to switch the
								microphone until the next switch.
							</small>
						</>
					)}
				</>
			)}
		</RyuAppSection>
	);
}
