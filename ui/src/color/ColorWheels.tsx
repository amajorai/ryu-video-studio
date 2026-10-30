import { useLiteralMessages } from "@ryu/i18n/react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import type { ColorWheel } from "../../../shared/schema/color.ts";
import { NumberField } from "../NumberField.tsx";
import {
	isNeutralWheel,
	neutralWheel,
	offsetFromWheel,
	wheelFromOffset,
} from "./color-controls.ts";

export type WheelName = "lift" | "gamma" | "gain";

const wheelLabels: Record<WheelName, string> = {
	gain: "Gain (highlights)",
	gamma: "Gamma (midtones)",
	lift: "Lift (shadows)",
};

// Red sits at 3 o'clock, green at 11, blue at 7 (math angles 0°, 120°, 240°).
const hueRing =
	"radial-gradient(circle, rgb(128 128 128) 0%, rgb(128 128 128 / 0) 70%), conic-gradient(hsl(90 70% 55%) 0deg, hsl(60 70% 55%) 30deg, hsl(0 70% 55%) 90deg, hsl(300 70% 55%) 150deg, hsl(240 70% 55%) 210deg, hsl(180 70% 55%) 270deg, hsl(120 70% 55%) 330deg, hsl(90 70% 55%) 360deg)";

const NUDGE = 0.02;

function Wheel({
	name,
	onChange,
	value,
}: {
	name: WheelName;
	onChange: (wheel: ColorWheel | undefined) => void;
	value: ColorWheel | undefined;
}) {
	const disc = useRef<HTMLButtonElement>(null);
	const tl = useLiteralMessages();
	const [dragging, setDragging] = useState(false);
	const offset = offsetFromWheel(value);
	const master = value?.master ?? 0;
	const label = wheelLabels[name];
	const commit = (wheel: ColorWheel) =>
		onChange(isNeutralWheel(wheel) ? undefined : wheel);
	const fromPointer = (event: PointerEvent<HTMLButtonElement>) => {
		const box = disc.current?.getBoundingClientRect();
		if (!(box?.width && box.height)) {
			return;
		}
		const x = ((event.clientX - box.left) / box.width) * 2 - 1;
		const y = 1 - ((event.clientY - box.top) / box.height) * 2;
		commit(wheelFromOffset(x, y, master));
	};
	const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const step = event.shiftKey ? NUDGE * 5 : NUDGE;
		const moves: Record<string, [number, number]> = {
			ArrowDown: [0, -step],
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, step],
		};
		const delta = moves[event.key];
		if (delta) {
			event.preventDefault();
			commit(wheelFromOffset(offset.x + delta[0], offset.y + delta[1], master));
		} else if (event.key === "Escape" || event.key === "Delete") {
			event.preventDefault();
			commit({ ...neutralWheel(), master });
		}
	};
	return (
		<div className="flex min-w-0 flex-col items-center gap-1">
			<button
				aria-label={tl(
					"{label}: red {red}, green {green}, blue {blue}. Drag or use the arrow keys; Delete centers it; double-click resets.",
					{
						blue: String(value?.b ?? 0),
						green: String(value?.g ?? 0),
						label,
						red: String(value?.r ?? 0),
					}
				)}
				className="relative aspect-square w-full max-w-20 cursor-crosshair touch-none rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-ring"
				data-testid={`wheel-${name}`}
				onDoubleClick={() => onChange(undefined)}
				onKeyDown={keyDown}
				onPointerCancel={() => setDragging(false)}
				onPointerDown={(event) => {
					setDragging(true);
					event.currentTarget.setPointerCapture?.(event.pointerId);
					fromPointer(event);
				}}
				onPointerMove={(event) => {
					if (dragging) {
						fromPointer(event);
					}
				}}
				onPointerUp={() => setDragging(false)}
				ref={disc}
				style={{ background: hueRing }}
				type="button"
			>
				<span
					aria-hidden
					className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
					style={{
						left: `${50 + offset.x * 50}%`,
						top: `${50 - offset.y * 50}%`,
					}}
				/>
			</button>
			<NumberField
				label={tl("{wheelName} master", {
					wheelName: `${name[0]?.toUpperCase()}${name.slice(1)}`,
				})}
				max={1}
				min={-1}
				onChange={(next) =>
					commit({ ...(value ?? neutralWheel()), master: next })
				}
				step={0.05}
				value={master}
			/>
		</div>
	);
}

interface ColorWheelsProps {
	gain: ColorWheel | undefined;
	gamma: ColorWheel | undefined;
	lift: ColorWheel | undefined;
	/** `undefined` clears that wheel. */
	onChange: (name: WheelName, wheel: ColorWheel | undefined) => void;
}

/** Lift, gamma and gain color wheels with a master offset each. */
export function ColorWheels({ gain, gamma, lift, onChange }: ColorWheelsProps) {
	const values: Record<WheelName, ColorWheel | undefined> = {
		gain,
		gamma,
		lift,
	};
	return (
		<div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2">
			{(["lift", "gamma", "gain"] as const).map((name) => (
				<Wheel
					key={name}
					name={name}
					onChange={(wheel) => onChange(name, wheel)}
					value={values[name]}
				/>
			))}
		</div>
	);
}
