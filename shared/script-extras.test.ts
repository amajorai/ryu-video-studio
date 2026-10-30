import { describe, expect, test } from "bun:test";
import { type Asset, newProject, newSegment } from "./project.ts";
import {
	DEFAULT_SCRIPT_MUSIC_VOLUME,
	musicMoodFromDescription,
	placeScriptAvatars,
	placeScriptMusic,
	SCRIPT_AVATAR_PRESETS,
	SCRIPT_MUSIC_INTENSITY,
	scriptMusicMood,
	scriptMusicRequest,
	scriptMusicSections,
} from "./script-extras.ts";
import { assembleScriptVideo } from "./script-to-video.ts";
import {
	MAX_SOUNDTRACK_SECTIONS,
	soundtrackRequestSchema,
} from "./soundtrack.ts";

function asset(kind: Asset["kind"], duration: number): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}.bin`,
		width: kind === "audio" ? 0 : 1280,
	};
}

const counter = () => {
	let next = 0;
	return () => {
		next += 1;
		return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
	};
};

describe("music mood", () => {
	test("picks the style named first in a description", () => {
		expect(musicMoodFromDescription("Dark, then epic")).toBe("suspense");
		expect(musicMoodFromDescription("an epic, dark trailer")).toBe("cinematic");
		expect(musicMoodFromDescription("chill lo-fi beats")).toBe("lo-fi");
		expect(musicMoodFromDescription("something for a tech explainer")).toBe(
			"corporate"
		);
		expect(musicMoodFromDescription("anything goes")).toBeUndefined();
		expect(musicMoodFromDescription(undefined)).toBeUndefined();
	});

	test("matches whole words only", () => {
		// "darkness" is not "dark"; "fast" is not inside "breakfast".
		expect(musicMoodFromDescription("breakfast darkness")).toBeUndefined();
	});

	test("an explicit mood wins, and warm is the fallback", () => {
		expect(scriptMusicMood({ description: "epic", mood: "bright" })).toBe(
			"bright"
		);
		expect(scriptMusicMood({ description: "epic" })).toBe("cinematic");
		expect(scriptMusicMood({})).toBe("warm");
	});
});

describe("music sections", () => {
	test("start at each scene and build towards the end", () => {
		const sections = scriptMusicSections(
			[
				{ end: 12, start: 10 },
				{ end: 15.5, start: 12.5 },
				{ end: 18, start: 16 },
			],
			8
		);
		expect(sections).toEqual([
			{ end: 2.5, intensity: SCRIPT_MUSIC_INTENSITY.start, start: 0 },
			{ end: 6, intensity: 0.55, start: 2.5 },
			{ end: 8, intensity: SCRIPT_MUSIC_INTENSITY.end, start: 6 },
		]);
	});

	test("merge scenes shorter than half a second and cap the count", () => {
		expect(
			scriptMusicSections(
				[
					{ end: 0.2, start: 0 },
					{ end: 3, start: 0.2 },
				],
				3
			)
		).toEqual([{ end: 3, intensity: 0.55, start: 0 }]);
		const many = Array.from({ length: 40 }, (_, index) => ({
			end: index + 1,
			start: index,
		}));
		const capped = scriptMusicSections(many, 40);
		expect(capped).toHaveLength(MAX_SOUNDTRACK_SECTIONS);
		expect(capped.at(-1)?.end).toBe(40);
	});

	test("the request is a valid soundtrack body over the assembly", () => {
		const body = scriptMusicRequest(
			{
				duration: 6.25,
				scenes: [
					{ end: 3, start: 0 },
					{ end: 6.25, start: 3.25 },
				],
			},
			{ mood: "upbeat" }
		);
		expect(body).toMatchObject({ bpm: 124, duration: 6.25, mood: "upbeat" });
		expect(body.sections?.map((section) => section.start)).toEqual([0, 3.25]);
		expect(soundtrackRequestSchema.safeParse(body).success).toBe(true);
		expect(() => scriptMusicRequest({ duration: 0.2, scenes: [] }, {})).toThrow(
			"too short"
		);
	});
});

describe("music placement", () => {
	test("puts a faded, ducked bed on the first free audio track", () => {
		const voice = asset("audio", 4);
		const music = asset("audio", 10);
		const project = {
			...newProject("Bed"),
			segments: [{ ...newSegment(voice, 2, 1), id: crypto.randomUUID() }],
		};
		const placed = placeScriptMusic(project, [voice], music, {
			duration: 6,
			start: 2,
		});
		expect(placed.track).toBe(2);
		const bed = placed.project.segments.find(
			(segment) => segment.id === placed.clipId
		);
		expect(bed).toMatchObject({
			duckUnderVoice: true,
			fadeIn: 1,
			fadeOut: 1,
			sourceIn: 0,
			sourceOut: 6,
			start: 2,
			volume: DEFAULT_SCRIPT_MUSIC_VOLUME,
		});
		const loud = placeScriptMusic(project, [voice], music, {
			duck: false,
			duration: 2,
			start: 2,
			volume: 0.8,
		});
		expect(
			loud.project.segments.find((segment) => segment.id === loud.clipId)
		).toMatchObject({ duckUnderVoice: false, fadeOut: 0.5, volume: 0.8 });
	});

	test("refuses a non-audio bed", () => {
		const project = newProject("Bed");
		expect(() =>
			placeScriptMusic(project, [], asset("video", 4), {
				duration: 2,
				start: 0,
			})
		).toThrow("audio asset");
	});
});

describe("presenter avatars", () => {
	test("one preset avatar spans each scene", () => {
		const project = newProject("Presenter");
		const placed = placeScriptAvatars(
			project,
			[
				{ end: 2, narrationClipId: "a", start: 0 },
				{ end: 2.3, narrationClipId: "b", start: 2.1 },
			],
			"presenter-left",
			counter()
		);
		expect(placed.avatars.map((item) => item.narrationClipId)).toEqual([
			"a",
			"b",
		]);
		const [first, second] = placed.project.avatars;
		const look = SCRIPT_AVATAR_PRESETS["presenter-left"];
		expect(first).toEqual({
			...look,
			end: 2,
			id: placed.avatars[0]?.avatarId ?? "",
			start: 0,
		});
		// A short scene shortens the entry so it fits.
		expect(second?.entryDuration).toBe(0.1);
	});

	test("refuses to exceed the project avatar limit", () => {
		const project = newProject("Full");
		const scenes = Array.from({ length: 101 }, (_, index) => ({
			end: index + 1,
			narrationClipId: String(index),
			start: index,
		}));
		expect(() => placeScriptAvatars(project, scenes, "corner")).toThrow(
			"100 avatars"
		);
	});

	test("assembly places presenters on the validated project", () => {
		const voice = asset("audio", 2);
		const still = asset("image", 0);
		const project = newProject("Assembly");
		const result = assembleScriptVideo(
			project,
			[voice, still],
			{
				avatar: { preset: "presenter-right" },
				captions: false,
				revision: project.revision,
				scenes: [
					{ narrationAssetId: voice.id, text: "One.", visualAssetId: still.id },
					{ narrationAssetId: voice.id, text: "Two.", visualAssetId: still.id },
				],
			},
			{ newId: counter() }
		);
		expect(result.avatars).toHaveLength(2);
		expect(result.avatars.map((item) => item.narrationClipId)).toEqual(
			result.scenes.map((scene) => scene.narrationClipId)
		);
		expect(
			result.project.avatars.map((avatar) => [avatar.start, avatar.end])
		).toEqual([
			[0, 2],
			[2, 4],
		]);
	});
});
