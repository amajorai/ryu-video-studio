import { Input } from "@ryu/blocks/companion/controls";
import { useRef, useState } from "react";
import { formatTimecode, parseTimecode } from "./timecode.ts";

/**
 * Playhead timecode readout that doubles as a go-to field. It accepts
 * `HH:MM:SS:FF`, `MM:SS:FF`, a frame count, seconds (`4.5s`), or a `+`/`-`
 * offset; Enter or leaving the field seeks, Escape restores.
 */
export function TimecodeField({
	className,
	duration,
	fps,
	onFocus,
	onInvalid,
	onSeek,
	time,
}: {
	className?: string;
	duration: number;
	fps: number;
	onFocus?: () => void;
	onInvalid?: (text: string) => void;
	onSeek: (time: number) => void;
	time: number;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	/** Set by Escape so the blur that follows does not seek. */
	const cancelled = useRef(false);
	const display = formatTimecode(time, fps);
	const commit = () => {
		if (cancelled.current || draft === null) {
			cancelled.current = false;
			setDraft(null);
			return;
		}
		setDraft(null);
		if (draft.trim() === display) {
			return;
		}
		const parsed = parseTimecode(draft, fps, time);
		if (parsed === null) {
			onInvalid?.(draft);
			return;
		}
		onSeek(Math.min(Math.max(0, duration), parsed));
	};
	return (
		<Input
			aria-label="Go to timecode"
			autoComplete="off"
			className={className}
			inputMode="text"
			onBlur={commit}
			onChange={(event) => setDraft(event.target.value)}
			onFocus={(event) => {
				onFocus?.();
				event.currentTarget.select();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					commit();
				} else if (event.key === "Escape") {
					event.preventDefault();
					cancelled.current = true;
					setDraft(null);
					event.currentTarget.blur();
				}
			}}
			spellCheck={false}
			title="Timecode (HH:MM:SS:FF), frames (120), seconds (4.5s), or +/- offsets"
			value={draft ?? display}
		/>
	);
}
