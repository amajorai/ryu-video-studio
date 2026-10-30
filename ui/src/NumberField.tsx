import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Input } from "@ryu/blocks/companion/controls";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	clampNumber,
	evaluateMathExpression,
	formatFieldNumber,
	quantizeToStep,
	scrubAccumulate,
	scrubGrid,
} from "./math-expression.ts";

/** Pixels of travel before a label press counts as a scrub instead of a click. */
export const SCRUB_THRESHOLD_PX = 3;

const LABEL_SELECTOR = ".ryu-app-field__label";
const SCRUB_LABEL_CLASS =
	"[&>.ryu-app-field__label]:cursor-ew-resize [&>.ryu-app-field__label]:touch-none [&>.ryu-app-field__label]:select-none";

interface ScrubSession {
	element: HTMLElement;
	lastX: number | null;
	/** Signed pixels moved before the click-vs-drag threshold was crossed. */
	pendingPx: number;
	pointerId: number;
	raw: number;
	travel: number;
	value: number;
}

function isScrubLabel(
	target: EventTarget | null,
	field: Element
): target is HTMLElement {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	const label = target.closest(LABEL_SELECTOR);
	return label !== null && label.parentElement === field;
}

function releasePointer(session: ScrubSession) {
	if (document.pointerLockElement === session.element) {
		document.exitPointerLock?.();
	}
	try {
		if (session.element.hasPointerCapture?.(session.pointerId)) {
			session.element.releasePointerCapture(session.pointerId);
		}
	} catch {
		// The pointer may already be gone; nothing to release.
	}
}

function lockPointer(element: HTMLElement, pointerId: number) {
	try {
		element.setPointerCapture?.(pointerId);
	} catch {
		// Capture is a nicety; scrubbing still works from bubbling moves.
	}
	try {
		const request = element.requestPointerLock?.() as unknown;
		if (request instanceof Promise) {
			request.catch(() => undefined);
		}
	} catch {
		// Pointer lock is unavailable (embedded frame, test DOM); fall back to clientX.
	}
}

/**
 * A numeric inspector field. Type a value or an arithmetic expression
 * (`1920/2`, `(4+2)*1.5`); Enter commits, Escape reverts, and blur commits a
 * valid value or reverts an invalid one. Drag the label horizontally to scrub
 * one `step` per pixel (Shift = 0.1x, Alt = 10x); ArrowUp/ArrowDown nudge by a
 * step with the same modifiers. Values are clamped to `[min, max]`.
 */
export function NumberField({
	label,
	ariaLabel,
	blank = false,
	className,
	disabled = false,
	value,
	onChange,
	onClear,
	min,
	max,
	placeholder,
	step = 0.1,
	onFocus,
}: {
	label: string;
	/** Accessible name for the input when it differs from the visible label. */
	ariaLabel?: string;
	/**
	 * The property is unset: show an empty box (with `placeholder`) while
	 * `value` stays the base that scrubbing and arrow keys start from.
	 */
	blank?: boolean;
	className?: string;
	disabled?: boolean;
	value: number;
	onChange: (value: number) => void;
	/** Called when the box is committed empty; without it, empty reverts. */
	onClear?: () => void;
	min: number;
	max: number;
	placeholder?: string;
	step?: number;
	onFocus?: () => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [scrubValue, setScrubValue] = useState<number | null>(null);
	const scrubRef = useRef<ScrubSession | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const errorId = useId();
	const shown = scrubValue ?? value;
	const text =
		draft ??
		(blank && scrubValue === null ? "" : formatFieldNumber(shown, step));

	const commitNumber = useCallback(
		(next: number) => {
			const clamped = clampNumber(next, min, max);
			// An unset property commits even its resolved default, so typing the
			// placeholder's value pins it.
			if (blank || clamped !== value) {
				onChange(clamped);
			}
		},
		[blank, max, min, onChange, value]
	);

	const revert = useCallback(() => {
		setDraft(null);
		setError(null);
	}, []);

	const commitDraft = (
		source: string,
		{ keepInvalid }: { keepInvalid: boolean }
	) => {
		if (onClear && source.trim() === "") {
			revert();
			if (!blank) {
				onClear();
			}
			return;
		}
		const result = evaluateMathExpression(source);
		if (!result.ok) {
			if (keepInvalid) {
				setError(result.error);
			} else {
				revert();
			}
			return;
		}
		revert();
		commitNumber(result.value);
	};

	const finishScrub = useCallback(
		(commit: boolean) => {
			const session = scrubRef.current;
			if (!session) {
				return;
			}
			scrubRef.current = null;
			releasePointer(session);
			setScrubValue(null);
			if (session.travel < SCRUB_THRESHOLD_PX) {
				if (commit) {
					inputRef.current?.focus();
					inputRef.current?.select();
				}
				return;
			}
			if (commit) {
				commitNumber(session.value);
			}
		},
		[commitNumber]
	);

	useEffect(() => {
		if (scrubValue === null) {
			return;
		}
		const cancelOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				// Capture phase on window: stop the key here so app-level shortcuts
				// (e.g. Escape clearing the selection) never see the cancel.
				event.preventDefault();
				event.stopPropagation();
				finishScrub(false);
			}
		};
		const resetOrigin = () => {
			if (scrubRef.current) {
				scrubRef.current.lastX = null;
			}
		};
		window.addEventListener("keydown", cancelOnEscape, true);
		document.addEventListener("pointerlockchange", resetOrigin);
		return () => {
			window.removeEventListener("keydown", cancelOnEscape, true);
			document.removeEventListener("pointerlockchange", resetOrigin);
		};
	}, [finishScrub, scrubValue]);

	useEffect(
		() => () => {
			const session = scrubRef.current;
			if (session) {
				scrubRef.current = null;
				releasePointer(session);
			}
		},
		[]
	);

	const startScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (
			disabled ||
			event.button !== 0 ||
			scrubRef.current ||
			!isScrubLabel(event.target, event.currentTarget)
		) {
			return;
		}
		const element = event.target.closest<HTMLElement>(LABEL_SELECTOR);
		if (!element) {
			return;
		}
		event.preventDefault();
		revert();
		onFocus?.();
		scrubRef.current = {
			element,
			lastX: event.clientX,
			pendingPx: 0,
			pointerId: event.pointerId,
			raw: value,
			travel: 0,
			value,
		};
		setScrubValue(value);
		lockPointer(element, event.pointerId);
	};

	const moveScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
		const session = scrubRef.current;
		if (!session || session.pointerId !== event.pointerId) {
			return;
		}
		const locked = document.pointerLockElement === session.element;
		let deltaPx = 0;
		if (locked) {
			deltaPx = event.movementX;
		} else if (session.lastX !== null) {
			deltaPx = event.clientX - session.lastX;
		}
		session.lastX = event.clientX;
		session.travel += Math.abs(deltaPx);
		session.pendingPx += deltaPx;
		if (session.travel < SCRUB_THRESHOLD_PX) {
			return;
		}
		const appliedPx = session.pendingPx;
		session.pendingPx = 0;
		const modifiers = { alt: event.altKey, shift: event.shiftKey };
		// Clamp the accumulator too, so overshooting a limit builds no hidden slack.
		session.raw = clampNumber(
			scrubAccumulate(session.raw, appliedPx, step, modifiers),
			min,
			max
		);
		session.value = quantizeToStep(session.raw, {
			max,
			min,
			step: scrubGrid(step, modifiers),
		});
		setScrubValue(session.value);
	};

	const endScrub = (
		event: ReactPointerEvent<HTMLDivElement>,
		commit: boolean
	) => {
		if (scrubRef.current?.pointerId === event.pointerId) {
			finishScrub(commit);
		}
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			if (draft === null && event.currentTarget.value === text) {
				return;
			}
			commitDraft(event.currentTarget.value, { keepInvalid: true });
			return;
		}
		if (event.key === "Escape") {
			if (draft !== null || error !== null) {
				event.preventDefault();
				event.stopPropagation();
			}
			revert();
			return;
		}
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
			return;
		}
		event.preventDefault();
		const parsed = evaluateMathExpression(event.currentTarget.value);
		const base = parsed.ok ? parsed.value : value;
		const direction = event.key === "ArrowUp" ? 1 : -1;
		const modifiers = { alt: event.altKey, shift: event.shiftKey };
		const next = scrubAccumulate(base, direction, step, modifiers);
		revert();
		commitNumber(
			quantizeToStep(next, {
				max,
				min,
				step: scrubGrid(step, modifiers),
			})
		);
	};

	return (
		<RyuAppField
			className={
				className ? `${SCRUB_LABEL_CLASS} ${className}` : SCRUB_LABEL_CLASS
			}
			data-scrubbing={scrubValue === null ? undefined : "true"}
			label={label}
			onPointerCancel={(event) => endScrub(event, false)}
			onPointerDown={startScrub}
			onPointerMove={moveScrub}
			onPointerUp={(event) => endScrub(event, true)}
			title={error ?? undefined}
		>
			<Input
				aria-describedby={error === null ? undefined : errorId}
				aria-errormessage={error === null ? undefined : errorId}
				aria-invalid={error === null ? undefined : true}
				aria-label={ariaLabel ?? label}
				aria-valuemax={max}
				aria-valuemin={min}
				aria-valuenow={shown}
				autoComplete="off"
				disabled={disabled}
				inputMode="decimal"
				onBlur={(event) => {
					// A value written without an input event (autofill, scripted
					// fills) still commits when it differs from the shown number.
					const typed = event.currentTarget.value;
					if (draft === null && typed === text) {
						setError(null);
						return;
					}
					commitDraft(typed, { keepInvalid: false });
				}}
				onChange={(event) => {
					setDraft(event.currentTarget.value);
					setError(null);
				}}
				onFocus={onFocus}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				ref={inputRef}
				// A text box that also nudges with the arrow keys: the ARIA
				// spinbutton pattern, which keeps the field's role from before
				// it accepted typed expressions.
				role="spinbutton"
				spellCheck={false}
				type="text"
				value={text}
			/>
			{error === null ? null : (
				<span className="sr-only" id={errorId} role="alert">
					{error}
				</span>
			)}
		</RyuAppField>
	);
}
