import { expect, test } from "bun:test";
import { interchangeFilename, interchangeText } from "./interchange.ts";
import { newProject, newSegment } from "./project.ts";

function asset(
	kind: "audio" | "image" | "video",
	name: string,
	id = crypto.randomUUID()
) {
	return {
		createdAt: new Date().toISOString(),
		duration: 4,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id,
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

test("FCPXML includes referenced sources, lanes, and escaped project names", () => {
	const video = asset("video", "Hero & take");
	const audio = asset("audio", "Voice <clean>");
	const unused = asset("image", "Unused");
	const project = newProject("Launch <cut>");
	project.segments = [newSegment(video, 0, 0), newSegment(audio, 0, 1)];
	project.segments[0]!.sourceOut = 2;
	project.segments[1]!.sourceOut = 2;
	const text = interchangeText(project, [video, audio, unused], "fcpxml");
	expect(text).toContain("Launch &lt;cut&gt;");
	expect(text).toContain("Hero &amp; take");
	expect(text).toContain("Voice &lt;clean&gt;");
	expect(text).toContain('lane="1"');
	expect(text).not.toContain("Unused");
	expect(text).toContain('frameDuration="1/30s"');
});

test("XMEML separates visual and audio tracks and preserves source frames", () => {
	const video = asset("video", "Picture");
	const audio = asset("audio", "Dialogue");
	const project = newProject("Premiere export");
	const picture = newSegment(video, 1, 0);
	picture.sourceOut = 3;
	const dialogue = newSegment(audio, 1, 1);
	dialogue.sourceOut = 3;
	project.segments = [picture, dialogue];
	const text = interchangeText(project, [video, audio], "xmeml");
	const videoSection = text.match(/<video>([\s\S]*?)<\/video>/)?.[1] ?? "";
	const audioSection = text.match(/<audio>([\s\S]*?)<\/audio>/)?.[1] ?? "";
	expect(videoSection).toContain("Picture");
	expect(videoSection).not.toContain("Dialogue");
	expect(audioSection).toContain("Dialogue");
	expect(audioSection).not.toContain("Picture");
	expect(text).toContain("<start>30</start>");
	expect(text).toContain("<in>0</in>");
	expect(text).toContain("<out>90</out>");
});

test("interchange filenames stay bounded and safe for downloads", () => {
	const project = newProject("  A launch: final / take?  ");
	expect(interchangeFilename(project, "fcpxml")).toBe(
		"A-launch-final-take.fcpxml"
	);
	expect(interchangeFilename({ title: "" }, "xmeml")).toBe(
		"video-studio-project.xml"
	);
});
