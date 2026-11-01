import { avatarRigExpression } from "../../shared/avatar.ts";
import { ffmpegFrameRate } from "../../shared/frame-rate.ts";
import type { Avatar, Project } from "../../shared/project.ts";
import type { OverlayChain } from "./render-graphics.ts";

interface AvatarBox {
	color: string;
	/** Height as a fraction of the canvas height. */
	height: number;
	/**
	 * Per-frame alpha mask for `geq` (the mouth), on its pixel grid `X`/`W`
	 * and time `T`; absent for solid parts.
	 */
	mask?: (canvasWidth: number) => string;
	/** Width as a fraction of the canvas width. */
	width: number;
	/** Left edge on the timeline clock `t`, as a fraction of the canvas. */
	x: string;
	/** Top edge on the timeline clock `t`, as a fraction of the canvas. */
	y: string;
}

/** Turn an expression on the timeline clock `t` into geq's time `T`. */
function geqTime(expression: string): string {
	return expression.replace(/(?<![A-Za-z_])t(?![A-Za-z_(])/g, "T");
}

function avatarBoxes(avatar: Avatar): AvatarBox[] {
	const progress = avatar.entryDuration
		? `min(1,max(0,(t-${avatar.start})/${avatar.entryDuration}))`
		: "1";
	const entryOffset = `(1-(${progress}))*0.08`;
	// FFmpeg's expression parser rejects a sign before a parenthesis
	// (`x+-(…)`), so the slide carries its own binary operator.
	const slide =
		avatar.animation === "slide-left"
			? `-(${entryOffset})`
			: avatar.animation === "slide-right"
				? `+(${entryOffset})`
				: "+0";
	const bob =
		avatar.animation === "idle"
			? `sin((t-${avatar.start})*6.283185)*0.01`
			: "0";
	const x = `(${avatar.x}${slide}+${avatar.depth * 0.02})`;
	const y = `(${avatar.y}+${bob})`;
	const width = avatar.width;
	const height = avatar.height;
	const color = (value: string, opacity = 1) =>
		`${value.replace("#", "0x")}@${opacity}`;
	const leftArmAngle = `(${avatarRigExpression(avatar, "leftArm")})*0.0174533`;
	const rightArmAngle = `(${avatarRigExpression(avatar, "rightArm")})*0.0174533`;
	const leftLegAngle = `(${avatarRigExpression(avatar, "leftLeg")})*0.0174533`;
	const rightLegAngle = `(${avatarRigExpression(avatar, "rightLeg")})*0.0174533`;
	const headTurn = `(${avatarRigExpression(avatar, "head")})*0.0015`;
	const mouth = geqTime(avatarRigExpression(avatar, "mouth"));
	return [
		{
			color: color(avatar.accent, 0.35),
			height: height * 0.1,
			width: width * 0.8,
			x: `${x}+${width}*0.1`,
			y: `${y}+${height}*0.87`,
		},
		{
			color: color(avatar.skin),
			height: height * 0.29,
			width: width * 0.12,
			x: `${x}+${width}*0.12+sin(${leftArmAngle})*${width}*0.16`,
			y: `${y}+${height}*0.34+cos(${leftArmAngle})*${height}*0.02`,
		},
		{
			color: color(avatar.skin),
			height: height * 0.29,
			width: width * 0.12,
			x: `${x}+${width}*0.76+sin(${rightArmAngle})*${width}*0.16`,
			y: `${y}+${height}*0.34+cos(${rightArmAngle})*${height}*0.02`,
		},
		{
			color: color(avatar.outfit),
			height: height * 0.24,
			width: width * 0.14,
			x: `${x}+${width}*0.3+sin(${leftLegAngle})*${width}*0.09`,
			y: `${y}+${height}*0.73+cos(${leftLegAngle})*${height}*0.02`,
		},
		{
			color: color(avatar.outfit),
			height: height * 0.24,
			width: width * 0.14,
			x: `${x}+${width}*0.56+sin(${rightLegAngle})*${width}*0.09`,
			y: `${y}+${height}*0.73+cos(${rightLegAngle})*${height}*0.02`,
		},
		{
			color: color(avatar.outfit),
			height: height * 0.48,
			width: width * 0.52,
			x: `${x}+${width}*0.24`,
			y: `${y}+${height}*0.42`,
		},
		{
			color: color(avatar.skin),
			height: height * 0.35,
			width: width * 0.52,
			x: `${x}+${width}*0.24+${headTurn}`,
			y: `${y}+${height}*0.08`,
		},
		{
			color: color(avatar.accent),
			height: height * 0.1,
			width: width * 0.44,
			x: `${x}+${width}*0.28`,
			y: `${y}+${height}*0.05`,
		},
		{
			color: "0x1b1b1b",
			height: height * 0.05,
			width: width * 0.05,
			x: `${x}+${width}*0.39+${headTurn}`,
			y: `${y}+${height}*0.22`,
		},
		{
			color: "0x1b1b1b",
			height: height * 0.05,
			width: width * 0.05,
			x: `${x}+${width}*0.56+${headTurn}`,
			y: `${y}+${height}*0.22`,
		},
		{
			color: color(avatar.accent),
			height: height * 0.06,
			width: width * 0.06,
			x: `${x}+${width}*0.47`,
			y: `${y}+${height}*0.56`,
		},
		{
			// The widest mouth (openness 1), centred where the drawn mouth is;
			// the mask keeps the middle `0.04 + 0.12 × openness` of the avatar
			// width.
			color: "0x1b1b1b",
			height: height * 0.035,
			mask: (canvasWidth) =>
				`255*lte(abs(X+0.5-W/2),${canvasWidth}*${width}*(0.02+0.06*clip(${mouth},0,1)))`,
			width: width * 0.16,
			x: `${x}+${width}*0.42`,
			y: `${y}+${height}*0.33`,
		},
	];
}

/** Canvas size the avatar stage draws on, in pixels. */
export interface AvatarCanvas {
	height: number;
	width: number;
}

/**
 * Vector avatars, in start order. Every part is a fixed-size colour layer
 * placed by `overlay`, whose `x`/`y` are evaluated per frame on the timeline
 * clock, so rig keyframes, lip-sync, the idle bob and the slide entry move
 * in exports. (`drawbox` evaluates its geometry once and reads `t` as the
 * border thickness, which froze the rig.) The mouth is its widest box with a
 * per-frame `geq` alpha mask for the current openness.
 */
export function avatarFilters(
	p: Project,
	input: string,
	canvas: AvatarCanvas = { height: p.height, width: p.width }
): OverlayChain {
	const filters: string[] = [];
	const rate = ffmpegFrameRate(p.fps);
	let last = input;
	for (const [index, avatar] of [...p.avatars]
		.sort((a, b) => a.start - b.start)
		.entries()) {
		const span = Math.max(0, avatar.end - avatar.start);
		const enable = `between(t,${avatar.start},${avatar.end})`;
		for (const [part, box] of avatarBoxes(avatar).entries()) {
			const layer = `avatar${index}layer${part}`;
			const output = `avatar${index}part${part}`;
			const width = Math.max(1, Math.round(box.width * canvas.width));
			const height = Math.max(1, Math.round(box.height * canvas.height));
			const mask = box.mask
				? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${box.mask(canvas.width)}'`
				: "";
			// The layer's clock starts at the avatar's start, so chunked renders
			// (whose clock starts mid-timeline) never generate frames before it
			// and the mask's `T` is on the timeline clock.
			filters.push(
				`color=c=${box.color}:s=${width}x${height}:r=${rate}:d=${span + 1},format=rgba,setpts=PTS+${avatar.start}/TB${mask}[${layer}]`,
				`[${last}][${layer}]overlay=x='W*(${box.x})':y='H*(${box.y})':eof_action=pass:enable='${enable}'[${output}]`
			);
			last = output;
		}
	}
	return { filters, last };
}
