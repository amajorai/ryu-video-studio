import { animationPoints } from "./animation.ts";
import { fpsRational, rationalFrameTime } from "./frame-rate.ts";
import {
	assetFrames,
	assetSource,
	buttedFrames,
	curveRemapPoints,
	cutTransitions,
	decimal,
	fcpxmlFrameDuration,
	fcpxmlTime,
	frameCount,
	xml,
} from "./interchange-shared.ts";
import { type Asset, type Project, projectDuration } from "./project.ts";

/** Final Cut's built-in Cross Dissolve. */
export const FCP_DISSOLVE_UID = "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265";

/** Linear gain as FCPXML decibels (`-96dB` stands in for silence). */
export const decibels = (gain: number) =>
	gain <= 0 ? "-96dB" : `${decimal(20 * Math.log10(gain))}dB`;

export function fcpxmlText(project: Project, assets: readonly Asset[]): string {
	const fps = project.fps;
	const duration = projectDuration(project);
	const time = (seconds: number) => fcpxmlTime(seconds, fps);
	const { ntsc } = fpsRational(fps);
	const frameTime = (frames: number) => rationalFrameTime(frames, fps);
	/** Frame count as FCPXML time (decimal seconds at integer rates). */
	const at = (frames: number) =>
		ntsc ? frameTime(Math.round(frames)) : `${decimal(frames / fps)}s`;
	/** A fractional source frame: exact decimal seconds, or the nearest NTSC frame. */
	const sourceTime = (frames: number) =>
		ntsc ? frameTime(Math.round(frames)) : `${decimal(frames / fps)}s`;
	// NTSC asset durations round up so a clip ending on the media's partial
	// last frame stays inside the asset's declared range.
	const assetDuration = (asset: Asset) =>
		ntsc ? frameTime(assetFrames(asset, fps)) : time(asset.duration);
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const resources = assets
		.map(
			(asset, index) => `
      <asset id="asset-${index + 1}" name="${xml(asset.name)}" src="${xml(assetSource(asset))}" duration="${assetDuration(asset)}" />`
		)
		.join("");
	const resourceId = new Map(
		assets.map((asset, index) => [asset.id, `asset-${index + 1}`])
	);
	const cuts = cutTransitions(project);
	const placed = [...project.segments]
		.filter(
			(segment) =>
				assetById.has(segment.assetId) && resourceId.has(segment.assetId)
		)
		.map((segment) => {
			const asset = assetById.get(segment.assetId) as Asset;
			return {
				asset,
				frames: buttedFrames(segment, asset, fps, cuts),
				segment,
			};
		});
	type Placed = (typeof placed)[number];
	let dissolves = 0;

	/** Speed, audio level and fades, and connected-clip opacity fades. */
	const clipChildren = (item: Placed, connected: boolean) => {
		const { asset, frames, segment } = item;
		const children: string[] = [];
		const remap = curveRemapPoints(segment, frames, fps);
		if (remap.length > 1) {
			// One timept per curve knot plus samples in between; smooth2
			// splines through them follow the curve's eased speed.
			children.push(`
            <timeMap>${remap
							.map(
								(point, index) => `
              <timept time="${at(point.time)}" value="${sourceTime(point.source)}" interp="${index === remap.length - 1 ? "linear" : "smooth2"}" />`
							)
							.join("")}
            </timeMap>`);
		} else if (Math.abs(segment.speed - 1) > 1e-6) {
			children.push(`
            <timeMap>
              <timept time="0s" value="${at(frames.in)}" interp="linear" />
              <timept time="${at(frames.duration)}" value="${at(frames.out)}" interp="linear" />
            </timeMap>`);
		}
		const hasAudio = asset.kind === "audio" || asset.hasAudio;
		const levels = segment.keyframes.some(
			(frame) => frame.property === "volume"
		)
			? animationPoints(segment, "volume")
			: [];
		const fadeIn = Math.min(frameCount(segment.fadeIn, fps), frames.duration);
		const fadeOut = Math.min(frameCount(segment.fadeOut, fps), frames.duration);
		if (
			hasAudio &&
			(Math.abs(segment.volume - 1) > 1e-6 ||
				levels.length > 0 ||
				fadeIn > 0 ||
				fadeOut > 0)
		) {
			const keyframes = levels.length
				? `
                <keyframeAnimation>${levels
									.map(
										(point) => `
                  <keyframe time="${at(frames.in + frameCount(point.time * segment.speed, fps))}" value="${decibels(point.value)}" />`
									)
									.join("")}
                </keyframeAnimation>`
				: "";
			const fades = [
				fadeIn > 0 ? `<fadeIn type="easeIn" duration="${at(fadeIn)}" />` : "",
				fadeOut > 0
					? `<fadeOut type="easeOut" duration="${at(fadeOut)}" />`
					: "",
			].join("");
			children.push(`
            <adjust-volume amount="${decibels(segment.volume)}">${
							keyframes || fades
								? `
              <param name="amount">${fades}${keyframes}
              </param>`
								: ""
						}
            </adjust-volume>`);
		}
		// Primary-storyline video fades are dissolves in the spine; connected
		// clips fade their opacity instead.
		if (connected && asset.kind !== "audio" && (fadeIn > 0 || fadeOut > 0)) {
			const points = [
				...(fadeIn > 0
					? [
							[frames.in, 0],
							[frames.in + fadeIn, 1],
						]
					: []),
				...(fadeOut > 0
					? [
							[frames.out - fadeOut, 1],
							[frames.out, 0],
						]
					: []),
			];
			children.push(`
            <adjust-blend amount="1">
              <param name="amount">
                <keyframeAnimation>${points
									.map(
										([when, value]) => `
                  <keyframe time="${at(when ?? 0)}" value="${value}" />`
									)
									.join("")}
                </keyframeAnimation>
              </param>
            </adjust-blend>`);
		}
		return children;
	};

	const clipElement = (
		item: Placed,
		parent?: { localStart: number; offset: number }
	): string => {
		const { asset, frames, segment } = item;
		const ref = resourceId.get(segment.assetId) ?? "";
		const connected = parent !== undefined;
		// Connected clips are placed in their parent's local (source) time.
		const offset = parent
			? parent.localStart + (frames.start - parent.offset)
			: frames.start;
		const lane =
			asset.kind === "audio" ? -Math.max(1, segment.track) : segment.track;
		const attributes = [
			`ref="${xml(ref)}"`,
			`name="${xml(asset.name)}"`,
			`offset="${at(offset)}"`,
			`start="${at(frames.in)}"`,
			`duration="${at(frames.duration)}"`,
			...(connected ? [`lane="${lane}"`] : []),
			...(asset.kind === "audio" ? [`audioRole="Dialogue"`] : []),
		];
		const children = clipChildren(item, connected);
		return children.length
			? `
          <asset-clip ${attributes.join(" ")}>${children.join("")}
          </asset-clip>`
			: `
          <asset-clip ${attributes.join(" ")} />`;
	};

	const dissolve = (offset: number, frames: number) => {
		dissolves += 1;
		return `
          <transition name="Cross Dissolve" offset="${at(offset)}" duration="${at(frames)}">
            <filter-video ref="effect-dissolve" name="Cross Dissolve" />
            <filter-audio ref="effect-dissolve" name="Cross Fade" />
          </transition>`;
	};

	// The primary storyline: track 0, butted, with gaps between clips.
	const primary = placed
		.filter((item) => item.segment.track === 0)
		.sort((a, b) => a.frames.start - b.frames.start);
	const others = placed
		.filter((item) => item.segment.track !== 0)
		.sort(
			(a, b) =>
				a.frames.start - b.frames.start || a.segment.track - b.segment.track
		);
	interface SpineItem {
		end: number;
		item?: Placed;
		start: number;
	}
	const spineItems: SpineItem[] = [];
	let cursor = 0;
	for (const item of primary) {
		if (item.frames.start > cursor) {
			spineItems.push({ end: item.frames.start, start: cursor });
		}
		const start = Math.max(cursor, item.frames.start);
		spineItems.push({ end: item.frames.end, item, start });
		cursor = Math.max(cursor, item.frames.end);
	}
	const totalFrames = frameCount(duration, fps);
	const tailStart = cursor;
	const attachedTo = (child: Placed) =>
		spineItems.find(
			(entry) =>
				child.frames.start >= entry.start && child.frames.start < entry.end
		);
	const childrenOf = new Map<SpineItem, Placed[]>();
	const trailing: Placed[] = [];
	for (const child of others) {
		const parent = attachedTo(child);
		if (parent) {
			childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
		} else {
			trailing.push(child);
		}
	}
	if (trailing.length) {
		const end = Math.max(
			totalFrames,
			...trailing.map((child) => child.frames.end)
		);
		const gap: SpineItem = { end, start: tailStart };
		spineItems.push(gap);
		childrenOf.set(gap, trailing);
	}
	const spine = spineItems
		.map((entry) => {
			const children = childrenOf.get(entry) ?? [];
			if (!entry.item) {
				const inner = children
					.map((child) =>
						clipElement(child, { localStart: entry.start, offset: entry.start })
					)
					.join("");
				const attributes = `name="Gap" offset="${at(entry.start)}" start="${at(entry.start)}" duration="${at(entry.end - entry.start)}"`;
				return inner
					? `
          <gap ${attributes}>${inner}
          </gap>`
					: `
          <gap ${attributes} />`;
			}
			const { item } = entry;
			const parts: string[] = [];
			const cut = cuts.get(item.segment.id);
			const fadeIn = frameCount(item.segment.fadeIn, fps);
			if (cut) {
				const half = Math.floor(cut.frames / 2);
				parts.push(dissolve(cut.cut - half, cut.frames));
			} else if (fadeIn > 0 && item.asset.kind !== "audio") {
				parts.push(
					dissolve(item.frames.start, Math.min(fadeIn, item.frames.duration))
				);
			}
			let element = clipElement(item);
			if (children.length) {
				const inner = children
					.map((child) =>
						clipElement(child, {
							localStart: item.frames.in,
							offset: item.frames.start,
						})
					)
					.join("");
				element = element.endsWith(" />")
					? `${element.slice(0, -3)}>${inner}
          </asset-clip>`
					: element.replace(
							/\n {10}<\/asset-clip>$/,
							`${inner}
          </asset-clip>`
						);
			}
			parts.push(element);
			const fadeOut = frameCount(item.segment.fadeOut, fps);
			const continued = [...cuts.values()].some(
				(next) => next.outgoing.id === item.segment.id
			);
			if (fadeOut > 0 && !continued && item.asset.kind !== "audio") {
				const length = Math.min(fadeOut, item.frames.duration);
				parts.push(dissolve(item.frames.end - length, length));
			}
			return parts.join("");
		})
		.join("");
	const effectResource = dissolves
		? `
    <effect id="effect-dissolve" name="Cross Dissolve" uid="${FCP_DISSOLVE_UID}" />`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <format id="format-1" name="Ryu ${project.width}x${project.height}" frameDuration="${fcpxmlFrameDuration(fps)}" width="${project.width}" height="${project.height}" />${resources}${effectResource}
  </resources>
  <library>
    <event name="${xml(project.title)}">
      <project name="${xml(project.title)}">
        <sequence format="format-1" duration="${time(duration)}" tcStart="0s" tcFormat="NDF">
          <spine>${spine}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
