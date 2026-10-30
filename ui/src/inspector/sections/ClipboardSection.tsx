import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Label } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState, useSyncExternalStore } from "react";
import {
	SETTINGS_GROUPS,
	type SettingsGroup,
} from "../../../../shared/clip-edits.ts";
import {
	copySettingsFrom,
	getSettingsClipboard,
	pasteSettingsToSelection,
	setSettingsGroups,
	subscribeSettingsClipboard,
} from "../../editor/actions/clipboard.ts";
import { useEditorProject } from "../../editor/context.tsx";
import type { ClipSectionProps } from "../section-props.ts";

const GROUP_LABELS: Record<SettingsGroup, string> = {
	animation: "Animation & fades",
	audio: "Audio",
	color: "Color",
	effects: "Effects",
	masks: "Masks & key",
	transform: "Transform",
};

/**
 * Copy this clip's settings, then paste chosen groups onto the selected
 * clips (or onto this clip when it is the only one selected).
 */
export function ClipboardSection({ segment }: ClipSectionProps) {
	const runtime = useEditorProject();
	const tl = useLiteralMessages();
	const copied = useSyncExternalStore(
		subscribeSettingsClipboard,
		getSettingsClipboard,
		getSettingsClipboard
	);
	const [groups, setGroups] = useState<readonly SettingsGroup[]>(
		() => copied?.groups ?? SETTINGS_GROUPS
	);
	const selected = runtime.selectedIds.length
		? runtime.selectedIds
		: [segment.id];
	const targets = selected.filter((id) => id !== copied?.segment.id);
	const toggle = (group: SettingsGroup, checked: boolean) =>
		setGroups((current) =>
			checked
				? SETTINGS_GROUPS.filter(
						(candidate) => candidate === group || current.includes(candidate)
					)
				: current.filter((candidate) => candidate !== group)
		);
	const paste = () => {
		setSettingsGroups(groups);
		pasteSettingsToSelection(runtime, targets);
	};
	const sourceName = copied
		? (runtime.assets.find((asset) => asset.id === copied.segment.assetId)
				?.name ?? "a clip")
		: null;
	return (
		<fieldset className="grid gap-2" disabled={runtime.busy}>
			<legend className="font-medium text-xs">Clip settings</legend>
			<RyuAppActions>
				<Button
					onClick={() => {
						copySettingsFrom(segment, groups);
						runtime.setStatus("Copied this clip's settings.");
					}}
					size="sm"
					variant="outline"
				>
					Copy settings
				</Button>
				<Button
					disabled={!(copied && groups.length && targets.length)}
					onClick={paste}
					size="sm"
					variant="outline"
				>
					{targets.length > 1
						? tl("Paste settings to {count} clips", {
								count: String(targets.length),
							})
						: tl("Paste settings")}
				</Button>
			</RyuAppActions>
			{sourceName && (
				<small className="text-muted-foreground">
					{tl("Copied from {sourceName}", { sourceName })}
				</small>
			)}
			<div className="grid grid-cols-2 gap-1">
				{SETTINGS_GROUPS.map((group) => {
					const id = `clipboard-group-${group}`;
					return (
						<div className="flex items-center gap-1.5" key={group}>
							<Checkbox
								checked={groups.includes(group)}
								id={id}
								onCheckedChange={(checked) => toggle(group, checked === true)}
							/>
							<Label className="text-xs" htmlFor={id}>
								{GROUP_LABELS[group]}
							</Label>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}
