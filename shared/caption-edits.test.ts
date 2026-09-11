import { expect, test } from "bun:test";
import { editCaptions } from "./caption-edits.ts";
import { newProject } from "./project.ts";

const cue = (text: string, start = 0) => ({
	end: start + 1,
	id: crypto.randomUUID(),
	start,
	text,
});

test("caption edits append, replace, and remove on a selected track", () => {
	const source = cue("Source");
	const translated = cue("Bonjour");
	const track = {
		captions: [translated],
		id: crypto.randomUUID(),
		label: "Français",
		language: "fr",
	};
	const project = {
		...newProject("Caption edits"),
		captionTracks: [track],
		captionTrackId: track.id,
		captions: [source],
	};
	const appended = editCaptions(project, [], {
		action: "append",
		captions: [cue("Encore", 1)],
		revision: project.revision,
		trackId: track.id,
	});
	expect(appended.captionTracks[0]?.captions).toHaveLength(2);
	const removed = editCaptions(appended, [], {
		action: "remove",
		captionIds: [translated.id],
		revision: appended.revision,
		trackId: track.id,
	});
	expect(removed.captionTracks[0]?.captions.map((item) => item.text)).toEqual([
		"Encore",
	]);
	const replaced = editCaptions(removed, [], {
		action: "replace",
		captions: [cue("Replaced")],
		revision: removed.revision,
		trackId: null,
	});
	expect(replaced.captions[0]?.text).toBe("Replaced");
});
