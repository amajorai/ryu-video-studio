import {
	type Asset,
	newSegment,
	type Project,
	type Scene,
	type Segment,
	type Title,
	validateProject,
} from "./project.ts";

export function fitSceneToAudio(
	scene: Scene,
	audio: Asset,
	assets: Asset[]
): Scene {
	if (audio.kind !== "audio" || !scene.assetIds.includes(audio.id)) {
		throw new Error("Select an audio layer first.");
	}
	const duration =
		audio.duration - (scene.audioOffsets?.[audio.id] ?? scene.sourceIn);
	if (duration < 0.04) {
		throw new Error("The selected audio range is empty.");
	}
	const visual = assets.find(
		(asset) => scene.assetIds.includes(asset.id) && asset.kind !== "audio"
	);
	if (
		visual?.kind === "video" &&
		visual.duration - scene.sourceIn + 0.05 < duration
	) {
		throw new Error(
			"Choose a longer visual take or a still image to fit this audio."
		);
	}
	return { ...scene, duration, approved: false, reviewStatus: "in-review" };
}

export function assembleStoryboard(
	project: Project,
	assets: Asset[],
	includeTitles: boolean
): Project {
	if (!project.scenes.length) {
		throw new Error("Add storyboard scenes before assembling the edit.");
	}
	const segments: Segment[] = [];
	const titles: Title[] = [];
	let cursor = 0;
	for (const scene of project.scenes) {
		if (project.requireApproval && !scene.approved) {
			throw new Error("Approve each scene before assembling this production.");
		}
		const selected = scene.assetIds.map((id) =>
			assets.find((asset) => asset.id === id)
		);
		if (selected.some((asset) => !asset) || !selected.length) {
			throw new Error(`Select available media for ${scene.title}.`);
		}
		const visual = selected.find((asset) => asset?.kind !== "audio");
		const audio = selected.filter((asset) => asset?.kind === "audio");
		if (selected.filter((asset) => asset?.kind !== "audio").length > 1) {
			throw new Error("Choose one visual take per storyboard scene.");
		}
		if (audio.length > (visual ? 15 : 16)) {
			throw new Error("This scene exceeds the available audio tracks.");
		}
		const main = visual ?? audio[0];
		if (!main) {
			throw new Error(`Select a take for ${scene.title}.`);
		}
		const mainIn =
			main.kind === "audio"
				? (scene.audioOffsets?.[main.id] ?? scene.sourceIn)
				: scene.sourceIn;
		const available =
			main.kind === "image" ? scene.duration : main.duration - mainIn;
		if (
			visual?.kind === "video" &&
			audio.length &&
			scene.duration > available + 0.05
		) {
			throw new Error(
				`The visual take for ${scene.title} is shorter than the requested scene. Choose a longer take or still image before assembling its audio.`
			);
		}
		const duration = Math.min(scene.duration, available);
		if (duration < 0.04) {
			throw new Error(`The selected range for ${scene.title} is empty.`);
		}
		const chosen = [...(visual ? [visual] : []), ...audio];
		for (const [index, asset] of chosen.entries()) {
			if (!asset) {
				continue;
			}
			const input =
				asset.kind === "image"
					? 0
					: asset.kind === "audio"
						? (scene.audioOffsets?.[asset.id] ?? scene.sourceIn)
						: scene.sourceIn;
			const length =
				asset.kind === "image"
					? duration
					: Math.min(duration, asset.duration - input);
			if (length < 0.04) {
				throw new Error(`The audio range for ${scene.title} is empty.`);
			}
			segments.push({
				...newSegment(asset, cursor, index),
				volume: asset.kind !== "audio" && scene.muteVisualAudio ? 0 : 1,
				sourceIn: input,
				sourceOut: input + length,
			});
		}
		if (includeTitles) {
			titles.push({
				id: crypto.randomUUID(),
				start: cursor,
				end: cursor + duration,
				text: scene.title,
				x: 0.5,
				y: 0.2,
				fontSize: 0.07,
				color: "#ffffff",
				fadeIn: Math.min(0.25, duration / 4),
				fadeOut: Math.min(0.25, duration / 4),
				animation: "fade",
			});
		}
		cursor += duration;
	}
	return validateProject(
		{
			...project,
			captionTrackId: null,
			captionTracks: [],
			captions: [],
			segments,
			titles,
		},
		assets
	);
}
