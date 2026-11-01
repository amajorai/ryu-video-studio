import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Checkbox, Label } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useId } from "react";
import {
	type AutoEditAspect,
	autoEditAspectSchema,
	MAX_AUTO_EDIT_SOURCES,
} from "../../../shared/auto-edit.ts";
import type { Asset } from "../../../shared/project.ts";

const ASPECT_LABELS: Record<AutoEditAspect, string> = {
	"16:9": "16:9 landscape",
	"1:1": "1:1 square",
	"4:5": "4:5 portrait",
	"9:16": "9:16 vertical",
};

export function SourceList({
	assets,
	disabled,
	onToggle,
	selected,
}: {
	assets: readonly Asset[];
	disabled: boolean;
	onToggle: (id: string, checked: boolean) => void;
	selected: readonly string[];
}) {
	const baseId = useId();
	if (assets.length === 0) {
		return <small>Import video or images to cut from.</small>;
	}
	const full = selected.length >= MAX_AUTO_EDIT_SOURCES;
	return (
		<ul aria-label="AutoCut sources" className="flex flex-col gap-1">
			{assets.map((asset, index) => {
				const id = `${baseId}-${index}`;
				const checked = selected.includes(asset.id);
				return (
					<li className="flex items-center gap-2" key={asset.id}>
						<Checkbox
							checked={checked}
							disabled={disabled || (full && !checked)}
							id={id}
							onCheckedChange={(value) => onToggle(asset.id, value === true)}
						/>
						<Label htmlFor={id}>{asset.name}</Label>
					</li>
				);
			})}
		</ul>
	);
}

export function CheckField({
	checked,
	disabled,
	label,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	label: string;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center gap-2">
			<Checkbox
				checked={checked}
				disabled={disabled}
				id={id}
				onCheckedChange={(value) => onChange(value === true)}
			/>
			<Label htmlFor={id}>{label}</Label>
		</div>
	);
}

export function AspectSelect({
	label,
	onChange,
	value,
}: {
	label: string;
	onChange: (aspect: AutoEditAspect) => void;
	value: AutoEditAspect;
}) {
	return (
		<RyuAppField label={label}>
			<NativeSelect
				aria-label={label}
				onChange={(event) =>
					onChange(autoEditAspectSchema.parse(event.target.value))
				}
				value={value}
			>
				{autoEditAspectSchema.options.map((aspect) => (
					<NativeSelectOption key={aspect} value={aspect}>
						{ASPECT_LABELS[aspect]}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</RyuAppField>
	);
}
