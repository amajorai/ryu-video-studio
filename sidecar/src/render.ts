import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	audioProcessingFilters,
	audioTempoFilters,
} from "../../shared/audio.ts";
import { avatarRigExpression } from "../../shared/avatar.ts";
import { captionEvents } from "../../shared/caption-events.ts";
import {
	effectStackFilters,
	visualEffectFilters,
} from "../../shared/effects.ts";
import {
	type Asset,
	activeCaptions,
	animationExpression,
	isTrackAudible,
	type Project,
	projectDuration,
	segmentDuration,
	validateProject,
} from "../../shared/project.ts";
import { stageCameraExpression } from "../../shared/stage-camera.ts";
import { styleProfileConfig } from "../../shared/styles.ts";
import {
	entryExpression,
	entryScaleExpression,
} from "../../shared/transitions.ts";
import { MEDIA_FORMATS, runMedia, thumbnail } from "./media.ts";
import { renderMeshPng } from "./mesh-render.ts";
import { reviewRender } from "./review.ts";
import type { RenderJob, StudioStore } from "./store.ts";

function shadeHex(value: string, factor: number): string {
	const hex = value.replace("#", "");
	const channel = (offset: number) =>
		Math.max(
			0,
			Math.min(
				255,
				Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * factor)
			)
		);
	return `0x${[0, 2, 4]
		.map((offset) => channel(offset).toString(16).padStart(2, "0"))
		.join("")}`;
}

export function buildRender(
	p: Project,
	assets: Asset[],
	mediaPath: (id: string) => string,
	assFile?: string,
	meshInputs: Array<{
		end: number;
		path: string;
		sequence?: boolean;
		start: number;
	}> = []
): string[] {
	validateProject(p, assets);
	const duration = projectDuration(p);
	const hasWaveform = p.segments.some(
		(segment) =>
			segment.visualization === "waveform" &&
			assets.find((asset) => asset.id === segment.assetId)?.kind === "audio"
	);
	if (!duration) {
		throw new Error("Add media, graphics, or an avatar before exporting.");
	}
	const segments = [...p.segments].sort(
		(a, b) => a.track - b.track || a.start - b.start
	);
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-filter_complex_threads",
		"1",
		"-f",
		"lavfi",
		"-i",
		`color=c=${styleProfileConfig(p.styleProfile).background}:s=${p.width}x${p.height}:r=${p.fps}:d=${duration + (hasWaveform ? 1 : 0)}`,
	];
	for (const segment of segments) {
		const asset = assets.find((a) => a.id === segment.assetId);
		if (asset?.kind === "image") {
			args.push("-loop", "1");
		}
		args.push(
			"-protocol_whitelist",
			"file,pipe",
			"-format_whitelist",
			MEDIA_FORMATS,
			"-ss",
			String(segment.sourceIn),
			"-t",
			String(segment.sourceOut - segment.sourceIn),
			"-i",
			mediaPath(segment.assetId)
		);
	}
	for (const mesh of meshInputs) {
		if (mesh.sequence) {
			args.push(
				"-framerate",
				String(p.fps),
				"-t",
				String(mesh.end - mesh.start),
				"-i",
				join(mesh.path, "frame-%06d.png")
			);
		} else {
			args.push(
				"-loop",
				"1",
				"-framerate",
				String(p.fps),
				"-t",
				String(duration),
				"-i",
				mesh.path
			);
		}
	}
	const filters: string[] = ["[0:v]format=yuv420p[base]"];
	const audio: string[] = [];
	const duckedAudio: string[] = [];
	const sidechainAudio: string[] = [];
	let last = "base";
	for (const [index, s] of segments.entries()) {
		const n = index + 1;
		const asset = assets.find((a) => a.id === s.assetId);
		const length = segmentDuration(s);
		const visualize = asset?.kind === "audio" && s.visualization === "waveform";
		const audible =
			asset?.hasAudio &&
			isTrackAudible(p, s.track) &&
			(s.volume > 0 ||
				s.keyframes.some(
					(frame) => frame.property === "volume" && frame.value > 0
				));
		const tempoFilters = audioTempoFilters(s.speed);
		const processingFilters = audioProcessingFilters(
			s.audioProcessing ?? "none"
		);
		const effectFilters = [
			...visualEffectFilters(s.visualEffect ?? "none"),
			...effectStackFilters(s.effects),
		];
		const cropFilter =
			s.crop.left || s.crop.right || s.crop.top || s.crop.bottom
				? `crop=w='iw*(1-${s.crop.left + s.crop.right})':h='ih*(1-${s.crop.top + s.crop.bottom})':x='iw*${s.crop.left}':y='ih*${s.crop.top}'`
				: "null";
		const gradeBrightness = Number(
			(s.brightness + s.colorGrade.exposure / 3).toFixed(6)
		);
		const gradeSaturation = Number(
			(s.saturation * (1 + s.colorGrade.vibrance * 0.5)).toFixed(6)
		);
		const colorBalance =
			s.colorGrade.temperature || s.colorGrade.tint
				? `,colorbalance=rs=${s.colorGrade.temperature}:gs=${s.colorGrade.tint}:bs=${-s.colorGrade.temperature}`
				: "";
		const rotation = animationExpression(s, "rotation");
		const opacity = animationExpression(s, "opacity", "T");
		const opacityFilter = s.keyframes.some(
			(frame) => frame.property === "opacity"
		)
			? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacity})'`
			: `colorchannelmixer=aa=${s.opacity}`;
		const edgeFilters: string[] = [];
		if (s.edgeRounding > 0) {
			const radius = `min(W,H)*${s.edgeRounding}`;
			const corners = [
				`lt(X,${radius})*lt(Y,${radius})*lte(hypot(X-${radius},Y-${radius}),${radius})`,
				`gte(X,W-${radius})*lt(Y,${radius})*lte(hypot(X-(W-${radius}),Y-${radius}),${radius})`,
				`lt(X,${radius})*gte(Y,H-${radius})*lte(hypot(X-${radius},Y-(H-${radius})),${radius})`,
				`gte(X,W-${radius})*gte(Y,H-${radius})*lte(hypot(X-(W-${radius}),Y-(H-${radius})),${radius})`,
			];
			const mask = `gt(between(X,${radius},W-${radius})+between(Y,${radius},H-${radius})+${corners.join("+")},0)`;
			edgeFilters.push(
				`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(${mask},alpha(X,Y),0)'`
			);
		}
		if (s.edgeSoftness > 0) {
			edgeFilters.push(`boxblur=lr=0:lp=0:cr=0:cp=0:ar=${s.edgeSoftness}:ap=1`);
		}
		if (visualize) {
			const samplesPerFrame = p.width * p.fps;
			const waveformSampleRate =
				Math.ceil(48_000 / samplesPerFrame) * samplesPerFrame;
			if (audible) {
				filters.push(`[${n}:a]asplit=2[waveAudio${n}][mixAudio${n}]`);
			}
			const source = audible ? `[waveAudio${n}]` : `[${n}:a]`;
			filters.push(
				`${source}asetpts=PTS-STARTPTS,${tempoFilters.join(",")},${processingFilters.join(",")},aformat=channel_layouts=mono,aresample=${waveformSampleRate},apad=pad_dur=1,showwaves=s=${p.width}x${Math.max(2, Math.round((p.height * s.waveformHeight) / 2) * 2)}:mode=p2p:rate=${p.fps}:colors=${s.waveformColor.replace("#", "0x")}:draw=full:scale=lin,format=rgba[waveVideo${n}]`
			);
		}
		if (asset?.kind !== "audio" || visualize) {
			const w = `2*max(1,round(${p.width}*(${animationExpression(s, "scale")})/2))`;
			const h = `2*max(1,round(${p.height}*(${animationExpression(s, "scale")})/2))`;
			const entryScale = entryScaleExpression(s, `t-${s.start}`);
			const maxScale = Math.max(
				1,
				s.scale,
				...s.keyframes.filter((f) => f.property === "scale").map((f) => f.value)
			);
			const canvasW = Math.ceil((p.width * maxScale) / 2) * 2;
			const canvasH = Math.ceil((p.height * maxScale) / 2) * 2;
			const fades = [
				s.entryTransition === "crossfade" && s.entryDuration > 0
					? `fade=t=in:st=0:d=${s.entryDuration}:alpha=1`
					: "",
				s.fadeIn > 0 ? `fade=t=in:st=0:d=${s.fadeIn}:alpha=1` : "",
				s.fadeOut > 0
					? `fade=t=out:st=${length - s.fadeOut}:d=${s.fadeOut}:alpha=1`
					: "",
			].filter(Boolean);
			// A short synthetic tail lets fractional audio endpoints drain; output -t keeps
			// the requested duration. Audio video also needs time normalized before transforms
			// and frame-rate conversion follows the final timestamp adjustment.
			// Align the buffered waveform frame with the PCM window for its displayed index.
			filters.push(
				`${visualize ? `[waveVideo${n}]settb=AVTB,` : `[${n}:v]`}setpts=${visualize ? `(N-1)/(${p.fps}*TB)` : `(PTS-STARTPTS)/${s.speed}`},${visualize ? "" : `fps=${p.fps},`}${cropFilter},eq=brightness=${gradeBrightness}:contrast=${s.contrast}:saturation=${gradeSaturation}${colorBalance},${effectFilters.join(",")},rotate=a='(${rotation})*PI/180':ow=iw:oh=ih:fillcolor=black@0,format=rgba,scale='${w}*${entryScale}':'${h}*${entryScale}':force_original_aspect_ratio=decrease:eval=frame,setsar=1,pad=${canvasW}:${canvasH}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame,${opacityFilter}${edgeFilters.length ? `,${edgeFilters.join(",")}` : ""}${fades.length ? `,${fades.join(",")}` : ""},setpts=PTS+${s.start}/TB${visualize ? `,fps=${p.fps}` : ""}[v${n}]`
			);
			filters.push(
				`[${last}][v${n}]overlay=x='(W-w)/2+(${animationExpression(s, "x", `(t-${s.start})`)})*W/2+(${entryExpression(s, "x", `t-${s.start}`)})*W':y='(H-h)/2+(${animationExpression(s, "y", `(t-${s.start})`)})*H/2+(${entryExpression(s, "y", `t-${s.start}`)})*H':eof_action=pass:enable='between(t,${s.start},${s.start + length})'[out${n}]`
			);
			last = `out${n}`;
		}
		if (audible) {
			const fades = [
				s.fadeIn ? `afade=t=in:st=0:d=${s.fadeIn}` : "",
				s.fadeOut ? `afade=t=out:st=${length - s.fadeOut}:d=${s.fadeOut}` : "",
			].filter(Boolean);
			filters.push(
				`${visualize ? `[mixAudio${n}]` : `[${n}:a]`}asetpts=PTS-STARTPTS,${tempoFilters.join(",")},${processingFilters.join(",")},volume='${animationExpression(s, "volume", "if(isnan(t),0,t)")}':eval=frame${fades.length ? `,${fades.join(",")}` : ""},adelay=${Math.round(s.start * 1000)}:all=1[a${n}]`
			);
			const label = `[a${n}]`;
			audio.push(label);
			(s.duckUnderVoice ? duckedAudio : sidechainAudio).push(label);
		}
	}
	for (const [index, graphic] of [...p.graphics]
		.sort((a, b) => a.start - b.start)
		.entries()) {
		const progress = graphic.entryDuration
			? `min(1,max(0,(t-${graphic.start})/${graphic.entryDuration}))`
			: "1";
		const offset = `(1-(${progress}))*0.08`;
		const x =
			graphic.animation === "slide-left"
				? `${graphic.x}-(${offset})`
				: graphic.animation === "slide-right"
					? `${graphic.x}+(${offset})`
					: String(graphic.x);
		const y =
			graphic.animation === "slide-up"
				? `${graphic.y}+(${offset})`
				: graphic.animation === "slide-down"
					? `${graphic.y}-(${offset})`
					: String(graphic.y);
		const enable = `between(t,${graphic.start},${graphic.end})`;
		const fill = `${graphic.fill.replace("#", "0x")}@${graphic.opacity}`;
		const stroke = `${graphic.stroke.replace("#", "0x")}@${graphic.opacity}`;
		const drawBox = (
			shape: string,
			boxX: string,
			boxY: string,
			boxWidth: string,
			boxHeight: string,
			color: string,
			part: string
		) => {
			const output = `[graphic${index}${part}]`;
			filters.push(
				`[${last}]drawbox=x='iw*(${boxX})':y='ih*(${boxY})':w='iw*${boxWidth}':h='ih*${boxHeight}':color=${color}:t=fill:enable='${enable}'${output}`
			);
			last = output.slice(1, -1);
			return shape;
		};
		if (graphic.shape === "line") {
			drawBox(
				graphic.shape,
				x,
				`(${y}+${graphic.height / 2}-${Math.max(graphic.strokeWidth, 0.006) / 2})`,
				String(graphic.width),
				String(Math.max(graphic.strokeWidth, 0.006)),
				stroke,
				"line"
			);
			continue;
		}
		if (graphic.shape === "rectangle") {
			if (graphic.strokeWidth > 0) {
				const border = graphic.strokeWidth;
				drawBox(
					graphic.shape,
					x,
					y,
					String(graphic.width),
					String(graphic.height),
					stroke,
					"border"
				);
				drawBox(
					graphic.shape,
					`(${x}+${border})`,
					`(${y}+${border})`,
					String(Math.max(0.02, graphic.width - border * 2)),
					String(Math.max(0.02, graphic.height - border * 2)),
					fill,
					"fill"
				);
			} else {
				drawBox(
					graphic.shape,
					x,
					y,
					String(graphic.width),
					String(graphic.height),
					fill,
					"rect"
				);
			}
			continue;
		}
		const slices = 16;
		for (let slice = 0; slice < slices; slice++) {
			const fraction = (slice + 0.5) / slices;
			const sliceHeight = graphic.height / slices;
			const sliceWidth =
				graphic.shape === "ellipse"
					? graphic.width * Math.sqrt(Math.max(0, 1 - (2 * fraction - 1) ** 2))
					: graphic.width * fraction;
			const sliceX = `(${x}+(${graphic.width}-${sliceWidth})/2)`;
			const sliceY = `(${y}+${slice * sliceHeight})`;
			drawBox(
				graphic.shape,
				sliceX,
				sliceY,
				String(Math.max(0.004, sliceWidth)),
				String(sliceHeight + 0.001),
				fill,
				`${graphic.shape}${slice}`
			);
		}
	}
	for (const [index, avatar] of [...p.avatars]
		.sort((a, b) => a.start - b.start)
		.entries()) {
		const progress = avatar.entryDuration
			? `min(1,max(0,(t-${avatar.start})/${avatar.entryDuration}))`
			: "1";
		const entryOffset = `(1-(${progress}))*0.08`;
		const slide =
			avatar.animation === "slide-left"
				? `-(${entryOffset})`
				: avatar.animation === "slide-right"
					? `(${entryOffset})`
					: "0";
		const bob =
			avatar.animation === "idle"
				? `sin((t-${avatar.start})*6.283185)*0.01`
				: "0";
		const x = `(${avatar.x}+${slide}+${avatar.depth * 0.02})`;
		const y = `(${avatar.y}+${bob})`;
		const width = String(avatar.width);
		const height = String(avatar.height);
		const color = (value: string, opacity = 1) =>
			`${value.replace("#", "0x")}@${opacity}`;
		const leftArmAngle = `(${avatarRigExpression(avatar, "leftArm")})*0.0174533`;
		const rightArmAngle = `(${avatarRigExpression(avatar, "rightArm")})*0.0174533`;
		const leftLegAngle = `(${avatarRigExpression(avatar, "leftLeg")})*0.0174533`;
		const rightLegAngle = `(${avatarRigExpression(avatar, "rightLeg")})*0.0174533`;
		const headTurn = `(${avatarRigExpression(avatar, "head")})*0.0015`;
		const mouth = avatarRigExpression(avatar, "mouth");
		const boxes = [
			{
				color: color(avatar.accent, 0.35),
				height: `${height}*0.1`,
				width: `${width}*0.8`,
				x: `${x}+${width}*0.1`,
				y: `${y}+${height}*0.87`,
			},
			{
				color: color(avatar.skin),
				height: `${height}*0.29`,
				width: `${width}*0.12`,
				x: `${x}+${width}*0.12+sin(${leftArmAngle})*${width}*0.16`,
				y: `${y}+${height}*0.34+cos(${leftArmAngle})*${height}*0.02`,
			},
			{
				color: color(avatar.skin),
				height: `${height}*0.29`,
				width: `${width}*0.12`,
				x: `${x}+${width}*0.76+sin(${rightArmAngle})*${width}*0.16`,
				y: `${y}+${height}*0.34+cos(${rightArmAngle})*${height}*0.02`,
			},
			{
				color: color(avatar.outfit),
				height: `${height}*0.24`,
				width: `${width}*0.14`,
				x: `${x}+${width}*0.3+sin(${leftLegAngle})*${width}*0.09`,
				y: `${y}+${height}*0.73+cos(${leftLegAngle})*${height}*0.02`,
			},
			{
				color: color(avatar.outfit),
				height: `${height}*0.24`,
				width: `${width}*0.14`,
				x: `${x}+${width}*0.56+sin(${rightLegAngle})*${width}*0.09`,
				y: `${y}+${height}*0.73+cos(${rightLegAngle})*${height}*0.02`,
			},
			{
				color: color(avatar.outfit),
				height: `${height}*0.48`,
				width: `${width}*0.52`,
				x: `${x}+${width}*0.24`,
				y: `${y}+${height}*0.42`,
			},
			{
				color: color(avatar.skin),
				height: `${height}*0.35`,
				width: `${width}*0.52`,
				x: `${x}+${width}*0.24+${headTurn}`,
				y: `${y}+${height}*0.08`,
			},
			{
				color: color(avatar.accent),
				height: `${height}*0.1`,
				width: `${width}*0.44`,
				x: `${x}+${width}*0.28`,
				y: `${y}+${height}*0.05`,
			},
			{
				color: "0x1b1b1b",
				height: `${height}*0.05`,
				width: `${width}*0.05`,
				x: `${x}+${width}*0.39+${headTurn}`,
				y: `${y}+${height}*0.22`,
			},
			{
				color: "0x1b1b1b",
				height: `${height}*0.05`,
				width: `${width}*0.05`,
				x: `${x}+${width}*0.56+${headTurn}`,
				y: `${y}+${height}*0.22`,
			},
			{
				color: color(avatar.accent),
				height: `${height}*0.06`,
				width: `${width}*0.06`,
				x: `${x}+${width}*0.47`,
				y: `${y}+${height}*0.56`,
			},
			{
				color: "0x1b1b1b",
				height: `${height}*0.035`,
				width: `${width}*(0.04+0.12*(${mouth}))`,
				x: `${x}+${width}*0.5-${width}*(0.02+0.06*(${mouth}))`,
				y: `${y}+${height}*0.33`,
			},
		];
		for (const [part, box] of boxes.entries()) {
			const output = `avatar${index}part${part}`;
			filters.push(
				`[${last}]drawbox=x='iw*(${box.x})':y='ih*(${box.y})':w='iw*(${box.width})':h='ih*(${box.height})':color=${box.color}:t=fill:enable='between(t,${avatar.start},${avatar.end})'[${output}]`
			);
			last = output;
		}
	}
	for (const [index, object] of [...p.spatialObjects]
		.sort((a, b) => a.start - b.start)
		.entries()) {
		const progress = object.entryDuration
			? `min(1,max(0,(t-${object.start})/${object.entryDuration}))`
			: "1";
		const orbit =
			object.animation === "orbit-left"
				? `(-1)*sin((t-${object.start})*6.283185)*0.18`
				: object.animation === "orbit-right"
					? `sin((t-${object.start})*6.283185)*0.18`
					: "0";
		const float =
			object.animation === "float"
				? `cos((t-${object.start})*6.283185)*0.02`
				: "0";
		const cameraOrbit = stageCameraExpression(p.stageCamera, "orbit");
		const cameraX = stageCameraExpression(p.stageCamera, "x");
		const cameraY = stageCameraExpression(p.stageCamera, "y");
		const cameraTilt = stageCameraExpression(p.stageCamera, "tilt");
		const cameraZoom = stageCameraExpression(p.stageCamera, "zoom");
		const z = `(${object.z}+${orbit}+${cameraOrbit})`;
		const centerX = `(0.5+(${object.x}-${cameraX}+${z}*0.12)*0.5)`;
		const centerY = `(0.5+(${object.y}-${cameraY}-${z}*0.08+${float}+${cameraTilt}*${z}*0.08)*0.5)`;
		const perspective = `(${cameraZoom}*(1+${z}*0.18))`;
		const width = `(${object.width}*${perspective})`;
		const height = `(${object.height}*${perspective})`;
		const extrusion = `(${object.depth}*0.08)`;
		const boxes = [
			{
				color: shadeHex(object.fill, 1),
				height,
				width,
				x: `${centerX}-${width}/2`,
				y: `${centerY}-${height}/2`,
			},
			{
				color: shadeHex(object.fill, 1.22),
				height: extrusion,
				width: `(${width}*0.92)`,
				x: `${centerX}-${width}/2+${width}*0.08`,
				y: `${centerY}-${height}/2-${extrusion}`,
			},
			{
				color: shadeHex(object.fill, 0.68),
				height,
				width: extrusion,
				x: `${centerX}+${width}/2`,
				y: `${centerY}-${height}/2`,
			},
		];
		for (const [part, box] of boxes.entries()) {
			const output = `stage${index}part${part}`;
			filters.push(
				`[${last}]drawbox=x='iw*(${box.x})':y='ih*(${box.y})':w='iw*${box.width}':h='ih*${box.height}':color=${box.color}:t=fill:enable='between(t,${object.start},${object.end})'[${output}]`
			);
			last = output;
		}
	}
	for (const [index, mesh] of meshInputs.entries()) {
		const input = segments.length + index + 1;
		const output = `mesh${index}`;
		const timing = mesh.sequence
			? `setpts=PTS-STARTPTS+${mesh.start}/TB`
			: "null";
		filters.push(`[${input}:v]format=rgba,${timing}[meshInput${index}]`);
		filters.push(
			`[${last}][meshInput${index}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${mesh.start},${mesh.end})'[${output}]`
		);
		last = output;
	}
	if (assFile) {
		filters.push(`[${last}]subtitles=${assFile}[captioned]`);
		last = "captioned";
	}
	if (audio.length) {
		let mixInputs = audio;
		if (duckedAudio.length && sidechainAudio.length) {
			filters.push(
				`${sidechainAudio.join("")}amix=inputs=${sidechainAudio.length}:normalize=0[sidechainMix]`
			);
			const sidechainLabels = duckedAudio.map(
				(_, index) => `[sidechain${index}]`
			);
			filters.push(
				`[sidechainMix]asplit=${duckedAudio.length + 1}[sidechainMain]${sidechainLabels.join("")}`
			);
			const compressed = duckedAudio.map((source, index) => {
				const output = `[ducked${index}]`;
				filters.push(
					`${source}${sidechainLabels[index]}sidechaincompress=threshold=0.05:ratio=8:attack=20:release=250:makeup=1${output}`
				);
				return output;
			});
			mixInputs = ["[sidechainMain]", ...compressed];
		}
		filters.push(
			`${mixInputs.join("")}amix=inputs=${mixInputs.length}:normalize=0,alimiter=limit=0.95:level=0[mix]`
		);
	}
	args.push("-filter_complex", filters.join(";"), "-map", `[${last}]`);
	if (audio.length) {
		args.push("-map", "[mix]", "-c:a", "aac", "-b:a", "192k");
	}
	args.push("-t", String(duration), "-r", String(p.fps));
	if (p.exportCodec === "prores") {
		args.push(
			"-c:v",
			"prores_ks",
			"-profile:v",
			"3",
			"-pix_fmt",
			"yuv422p10le",
			"-threads",
			"2"
		);
	} else {
		args.push(
			"-c:v",
			p.exportCodec === "h265" ? "libx265" : "libx264",
			"-preset",
			p.exportPreset === "review"
				? "veryfast"
				: p.exportPreset === "social"
					? "medium"
					: "fast",
			"-crf",
			p.exportCodec === "h265"
				? p.exportPreset === "review"
					? "30"
					: p.exportPreset === "social"
						? "25"
						: "24"
				: p.exportPreset === "review"
					? "26"
					: p.exportPreset === "social"
						? "21"
						: "20",
			"-pix_fmt",
			"yuv420p",
			...(p.exportCodec === "h265" ? ["-tag:v", "hvc1"] : []),
			"-movflags",
			"+faststart",
			"-threads",
			"2"
		);
	}
	return args;
}

export function assCaptions(p: Project): string {
	const captions = activeCaptions(p);
	const stamp = (seconds: number) => {
		const cs = Math.round(seconds * 100);
		return `${Math.floor(cs / 360_000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
	};
	const text = (s: string) =>
		s
			.replace(/\\/g, "＼")
			.replace(/\{/g, "｛")
			.replace(/\}/g, "｝")
			.replace(/\r?\n/g, "\\N");
	const titleEvents = p.titles
		.map((title) => {
			const rgb = title.color.slice(1);
			const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
			const x = Math.round(title.x * p.width);
			const y = Math.round(title.y * p.height);
			const travelX = Math.round(p.width * 0.08);
			const travelY = Math.round(p.height * 0.08);
			const motion =
				title.animation === "slide-up"
					? `\\move(${x},${y + travelY},${x},${y},0,${Math.round(title.fadeIn * 1000)})`
					: title.animation === "slide-down"
						? `\\move(${x},${y - travelY},${x},${y},0,${Math.round(title.fadeIn * 1000)})`
						: title.animation === "slide-left"
							? `\\move(${x + travelX},${y},${x},${y},0,${Math.round(title.fadeIn * 1000)})`
							: title.animation === "slide-right"
								? `\\move(${x - travelX},${y},${x},${y},0,${Math.round(title.fadeIn * 1000)})`
								: `\\pos(${x},${y})`;
			const style = `{\\an5${motion}\\fs${Math.round(title.fontSize * p.height)}\\c&H${bgr}&\\fad(${Math.round(title.fadeIn * 1000)},${Math.round(title.fadeOut * 1000)})}`;
			return `Dialogue: 1,${stamp(title.start)},${stamp(title.end)},Default,,0,0,0,,${style}${text(title.text)}`;
		})
		.join("\n");
	return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${p.width}\nPlayResY: ${p.height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${Math.round(p.height * 0.045)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,${Math.round(p.height * 0.08)},1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${captions
		.flatMap((c) =>
			captionEvents(c).map((event) => {
				const rgb = (c.highlightColor ?? "#ffd43b").slice(1);
				const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
				const words = event.parts
					.map(
						(part) =>
							`${c.words?.length ? `{\\c&H${part.active ? bgr : "FFFFFF"}&}` : ""}${text(part.text)}`
					)
					.join("");
				return `Dialogue: 0,${stamp(event.start)},${stamp(event.end)},Default,,0,0,0,,${words}`;
			})
		)
		.join("\n")}\n${titleEvents}\n`;
}

export class RenderQueue {
	private readonly active = new Map<string, AbortController>();
	constructor(private readonly store: StudioStore) {}
	start(project: Project): RenderJob {
		validateProject(project, this.store.assets());
		if (
			!(
				project.segments.length ||
				project.titles.length ||
				project.graphics.length ||
				project.avatars.length ||
				project.spatialObjects.length ||
				project.meshes.length
			)
		) {
			throw new Error(
				"Add media, graphics, an avatar, or a 3D block before exporting."
			);
		}
		if (
			project.requireApproval &&
			(!project.scenes.length ||
				project.scenes.some((s) => !(s.approved && s.assetIds.length)))
		) {
			throw new Error(
				"Approve every storyboard scene and select its media before exporting."
			);
		}
		if (project.requireApproval) {
			const approvedAssets = new Set(
				project.scenes.filter((s) => s.approved).flatMap((s) => s.assetIds)
			);
			if (
				project.segments.some((segment) => !approvedAssets.has(segment.assetId))
			) {
				throw new Error(
					"The timeline contains media that has not been approved in the storyboard."
				);
			}
		}
		if (this.active.size >= 2) {
			throw new Error("Two exports are already running. Wait or cancel one.");
		}
		const job: RenderJob = {
			codec: project.exportCodec,
			id: crypto.randomUUID(),
			projectId: project.id,
			revision: project.revision,
			status: "pending",
			progress: 0,
			createdAt: new Date().toISOString(),
		};
		const controller = new AbortController();
		this.active.set(job.id, controller);
		this.store.putJob(job);
		void this.render(job, project, controller);
		return job;
	}
	cancel(id: string) {
		const controller = this.active.get(id);
		if (!controller) {
			throw new Error("This export is no longer running.");
		}
		controller.abort();
	}
	private async render(
		job: RenderJob,
		project: Project,
		controller: AbortController
	) {
		const work = join(this.store.directory, "renders", job.id);
		const outputPath = this.store.renderPath(
			job.id,
			job.codec ?? project.exportCodec
		);
		try {
			await mkdir(work, { mode: 0o700 });
			job.status = "running";
			job.progress = 0.05;
			this.store.putJob(job);
			const captions = activeCaptions(project);
			if (captions.length || project.titles.length) {
				await Bun.write(join(work, "captions.ass"), assCaptions(project));
			}
			const meshInputs: Array<{
				end: number;
				path: string;
				sequence?: boolean;
				start: number;
			}> = [];
			for (const [index, mesh] of project.meshes.entries()) {
				if (!(mesh.keyframes?.length ?? 0)) {
					const path = join(work, `mesh-${index}.png`);
					await Bun.write(
						path,
						renderMeshPng(project, mesh, project.width, project.height)
					);
					meshInputs.push({ end: mesh.end, path, start: mesh.start });
					continue;
				}
				const directory = join(work, `mesh-${index}`);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const frameCount = Math.ceil((mesh.end - mesh.start) * project.fps) + 1;
				for (let frame = 0; frame < frameCount; frame++) {
					await Bun.write(
						join(directory, `frame-${String(frame).padStart(6, "0")}.png`),
						renderMeshPng(
							project,
							mesh,
							project.width,
							project.height,
							mesh.start + frame / project.fps
						)
					);
				}
				meshInputs.push({
					end: mesh.end,
					path: directory,
					sequence: true,
					start: mesh.start,
				});
			}
			const { refreshSequenceAssets } = await import("./sequence.ts");
			await refreshSequenceAssets(this.store, project);
			const args = buildRender(
				project,
				this.store.assets(),
				(id) => this.store.mediaPath(id),
				captions.length || project.titles.length ? "captions.ass" : undefined,
				meshInputs
			);
			try {
				await runMedia([...args, outputPath], {
					cwd: work,
					signal: controller.signal,
				});
			} catch (error) {
				throw new Error(
					`Render encode failed: ${
						error instanceof Error ? error.message : "unknown error"
					}`
				);
			}
			job.progress = 0.9;
			this.store.putJob(job);
			let review: NonNullable<RenderJob["review"]>;
			try {
				review = await reviewRender(outputPath, {
					width: project.width,
					height: project.height,
					fps: project.fps,
					duration: projectDuration(project),
					hasAudio: project.segments.some((segment) => {
						const asset = this.store
							.assets()
							.find((candidate) => candidate.id === segment.assetId);
						return Boolean(
							asset?.hasAudio &&
								isTrackAudible(project, segment.track) &&
								(segment.volume > 0 ||
									segment.keyframes.some(
										(frame) => frame.property === "volume" && frame.value > 0
									))
						);
					}),
				});
			} catch (error) {
				throw new Error(
					`Delivery review could not inspect the render: ${
						error instanceof Error ? error.message : "unknown error"
					}`
				);
			}
			if (!review.passed) {
				const failed = review.checks
					.filter((check) => check.status === "failed")
					.map((check) => check.message)
					.join(" ");
				throw new Error(`Delivery review failed. ${failed}`);
			}
			try {
				await thumbnail(
					outputPath,
					join(this.store.directory, "renders"),
					job.id
				);
			} catch (error) {
				throw new Error(
					`Delivery thumbnail failed: ${
						error instanceof Error ? error.message : "unknown error"
					}`
				);
			}
			if (controller.signal.aborted) {
				throw new Error("Operation canceled.");
			}
			job.review = review;
			job.status = "completed";
			job.progress = 1;
			this.store.putJob(job);
		} catch (error) {
			job.status = controller.signal.aborted ? "canceled" : "failed";
			job.error = error instanceof Error ? error.message : "Export failed.";
			this.store.putJob(job);
			await rm(outputPath, { force: true });
		} finally {
			this.active.delete(job.id);
			await rm(work, { recursive: true, force: true });
		}
	}
	stop() {
		for (const controller of this.active.values()) {
			controller.abort();
		}
	}
}
