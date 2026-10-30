import { Badge, Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import type { KeyCombo, ShortcutBinding } from "./defaults.ts";
import { comboId, comboLabel, type KeyPlatform } from "./keys.ts";
import type { RecordMode } from "./persistence.ts";

export function ShortcutRowItem({
	binding,
	customized,
	label,
	notes,
	onRecordKey,
	onRemove,
	onReset,
	onStartRecording,
	onStopRecording,
	platform,
	recording,
}: {
	binding: ShortcutBinding;
	customized: boolean;
	label: string;
	notes: readonly string[];
	onRecordKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
	onRemove: (combo: KeyCombo) => void;
	onReset: () => void;
	onStartRecording: (mode: RecordMode) => void;
	onStopRecording: () => void;
	platform: KeyPlatform;
	recording: RecordMode | null;
}) {
	const tl = useLiteralMessages();
	const recorder = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (recording) {
			recorder.current?.focus();
		}
	}, [recording]);
	return (
		<li
			className="flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0"
			data-binding-id={binding.id}
		>
			<span className="min-w-0 flex-1 basis-40">
				{label}
				{customized && (
					<Badge className="ms-2" variant="secondary">
						Custom
					</Badge>
				)}
			</span>
			<span className="flex flex-wrap items-center gap-1">
				{binding.keys.length === 0 && (
					<span className="text-muted-foreground">No shortcut</span>
				)}
				{binding.keys.map((combo) => {
					const chord = comboLabel(combo, platform);
					return (
						<span
							className="inline-flex items-center gap-1 rounded border px-1.5 font-mono text-xs"
							key={comboId(combo)}
						>
							<kbd>{chord}</kbd>
							<button
								aria-label={tl("Remove {chord} from {label}", { chord, label })}
								className="text-muted-foreground hover:text-foreground"
								onClick={() => onRemove(combo)}
								type="button"
							>
								×
							</button>
						</span>
					);
				})}
			</span>
			<span className="flex flex-wrap gap-1">
				{recording ? (
					<Button
						aria-label={tl(
							"Press the new shortcut for {label}, or Escape to cancel",
							{ label }
						)}
						onBlur={onStopRecording}
						onKeyDown={onRecordKey}
						ref={recorder}
						variant="outline"
					>
						Press keys…
					</Button>
				) : (
					<>
						<Button
							aria-label={tl("Change shortcut for {label}", { label })}
							onClick={() => onStartRecording("replace")}
							variant="ghost"
						>
							Change
						</Button>
						<Button
							aria-label={tl("Add another shortcut for {label}", { label })}
							onClick={() => onStartRecording("add")}
							variant="ghost"
						>
							Add
						</Button>
					</>
				)}
				{customized && (
					<Button
						aria-label={tl("Reset {label} to its default", { label })}
						onClick={onReset}
						variant="ghost"
					>
						Reset
					</Button>
				)}
			</span>
			{notes.length > 0 && (
				<span className="basis-full text-destructive text-xs">
					{notes.join(" ")}
				</span>
			)}
		</li>
	);
}
