import { useEffect, useRef } from "react";
import { avatarPoseAtTime } from "../../shared/avatar.ts";
import {
	effectStackCss,
	effectStackVignetteAmount,
} from "../../shared/effects.ts";
import { meshBounds } from "../../shared/mesh.ts";
import {
	meshPoseAtTime,
	meshVerticesAtTime,
} from "../../shared/mesh-animation.ts";
import {
	type Asset,
	activeCaptions,
	animatedValue,
	isTrackAudible,
	type Project,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import { stageCameraAtTime } from "../../shared/stage-camera.ts";
import { styleProfileConfig } from "../../shared/styles.ts";
import {
	entryOpacity,
	entryScale,
	entryShift,
} from "../../shared/transitions.ts";
import { connectPreviewAudio, resumePreviewAudio } from "./audio-preview.ts";
import { Waveform } from "./Waveform.tsx";

function AvatarLayer({
	avatar,
	time,
}: {
	avatar: Project["avatars"][number];
	time: number;
}) {
	const elapsed = time - avatar.start;
	const progress = avatar.entryDuration
		? Math.min(1, Math.max(0, elapsed / avatar.entryDuration))
		: 1;
	const entryOffset = (1 - progress) * 8;
	const slide =
		avatar.animation === "slide-left"
			? -entryOffset
			: avatar.animation === "slide-right"
				? entryOffset
				: 0;
	const bob =
		avatar.animation === "idle" ? Math.sin(elapsed * Math.PI * 2) * 1.5 : 0;
	const pose = avatarPoseAtTime(avatar, time);
	return (
		<div
			aria-label="2.5D avatar"
			className="studio-avatar"
			style={{
				filter: `drop-shadow(${avatar.depth * 10}px ${avatar.depth * 14}px ${avatar.depth * 8}px rgb(0 0 0 / ${0.35 + avatar.depth * 0.25}))`,
				height: `${avatar.height * 100}%`,
				left: `${avatar.x * 100}%`,
				top: `${avatar.y * 100}%`,
				opacity: progress,
				transform: `translate(${slide}%, ${bob}%)`,
				width: `${avatar.width * 100}%`,
			}}
		>
			<div
				className="studio-avatar-shadow"
				style={{ backgroundColor: avatar.accent }}
			/>
			<div
				className="studio-avatar-arm studio-avatar-arm-left"
				style={{
					backgroundColor: avatar.skin,
					transform: `rotate(${pose.leftArm}deg)`,
				}}
			/>
			<div
				className="studio-avatar-arm studio-avatar-arm-right"
				style={{
					backgroundColor: avatar.skin,
					transform: `rotate(${pose.rightArm}deg)`,
				}}
			/>
			<div
				className="studio-avatar-leg studio-avatar-leg-left"
				style={{
					backgroundColor: avatar.outfit,
					transform: `rotate(${pose.leftLeg}deg)`,
				}}
			/>
			<div
				className="studio-avatar-leg studio-avatar-leg-right"
				style={{
					backgroundColor: avatar.outfit,
					transform: `rotate(${pose.rightLeg}deg)`,
				}}
			/>
			<div
				className="studio-avatar-body"
				style={{ backgroundColor: avatar.outfit }}
			/>
			<div
				className="studio-avatar-head"
				style={{
					backgroundColor: avatar.skin,
					transform: `rotate(${pose.head}deg)`,
				}}
			>
				<span className="studio-avatar-eye studio-avatar-eye-left" />
				<span className="studio-avatar-eye studio-avatar-eye-right" />
				<span
					className="studio-avatar-hair"
					style={{ backgroundColor: avatar.accent }}
				/>
				<span
					className="studio-avatar-mouth"
					style={{ width: `${10 + pose.mouth * 36}%` }}
				/>
			</div>
			<div
				className="studio-avatar-badge"
				style={{ backgroundColor: avatar.accent }}
			/>
		</div>
	);
}

function StageObjectLayer({
	camera,
	object,
	time,
}: {
	camera: Project["stageCamera"];
	object: Project["spatialObjects"][number];
	time: number;
}) {
	const elapsed = time - object.start;
	const progress = object.entryDuration
		? Math.min(1, Math.max(0, elapsed / object.entryDuration))
		: 1;
	const orbit =
		object.animation === "orbit-left"
			? -Math.sin(elapsed * Math.PI * 2) * 0.18
			: object.animation === "orbit-right"
				? Math.sin(elapsed * Math.PI * 2) * 0.18
				: 0;
	const float =
		object.animation === "float" ? Math.cos(elapsed * Math.PI * 2) * 0.02 : 0;
	const depth = object.z + orbit + camera.orbit;
	const perspective = camera.zoom * (1 + depth * 0.18);
	const worldX = object.x - camera.x + depth * 0.12;
	const worldY =
		object.y - camera.y - depth * 0.08 + float + camera.tilt * depth * 0.08;
	return (
		<div
			aria-label="3D stage object"
			className="studio-stage-object"
			style={{
				height: `${object.height * 100}%`,
				left: `${(0.5 + worldX * 0.5) * 100}%`,
				top: `${(0.5 + worldY * 0.5) * 100}%`,
				opacity: progress,
				transform: `translate(-50%, -50%) scale(${perspective}) rotateY(${depth * 18}deg)`,
				width: `${object.width * 100}%`,
			}}
		>
			<div
				className="studio-stage-object-front"
				style={{ backgroundColor: object.fill }}
			/>
			<div
				className="studio-stage-object-top"
				style={{ backgroundColor: object.fill }}
			/>
			<div
				className="studio-stage-object-side"
				style={{ backgroundColor: object.fill }}
			/>
		</div>
	);
}

function MeshLayer({
	camera,
	mesh,
	time,
}: {
	camera: Project["stageCamera"];
	mesh: Project["meshes"][number];
	time: number;
}) {
	const bounds = meshBounds(mesh);
	const center = {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
		z: (bounds.minZ + bounds.maxZ) / 2,
	};
	const span = Math.max(
		bounds.maxX - bounds.minX,
		bounds.maxY - bounds.minY,
		bounds.maxZ - bounds.minZ,
		0.001
	);
	const pose = meshPoseAtTime(mesh, time);
	const rotate = (vertex: readonly [number, number, number]) => {
		let [x, y, z] = vertex.map(
			(value) => ((value - center.x) / span) * mesh.scale
		) as [number, number, number];
		const rotateAxis = (angle: number, a: "x" | "y" | "z") => {
			const radians = (angle * Math.PI) / 180;
			const sin = Math.sin(radians);
			const cos = Math.cos(radians);
			if (a === "x") {
				[y, z] = [y * cos - z * sin, y * sin + z * cos];
			} else if (a === "y") {
				[x, z] = [x * cos + z * sin, -x * sin + z * cos];
			} else {
				[x, y] = [x * cos - y * sin, x * sin + y * cos];
			}
		};
		rotateAxis(pose.rotationX, "x");
		rotateAxis(pose.rotationY, "y");
		rotateAxis(pose.rotationZ, "z");
		return [x, y, z] as const;
	};
	const points = meshVerticesAtTime(mesh, time).map(rotate);
	const faces = [...mesh.faces].sort(
		(a, b) =>
			b.reduce((sum, index) => sum + (points[index]?.[2] ?? 0), 0) / b.length -
			a.reduce((sum, index) => sum + (points[index]?.[2] ?? 0), 0) / a.length
	);
	const progress = Math.min(1, Math.max(0, (time - mesh.start) / 0.35));
	return (
		<svg
			aria-label="Imported 3D mesh"
			className="studio-mesh-layer"
			style={{ opacity: progress }}
			viewBox="0 0 1000 1000"
		>
			{mesh.texture && (
				<defs>
					<pattern
						height="1"
						id={`mesh-texture-${mesh.id}`}
						patternContentUnits="objectBoundingBox"
						patternUnits="objectBoundingBox"
						width="1"
						x="0"
						y="0"
					>
						<image
							height="1"
							href={mesh.texture}
							preserveAspectRatio="xMidYMid slice"
							width="1"
							x="0"
							y="0"
						/>
					</pattern>
				</defs>
			)}
			{faces.map((face, index) => {
				const projected = face
					.map((vertexIndex) => points[vertexIndex])
					.filter((vertex): vertex is readonly [number, number, number] =>
						Boolean(vertex)
					)
					.map(([x, y, z]) => {
						const depth = pose.z + z + camera.orbit;
						const worldX = pose.x - camera.x + depth * 0.12;
						const worldY =
							pose.y - camera.y - depth * 0.08 + camera.tilt * depth * 0.08;
						return `${(0.5 + (worldX + x) * 0.5 * camera.zoom) * 1000},${(0.5 + (worldY + y) * 0.5 * camera.zoom) * 1000}`;
					})
					.join(" ");
				return (
					<polygon
						fill={mesh.texture ? `url(#mesh-texture-${mesh.id})` : mesh.fill}
						key={`${mesh.id}:${index}`}
						points={projected}
						stroke="rgb(0 0 0 / 0.3)"
						strokeWidth="3"
					/>
				);
			})}
		</svg>
	);
}

function MediaLayer({
	asset,
	segment: s,
	src,
	time,
	playing,
	fps,
	audible,
	onError,
}: {
	asset: Asset;
	audible: boolean;
	segment: Segment;
	src: string;
	time: number;
	playing: boolean;
	fps: number;
	onError?: (message: string) => void;
}) {
	const media = useRef<HTMLVideoElement>(null);
	const audioGraph = useRef<ReturnType<typeof connectPreviewAudio> | null>(
		null
	);
	useEffect(() => {
		const element = media.current;
		if (!(element && asset.hasAudio)) {
			return;
		}
		try {
			audioGraph.current = connectPreviewAudio(
				element,
				s.audioProcessing ?? "none"
			);
		} catch {
			onError?.("Audio preview could not be initialized.");
		}
		return () => {
			element.pause();
			audioGraph.current?.dispose();
			audioGraph.current = null;
		};
	}, [asset.hasAudio, onError, playing, s.audioProcessing]);

	const active = time >= s.start && time < s.start + segmentDuration(s);
	useEffect(() => {
		const el = media.current;
		if (!el) {
			return;
		}
		const desired = Math.min(
			s.sourceOut,
			s.sourceIn + Math.max(0, time - s.start) * s.speed
		);
		if (Math.abs(el.currentTime - desired) > (playing ? 0.15 : 1 / (fps * 2))) {
			el.currentTime = desired;
		}
		el.playbackRate = s.speed;
		const elapsed = time - s.start;
		const remaining = segmentDuration(s) - elapsed;
		const fade = Math.max(
			0,
			Math.min(
				1,
				s.fadeIn ? elapsed / s.fadeIn : 1,
				s.fadeOut ? remaining / s.fadeOut : 1
			)
		);
		const volume =
			active && audible ? animatedValue(s, "volume", elapsed) * fade : 0;
		if (audioGraph.current) {
			el.volume = 1;
			audioGraph.current.gain.gain.value = volume;
		} else {
			el.volume = Math.min(1, volume);
		}
		if (playing && active) {
			void resumePreviewAudio()
				.then(() => el.play())
				.catch(() =>
					onError?.("Playback could not start. Press Play to try again.")
				);
		} else {
			el.pause();
		}
	}, [time, s, playing, active, audible, fps, onError]);
	const elapsed = time - s.start;
	const fade = Math.min(
		1,
		s.fadeIn ? elapsed / s.fadeIn : 1,
		s.fadeOut ? (segmentDuration(s) - elapsed) / s.fadeOut : 1
	);
	const vignette = effectStackVignetteAmount(s.effects);
	const vignetteOverlay =
		active && vignette > 0 ? (
			<div
				aria-hidden="true"
				className="studio-media-layer"
				style={{
					background:
						"radial-gradient(ellipse at center, transparent 35%, rgb(0 0 0 / 0.92) 100%)",
					mixBlendMode: "multiply",
					opacity: vignette,
					pointerEvents: "none",
					zIndex: s.track + 2,
				}}
			/>
		) : null;
	const style = {
		clipPath: `inset(${s.crop.top * 100}% ${s.crop.right * 100}% ${s.crop.bottom * 100}% ${s.crop.left * 100}% round ${s.edgeRounding * 100}%)`,
		opacity: active
			? animatedValue(s, "opacity", elapsed) *
				Math.max(0, fade) *
				entryOpacity(s, elapsed)
			: 0,
		transform: `translate(${animatedValue(s, "x", elapsed) * 50 + entryShift(s, elapsed, "x") * 100}%, ${animatedValue(s, "y", elapsed) * 50 + entryShift(s, elapsed, "y") * 100}%) scale(${animatedValue(s, "scale", elapsed) * entryScale(s, elapsed)}) rotate(${animatedValue(s, "rotation", elapsed)}deg)`,
		filter: `${
			s.visualEffect === "blur"
				? "blur(2px)"
				: s.visualEffect === "grayscale"
					? "grayscale(1)"
					: s.visualEffect === "sepia"
						? "sepia(1)"
						: ""
		} ${effectStackCss(s.effects).join(" ")} brightness(${1 + s.brightness + s.colorGrade.exposure / 3}) contrast(${s.contrast}) saturate(${s.saturation * (1 + s.colorGrade.vibrance * 0.5)}) hue-rotate(${s.colorGrade.tint * 18 - s.colorGrade.temperature * 6}deg)${s.edgeSoftness ? ` blur(${s.edgeSoftness}px)` : ""}`,
		zIndex: s.track + 1,
	};
	if (asset.kind === "image") {
		return (
			<>
				<img
					alt={asset.name}
					className="studio-media-layer"
					src={src}
					style={style}
				/>
				{vignetteOverlay}
			</>
		);
	}
	return (
		<>
			<video
				aria-label={asset.name}
				className="studio-media-layer"
				onError={() => onError?.("This source could not be previewed.")}
				onLoadedMetadata={() => {
					const element = media.current;
					if (element) {
						element.currentTime = Math.min(
							s.sourceOut,
							s.sourceIn + Math.max(0, time - s.start) * s.speed
						);
					}
				}}
				playsInline
				preload="auto"
				ref={media}
				src={src}
				style={{
					...style,
					visibility: asset.kind === "audio" ? "hidden" : "visible",
				}}
			/>
			{asset.kind === "audio" && s.visualization === "waveform" && active && (
				<div className="studio-media-layer" style={style}>
					<Waveform
						assetId={asset.id}
						color={s.waveformColor}
						fps={fps}
						height={s.waveformHeight}
						sourceIn={s.sourceIn}
						sourceOut={s.sourceOut}
						speed={s.speed}
						time={time - s.start}
					/>
				</div>
			)}
			{vignetteOverlay}
		</>
	);
}
export function Preview({
	project,
	assets,
	sources,
	time,
	playing,
	onError,
}: {
	project: Project;
	assets: Asset[];
	sources: Record<string, string>;
	time: number;
	playing: boolean;
	onError?: (message: string) => void;
}) {
	const captions = activeCaptions(project);
	const camera = stageCameraAtTime(project.stageCamera, time);
	return (
		<div
			className="studio-preview-frame"
			style={{
				aspectRatio: `${project.width}/${project.height}`,
				backgroundColor: styleProfileConfig(project.styleProfile).background,
				width: `min(100cqw, calc(100cqh * ${project.width / project.height}))`,
			}}
		>
			{project.segments.map((s) => {
				const asset = assets.find((a) => a.id === s.assetId);
				const src = sources[s.assetId];
				return asset && src ? (
					<MediaLayer
						asset={asset}
						audible={isTrackAudible(project, s.track)}
						fps={project.fps}
						key={`${s.id}:${asset.id}`}
						onError={onError}
						playing={playing}
						segment={s}
						src={src}
						time={time}
					/>
				) : null;
			})}
			{project.titles
				.filter((title) => time >= title.start && time < title.end)
				.map((title) => {
					const elapsed = time - title.start;
					const remaining = title.end - time;
					const entryProgress = title.fadeIn
						? Math.min(1, Math.max(0, elapsed / title.fadeIn))
						: 1;
					const entryOffset = (1 - entryProgress) * 0.08;
					const transform =
						title.animation === "slide-up"
							? `translateY(${entryOffset * 100}%)`
							: title.animation === "slide-down"
								? `translateY(${-entryOffset * 100}%)`
								: title.animation === "slide-left"
									? `translateX(${entryOffset * 100}%)`
									: title.animation === "slide-right"
										? `translateX(${-entryOffset * 100}%)`
										: undefined;
					const opacity = Math.max(
						0,
						Math.min(
							1,
							title.fadeIn ? elapsed / title.fadeIn : 1,
							title.fadeOut ? remaining / title.fadeOut : 1
						)
					);
					return (
						<div
							className="studio-title"
							key={title.id}
							style={{
								left: `${title.x * 100}%`,
								top: `${title.y * 100}%`,
								fontSize: `${((title.fontSize * project.height) / project.width) * 100}cqw`,
								color: title.color,
								opacity,
								transform,
							}}
						>
							{title.text}
						</div>
					);
				})}
			{project.graphics
				.filter((graphic) => time >= graphic.start && time < graphic.end)
				.map((graphic) => {
					const elapsed = time - graphic.start;
					const progress = graphic.entryDuration
						? Math.min(1, Math.max(0, elapsed / graphic.entryDuration))
						: 1;
					const offset = (1 - progress) * 8;
					const transform =
						graphic.animation === "slide-up"
							? `translateY(${offset}%)`
							: graphic.animation === "slide-down"
								? `translateY(${-offset}%)`
								: graphic.animation === "slide-left"
									? `translateX(${-offset}%)`
									: graphic.animation === "slide-right"
										? `translateX(${offset}%)`
										: undefined;
					return (
						<div
							className="studio-graphic"
							key={graphic.id}
							style={{
								backgroundColor:
									graphic.shape === "line" ? graphic.stroke : graphic.fill,
								height: `${(graphic.shape === "line" ? Math.max(graphic.strokeWidth, 0.006) : graphic.height) * 100}%`,
								left: `${graphic.x * 100}%`,
								top: `${(graphic.shape === "line" ? graphic.y + graphic.height / 2 - Math.max(graphic.strokeWidth, 0.006) / 2 : graphic.y) * 100}%`,
								opacity: graphic.opacity,
								border:
									graphic.shape !== "line" && graphic.strokeWidth > 0
										? `${graphic.strokeWidth * 100}% solid ${graphic.stroke}`
										: undefined,
								borderRadius: graphic.shape === "ellipse" ? "50%" : undefined,
								clipPath:
									graphic.shape === "triangle"
										? "polygon(50% 0%, 100% 100%, 0% 100%)"
										: undefined,
								transform,
								width: `${graphic.width * 100}%`,
							}}
						/>
					);
				})}
			{project.avatars
				.filter((avatar) => time >= avatar.start && time < avatar.end)
				.map((avatar) => (
					<AvatarLayer avatar={avatar} key={avatar.id} time={time} />
				))}
			{project.spatialObjects
				.filter((object) => time >= object.start && time < object.end)
				.map((object) => (
					<StageObjectLayer
						camera={camera}
						key={object.id}
						object={object}
						time={time}
					/>
				))}
			{project.meshes
				.filter((mesh) => time >= mesh.start && time < mesh.end)
				.map((mesh) => (
					<MeshLayer camera={camera} key={mesh.id} mesh={mesh} time={time} />
				))}
			{captions
				.filter((c) => time >= c.start && time < c.end)
				.map((c) => (
					<div
						className="studio-caption"
						key={c.id}
						style={{
							fontSize: `${(Math.round(project.height * 0.045) / project.width) * 100}cqw`,
							left: `${(40 / project.width) * 100}%`,
							right: `${(40 / project.width) * 100}%`,
						}}
					>
						{c.words?.length
							? c.words.map((word, index) => (
									<span
										key={word.id}
										style={{
											color:
												time >= word.start && time < word.end
													? (c.highlightColor ?? "#ffd43b")
													: "#ffffff",
										}}
									>
										{index ? " " : ""}
										{word.text}
									</span>
								))
							: c.text}
					</div>
				))}
		</div>
	);
}
