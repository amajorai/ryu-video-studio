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

test("apply-template adds a template's titles and graphics at a time", () => {
	const project = newProject("Templates");
	const placed = editTitles(project, [], {
		action: "apply-template",
		revision: project.revision,
		start: 4,
		templateId: "lower-third-accent",
		texts: ["Casey Park"],
	});
	expect(placed.titles.map((entry) => entry.text)).toEqual([
		"Casey Park",
		"FIELD REPORTER",
	]);
	expect(placed.graphics).toHaveLength(1);
	expect(placed.titles[0]?.start).toBeCloseTo(4.1);
	expect(() =>
		editTitles(project, [], { action: "apply-template", revision: 0 })
	).toThrow("templateId");
	expect(() =>
		editTitles(project, [], {
			action: "apply-template",
			revision: 0,
			templateId: "no-such-template",
		})
	).toThrow();
});

test("style fields round-trip through update patches", () => {
	const first = title("Styled");
	const project = { ...newProject("Styles"), titles: [first] };
	const updated = editTitles(project, [], {
		action: "update",
		patch: {
			animationIn: "typewriter",
			backgroundColor: "#101010",
			fontFamily: "oswald",
			outlineWidth: 0.004,
		},
		revision: project.revision,
		titleId: first.id,
	});
	expect(updated.titles[0]).toMatchObject({
		animationIn: "typewriter",
		backgroundColor: "#101010",
		fontFamily: "oswald",
	});
	expect(() =>
		editTitles(project, [], {
			action: "update",
			patch: { fontFamily: "comic" as "anton" },
			revision: project.revision,
			titleId: first.id,
		})
	).toThrow();
});

test("apply-template sets an imported or system font on every added title", () => {
	const project = newProject("Template fonts");
	const customFont = {
		family: "Ryufont",
		id: "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e",
	};
	const imported = editTitles(project, [], {
		action: "apply-template",
		customFont,
		revision: project.revision,
		systemFont: "DejaVu Sans",
		templateId: "lower-third-accent",
	});
	expect(imported.titles.map((entry) => entry.customFont)).toEqual([
		customFont,
		customFont,
	]);
	// The imported font wins; the template's own family stays the fallback.
	expect(imported.titles.every((entry) => entry.systemFont === undefined)).toBe(
		true
	);
	expect(imported.titles[0]?.fontFamily).toBeDefined();
	const system = editTitles(project, [], {
		action: "apply-template",
		revision: project.revision,
		systemFont: "DejaVu Sans",
		templateId: "lower-third-accent",
	});
	expect(system.titles.map((entry) => entry.systemFont)).toEqual([
		"DejaVu Sans",
		"DejaVu Sans",
	]);
	expect(() =>
		editTitles(project, [], {
			action: "apply-template",
			revision: project.revision,
			systemFont: "Bad, Name",
			templateId: "lower-third-accent",
		})
	).toThrow();
});
