import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useRef,
	useState,
} from "react";
import type { KeyframeCurve } from "../../../shared/animation.ts";
import type { BezierControls } from "../../../shared/keyframe-easing.ts";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import {
	addCustomPreset,
	BUILT_IN_EASING_PRESETS,
	type CustomEasingPreset,
	curveControls,
	curveFromControls,
	customPresetCurve,
	loadCustomPresets,
	matchingPresetId,
	normalizeBezier,
	removeCustomPreset,
	saveCustomPresets,
} from "./easing-presets.ts";

/** Graph box in SVG units; progress 0..1 spans the inner square. */
const GRAPH_WIDTH = 200;
const GRAPH_HEIGHT = 220;
const GRAPH_PAD = 14;
/** Visible eased-progress range; handles outside it draw at the edge. */
const Y_TOP = 1.6;
const Y_BOTTOM = -0.6;

const innerWidth = GRAPH_WIDTH - 2 * GRAPH_PAD;
const innerHeight = GRAPH_HEIGHT - 2 * GRAPH_PAD;

/** Graph coordinates (progress) to SVG units. */
export function graphPoint(u: number, y: number): { x: number; y: number } {
	const clampedY = Math.min(Y_TOP, Math.max(Y_BOTTOM, y));
	return {
		x: GRAPH_PAD + u * innerWidth,
		y: GRAPH_PAD + ((Y_TOP - clampedY) / (Y_TOP - Y_BOTTOM)) * innerHeight,
	};
}

/**
 * The curve handle under a pointer, from the pointer's position in the
 * rendered graph (`bounds` in client pixels). The result is clamped to the
 * keyframe schema (x 0..1, y -1..2) and rounded.
 */
export function handleFromPointer(
	bounds: Pick<DOMRect, "height" | "left" | "top" | "width">,
	clientX: number,
	clientY: number
): { u: number; y: number } {
	const scaleX = bounds.width > 0 ? GRAPH_WIDTH / bounds.width : 1;
	const scaleY = bounds.height > 0 ? GRAPH_HEIGHT / bounds.height : 1;
	const svgX = (clientX - bounds.left) * scaleX;
	const svgY = (clientY - bounds.top) * scaleY;
	const u = (svgX - GRAPH_PAD) / innerWidth;
	const y = Y_TOP - ((svgY - GRAPH_PAD) / innerHeight) * (Y_TOP - Y_BOTTOM);
	const [x1, y1] = normalizeBezier([u, y, 1, 1]);
	return { u: x1, y: y1 };
}

/** The SVG path of a curve in the graph box. */
export function curvePath(controls: BezierControls | null): string {
	const start = graphPoint(0, 0);
	const end = graphPoint(1, 1);
	if (!controls) {
		// Hold: flat until the next keyframe, then a jump.
		return `M ${start.x} ${start.y} H ${end.x} V ${end.y}`;
	}
	const a = graphPoint(controls[0], controls[1]);
	const b = graphPoint(controls[2], controls[3]);
	return `M ${start.x} ${start.y} C ${a.x} ${a.y} ${b.x} ${b.y} ${end.x} ${end.y}`;
}

const formatControls = (controls: BezierControls) =>
	controls.map((value) => value.toFixed(2)).join(", ");

type HandleIndex = 0 | 1;

/**
 * Bezier graph editor for the curve after one keyframe: drag (or use the
 * arrow keys on) the two handles, apply a built-in preset, or save the curve
 * as a custom preset kept for this viewer. `onChange` receives each finished
 * edit; a handle drag reports once, when the pointer is released.
 */
export function GraphEditor({
	curve,
	onChange,
	storage,
}: {
	curve: KeyframeCurve;
	onChange: (curve: KeyframeCurve) => void;
	/** Viewer storage override (tests); defaults to the browser's. */
	storage?: ViewerStorageArea | null;
}) {
	const tl = useLiteralMessages();
	const [custom, setCustom] = useState<CustomEasingPreset[]>(() =>
		loadCustomPresets(storage)
	);
	const [draft, setDraft] = useState<BezierControls | null>(null);
	const [name, setName] = useState("");
	const [notice, setNotice] = useState("");
	const dragging = useRef<{ index: HandleIndex; pointerId: number } | null>(
		null
	);
	const graph = useRef<SVGSVGElement>(null);
	const shown = draft ?? curveControls(curve);
	const shownCurve: KeyframeCurve = draft ? curveFromControls(draft) : curve;
	const activeId = matchingPresetId(shownCurve, custom);
	// Handles start from the curve's exact Bezier form (hold edits from linear).
	const editable: BezierControls = shown ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3];

	const persist = (next: CustomEasingPreset[]) => {
		setCustom(next);
		setNotice(
			saveCustomPresets(next, storage)
				? ""
				: "Custom curves cannot be stored in this browser; they last until the page closes."
		);
	};

	const moved = (index: HandleIndex, u: number, y: number): BezierControls => {
		const next: BezierControls = [...editable];
		next[index * 2] = u;
		next[index * 2 + 1] = y;
		return normalizeBezier(next);
	};

	const onPointerDown =
		(index: HandleIndex) => (event: ReactPointerEvent<SVGCircleElement>) => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			dragging.current = { index, pointerId: event.pointerId };
			setDraft(editable);
		};
	const pointerHandle = (event: ReactPointerEvent<SVGCircleElement>) => {
		const drag = dragging.current;
		const bounds = graph.current?.getBoundingClientRect();
		if (!(drag && bounds) || drag.pointerId !== event.pointerId) {
			return null;
		}
		const point = handleFromPointer(bounds, event.clientX, event.clientY);
		return moved(drag.index, point.u, point.y);
	};
	const onPointerMove = (event: ReactPointerEvent<SVGCircleElement>) => {
		const next = pointerHandle(event);
		if (next) {
			setDraft(next);
		}
	};
	const onPointerUp = (event: ReactPointerEvent<SVGCircleElement>) => {
		const next = pointerHandle(event);
		if (!next) {
			return;
		}
		event.stopPropagation();
		dragging.current = null;
		setDraft(null);
		onChange(curveFromControls(next));
	};
	const onPointerCancel = () => {
		dragging.current = null;
		setDraft(null);
	};

	const onHandleKey = (index: HandleIndex) => (event: KeyboardEvent) => {
		const step = event.shiftKey ? 0.1 : 0.01;
		const u = editable[index * 2] ?? 0;
		const y = editable[index * 2 + 1] ?? 0;
		const targets: Record<string, [number, number]> = {
			ArrowDown: [u, y - step],
			ArrowLeft: [u - step, y],
			ArrowRight: [u + step, y],
			ArrowUp: [u, y + step],
		};
		const target = targets[event.key];
		if (!target) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		onChange(curveFromControls(moved(index, target[0], target[1])));
	};

	const saveCurrent = () => {
		try {
			persist(addCustomPreset(custom, name, editable));
			setName("");
		} catch (error) {
			setNotice(
				error instanceof Error ? error.message : "Could not save the curve."
			);
		}
	};

	const start = graphPoint(0, 0);
	const end = graphPoint(1, 1);
	const handles = shown
		? ([0, 1] as const).map((index) => ({
				anchor: index === 0 ? start : end,
				index,
				point: graphPoint(shown[index * 2] ?? 0, shown[index * 2 + 1] ?? 0),
			}))
		: [];
	return (
		<div className="flex w-56 flex-col gap-2 text-xs" data-graph-editor="">
			<div
				aria-label="Easing presets"
				className="flex flex-wrap gap-1"
				role="group"
			>
				{BUILT_IN_EASING_PRESETS.map((preset) => (
					<Button
						aria-pressed={activeId === preset.id}
						data-easing-preset={preset.id}
						key={preset.id}
						onClick={() => onChange(preset.curve)}
						size="xs"
						type="button"
						variant={activeId === preset.id ? "default" : "secondary"}
					>
						{preset.label}
					</Button>
				))}
			</div>
			<svg
				aria-label={
					shown
						? tl("Curve cubic-bezier({controls})", {
								controls: formatControls(shown),
							})
						: "Hold: the value stays until the next keyframe"
				}
				className="w-full touch-none rounded-md border border-border bg-muted/40"
				ref={graph}
				role="img"
				viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
			>
				<rect
					className="fill-none stroke-border"
					height={start.y - end.y}
					strokeDasharray="3 3"
					width={end.x - start.x}
					x={start.x}
					y={end.y}
				/>
				{handles.map((handle) => (
					<line
						className="stroke-muted-foreground"
						key={`arm-${handle.index}`}
						x1={handle.anchor.x}
						x2={handle.point.x}
						y1={handle.anchor.y}
						y2={handle.point.y}
					/>
				))}
				<path
					className="fill-none stroke-primary"
					d={curvePath(shown)}
					data-graph-curve=""
					strokeWidth={2}
				/>
				{handles.map((handle) => {
					const u = shown?.[handle.index * 2] ?? 0;
					const y = shown?.[handle.index * 2 + 1] ?? 0;
					return (
						// biome-ignore lint/a11y/useSemanticElements: a 2D Bezier handle has no native element; it is a keyboard-operable slider.
						<circle
							aria-label={handle.index === 0 ? "Start handle" : "End handle"}
							aria-valuemax={2}
							aria-valuemin={-1}
							aria-valuenow={y}
							aria-valuetext={tl("time {time}, value {value}", {
								time: u.toFixed(2),
								value: y.toFixed(2),
							})}
							className="cursor-move fill-background stroke-primary outline-none focus-visible:stroke-ring"
							cx={handle.point.x}
							cy={handle.point.y}
							data-graph-handle={handle.index}
							key={`handle-${handle.index}`}
							onKeyDown={onHandleKey(handle.index)}
							onPointerCancel={onPointerCancel}
							onPointerDown={onPointerDown(handle.index)}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							r={6}
							role="slider"
							strokeWidth={2}
							tabIndex={0}
						/>
					);
				})}
			</svg>
			<p className="font-mono text-muted-foreground" data-graph-readout="">
				{shown ? `cubic-bezier(${formatControls(shown)})` : "Hold"}
			</p>
			{shown ? null : (
				<p className="text-muted-foreground">
					Choose a preset to shape the curve; hold has no handles.
				</p>
			)}
			{custom.length > 0 ? (
				<ul aria-label="Saved curves" className="flex flex-col gap-1">
					{custom.map((preset) => (
						<li className="flex items-center gap-1" key={preset.id}>
							<Button
								aria-pressed={activeId === preset.id}
								className="flex-1 justify-start"
								data-easing-preset={preset.id}
								onClick={() => onChange(customPresetCurve(preset))}
								size="xs"
								type="button"
								variant={activeId === preset.id ? "default" : "secondary"}
							>
								{preset.name}
							</Button>
							<Button
								aria-label={tl("Delete saved curve {curveName}", {
									curveName: preset.name,
								})}
								onClick={() => persist(removeCustomPreset(custom, preset.id))}
								size="xs"
								type="button"
								variant="ghost"
							>
								Delete
							</Button>
						</li>
					))}
				</ul>
			) : null}
			{shown ? (
				<form
					className="flex items-center gap-1"
					onSubmit={(event) => {
						event.preventDefault();
						saveCurrent();
					}}
				>
					<Input
						aria-label="Saved curve name"
						className="h-7 flex-1 text-xs"
						maxLength={40}
						onChange={(event) => setName(event.target.value)}
						placeholder="Curve name"
						value={name}
					/>
					<Button
						disabled={!name.trim()}
						size="xs"
						type="submit"
						variant="outline"
					>
						Save curve
					</Button>
				</form>
			) : null}
			{notice ? (
				<p className="text-muted-foreground" role="status">
					{notice}
				</p>
			) : null}
		</div>
	);
}
