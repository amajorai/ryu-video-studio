import { expect, test } from "bun:test";
import { newProject } from "./project.ts";
import { editTitles } from "./title-edits.ts";

const title = (text: string) => ({
	animation: "fade" as const,
	color: "#ffffff",
	end: 2,
	fadeIn: 0.2,
	fadeOut: 0.2,
	fontSize: 0.08,
	id: crypto.randomUUID(),
	start: 0,
	text,
	x: 0.5,
	y: 0.5,
});

test("title edits append, update, replace, and remove without a full project PUT", () => {
	const first = title("Opening");
	const project = { ...newProject("Titles"), titles: [first] };
	const appended = editTitles(project, [], {
		action: "append",
		revision: project.revision,
		titles: [title("Lower third")],
	});
	expect(appended.titles).toHaveLength(2);
	const updated = editTitles(appended, [], {
		action: "update",
		patch: { text: "Updated opening", y: 0.8 },
		revision: appended.revision,
		titleId: first.id,
	});
	expect(updated.titles[0]).toMatchObject({ text: "Updated opening", y: 0.8 });
	const replaced = editTitles(updated, [], {
		action: "replace",
		revision: updated.revision,
		titles: [title("Only title")],
	});
	expect(replaced.titles[0]?.text).toBe("Only title");
	const removed = editTitles(replaced, [], {
		action: "remove",
		revision: replaced.revision,
		titleId: replaced.titles[0]!.id,
	});
	expect(removed.titles).toEqual([]);
});
