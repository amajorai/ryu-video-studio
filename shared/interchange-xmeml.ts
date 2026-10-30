import { animationPoints } from "./animation.ts";
import {
	assetSource,
	buttedFrames,
	type ClipFrames,
	curveRemapPoints,
	cutTransitions,
	decimal,
	frameCount,
	xmemlRate,
	xml,
} from "./interchange-shared.ts";
import {
	type Asset,
	type Project,
	projectDuration,
	type Segment,
} from "./project.ts";

export const XMEML_DISSOLVE = `<effect>
                  <name>Cross Dissolve</name>
                  <effectid>Cross Dissolve</effectid>
                  <effectcategory>Dissolve</effectcategory>
                  <effecttype>transition</effecttype>
                  <mediatype>video</mediatype>
                </effect>`;
export const XMEML_CROSS_FADE = `<effect>
                  <name>Cross Fade (+3dB)</name>
                  <effectid>KGAudioTransCrossFade3dB</effectid>
                  <effecttype>transition</effecttype>
                  <mediatype>audio</mediatype>
                </effect>`;

/**
 * A transition item: a dissolve (video) or cross fade (audio). Alignment
 * `start-black` fades in from black or silence, `end-black` fades out to it,
 * and `center` dissolves between two clips at a cut.
 */
export function xmemlTransition(
	kind: "audio" | "video",
	start: number,
	end: number,
	alignment: "center" | "end-black" | "start-black",
	fps: number
): string {
	return `
              <transitionitem>
                ${xmemlRate(fps)}
                <start>${start}</start>
                <end>${end}</end>
                <alignment>${alignment}</alignment>
                ${kind === "video" ? XMEML_DISSOLVE : XMEML_CROSS_FADE}
              </transitionitem>`;
}

/**
 * Speed as a Premiere time-remap filter: constant speed in percent, or for a
 * speed-curved clip `variablespeed` 1 with a keyframed `graphdict` (clip
 * frame to source frame on the media's clock) at every curve knot and
 * in-between sample, and `speed` holding the average.
 */
export function xmemlSpeedFilter(
	segment: Segment,
	mediaType: "audio" | "video",
	frames: ClipFrames,
	fps: number
): string {
	const remap = curveRemapPoints(segment, frames, fps);
	if (remap.length < 2 && Math.abs(segment.speed - 1) < 1e-6) {
		return "";
	}
	const graph =
		remap.length > 1
			? `
                    <parameter authoringApp="PremierePro">
                      <parameterid>graphdict</parameterid>
                      <name>graphdict</name>
                      <valuemin>0</valuemin>
                      <valuemax>${Math.ceil(Math.max(...remap.map((point) => point.source)))}</valuemax>
                      <value>${decimal(remap[0]?.source ?? frames.in)}</value>${remap
												.map(
													(point) => `
                      <keyframe>
                        <when>${point.time}</when>
                        <value>${decimal(point.source)}</value>
                      </keyframe>`
												)
												.join("")}
                      <interpolation>
                        <name>FCPCurve</name>
                      </interpolation>
                    </parameter>`
			: "";
	return `
                <filter>
                  <effect>
                    <name>Time Remap</name>
                    <effectid>timeremap</effectid>
                    <effectcategory>motion</effectcategory>
                    <effecttype>motion</effecttype>
                    <mediatype>${mediaType}</mediatype>
                    <parameter authoringApp="PremierePro">
                      <parameterid>variablespeed</parameterid>
                      <name>variablespeed</name>
                      <value>${remap.length > 1 ? 1 : 0}</value>
                    </parameter>
                    <parameter authoringApp="PremierePro">
                      <parameterid>speed</parameterid>
                      <name>speed</name>
                      <value>${decimal(segment.speed * 100)}</value>
                    </parameter>
                    <parameter authoringApp="PremierePro">
                      <parameterid>reverse</parameterid>
                      <name>reverse</name>
                      <value>FALSE</value>
                    </parameter>${graph}
                  </effect>
                </filter>`;
}

/**
 * Clip volume as an Audio Levels filter (linear gain, 1 = 0 dB), with the
 * clip's volume keyframes as level keyframes in clip-relative frames.
 */
export function xmemlLevelFilter(segment: Segment, fps: number): string {
	const points = segment.keyframes.some((frame) => frame.property === "volume")
		? animationPoints(segment, "volume")
		: [];
	if (Math.abs(segment.volume - 1) < 1e-6 && points.length === 0) {
		return "";
	}
	const keyframes = points
		.map(
			(point) => `
                      <keyframe>
                        <when>${frameCount(point.time, fps)}</when>
                        <value>${decimal(point.value)}</value>
                      </keyframe>`
		)
		.join("");
	return `
                <filter>
                  <effect>
                    <name>Audio Levels</name>
                    <effectid>audiolevels</effectid>
                    <effectcategory>audiolevels</effectcategory>
                    <effecttype>audiolevels</effecttype>
                    <mediatype>audio</mediatype>
                    <parameter>
                      <parameterid>level</parameterid>
                      <name>Level</name>
                      <valuemin>0</valuemin>
                      <valuemax>3.98109</valuemax>
                      <value>${decimal(segment.volume)}</value>${keyframes}
                    </parameter>
                  </effect>
                </filter>`;
}

export function xmemlText(project: Project, assets: readonly Asset[]): string {
	const duration = projectDuration(project);
	const fps = project.fps;
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const cuts = cutTransitions(project);
	const tracks = [
		...new Set(project.segments.map((segment) => segment.track)),
	].sort((a, b) => a - b);
	const trackText = (kind: "audio" | "video") =>
		tracks
			.map((track) => {
				const segments = project.segments
					.filter((segment) => segment.track === track)
					.sort((a, b) => a.start - b.start)
					.filter((segment) => {
						const asset = assetById.get(segment.assetId);
						return kind === "audio"
							? asset?.kind === "audio"
							: asset?.kind !== "audio";
					});
				const items = segments
					.map((segment) => {
						const asset = assetById.get(segment.assetId);
						if (!asset) {
							return "";
						}
						const frames = buttedFrames(segment, asset, fps, cuts);
						const parts: string[] = [];
						const cut = cuts.get(segment.id);
						if (cut && segments.includes(cut.outgoing)) {
							const half = Math.floor(cut.frames / 2);
							parts.push(
								xmemlTransition(
									kind,
									cut.cut - half,
									cut.cut - half + cut.frames,
									"center",
									fps
								)
							);
						}
						const fadeIn = frameCount(segment.fadeIn, fps);
						if (fadeIn > 0 && !cut) {
							parts.push(
								xmemlTransition(
									kind,
									frames.start,
									Math.min(frames.end, frames.start + fadeIn),
									"start-black",
									fps
								)
							);
						}
						parts.push(`
              <clipitem id="${xml(segment.id)}">
                <name>${xml(asset.name)}</name>
                <duration>${frames.duration}</duration>
                <start>${frames.start}</start>
                <end>${frames.end}</end>
                <in>${frames.in}</in>
                <out>${frames.out}</out>
                ${xmemlRate(fps)}
                <file id="file-${xml(asset.id)}">
                  <name>${xml(asset.name)}</name>
                  <pathurl>${xml(assetSource(asset))}</pathurl>
                </file>${xmemlSpeedFilter(segment, kind, frames, fps)}${kind === "audio" ? xmemlLevelFilter(segment, fps) : ""}
              </clipitem>`);
						const fadeOut = frameCount(segment.fadeOut, fps);
						const continued = [...cuts.values()].some(
							(next) => next.outgoing.id === segment.id
						);
						if (fadeOut > 0 && !continued) {
							parts.push(
								xmemlTransition(
									kind,
									Math.max(frames.start, frames.end - fadeOut),
									frames.end,
									"end-black",
									fps
								)
							);
						}
						return parts.join("");
					})
					.join("");
				return `
          <track id="${kind}-track-${track}">${items}
          </track>`;
			})
			.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="${xml(project.id)}">
    <name>${xml(project.title)}</name>
    <duration>${frameCount(duration, fps)}</duration>
    ${xmemlRate(fps)}
    <media>
      <video>${trackText("video")}</video>
      <audio>${trackText("audio")}</audio>
    </media>
  </sequence>
</xmeml>
`;
}
