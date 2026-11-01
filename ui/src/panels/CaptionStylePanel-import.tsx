import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button, Checkbox, Label } from "@ryu/blocks/companion/controls";
import { useId, useRef, useState } from "react";
import { subtitleFormatOfFile } from "../../../shared/caption-edits.ts";
import {
	importSummary,
	MAX_IMPORT_BYTES,
	type Runtime,
	styleTargetTrackId,
} from "./CaptionStylePanel-model.ts";

export function CaptionImport({ runtime }: { runtime: Runtime }) {
	const picker = useRef<HTMLInputElement>(null);
	const [lenient, setLenient] = useState(true);
	const [append, setAppend] = useState(false);
	const lenientId = useId();
	const appendId = useId();
	const importFile = async (file: File | undefined) => {
		if (!file) {
			return;
		}
		const format = subtitleFormatOfFile(file.name);
		if (!format) {
			runtime.setStatus("Choose an .srt, .vtt, .ass, or .ssa subtitle file.");
			return;
		}
		if (file.size > MAX_IMPORT_BYTES) {
			runtime.setStatus("Subtitle file is too large.");
			return;
		}
		await runtime.routeEdit(
			"caption-import",
			{
				format,
				lenient,
				mode: append ? "append" : "replace",
				text: await file.text(),
				trackId: styleTargetTrackId(runtime.project),
			},
			importSummary
		);
	};
	return (
		<>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={lenient}
					id={lenientId}
					onCheckedChange={(checked) => setLenient(checked === true)}
				/>
				<Label htmlFor={lenientId}>Skip malformed cues and report them</Label>
			</div>
			<div className="flex items-center gap-2">
				<Checkbox
					checked={append}
					id={appendId}
					onCheckedChange={(checked) => setAppend(checked === true)}
				/>
				<Label htmlFor={appendId}>Add to the existing captions</Label>
			</div>
			<RyuAppActions>
				<Button
					disabled={runtime.busy}
					onClick={() => picker.current?.click()}
					size="sm"
					variant="outline"
				>
					Import SRT / VTT / ASS
				</Button>
			</RyuAppActions>
			<input
				accept=".srt,.vtt,.ass,.ssa"
				aria-label="Subtitle file"
				hidden
				onChange={(event) => {
					void importFile(event.target.files?.[0]);
					event.target.value = "";
				}}
				ref={picker}
				type="file"
			/>
		</>
	);
}
