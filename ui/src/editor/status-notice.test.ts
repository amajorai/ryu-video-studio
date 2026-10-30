import { describe, expect, test } from "bun:test";
import { newProject } from "../../../shared/project.ts";
import {
	createStatusNotices,
	editStamp,
	STATUS_NOTICE_MS,
} from "./status-notice.ts";

/** A status line and a manual clock. */
function harness() {
	let text = "";
	const timers = new Map<number, { at: number; run: () => void }>();
	let now = 0;
	let nextId = 1;
	const notices = createStatusNotices(
		(update) => {
			text = typeof update === "function" ? update(text) : update;
		},
		{
			clearTimeout: (handle) => {
				timers.delete(handle as unknown as number);
			},
			setTimeout: (run, ms) => {
				const id = nextId++;
				timers.set(id, { at: now + ms, run });
				return id as unknown as ReturnType<typeof setTimeout>;
			},
		}
	);
	return {
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.run();
				}
			}
		},
		notices,
		text: () => text,
	};
}

describe("status notices", () => {
	const project = newProject("Notices");

	test("an edit-bound notice clears on the next timeline edit", () => {
		const view = harness();
		view.notices.set("Media imported.", editStamp(project), {
			clearOn: "edit",
		});
		expect(view.text()).toBe("Media imported.");
		// A save or rebase keeps the timeline arrays: not an edit.
		view.notices.projectChanged(editStamp({ ...project, revision: 9 }));
		expect(view.text()).toBe("Media imported.");
		view.notices.projectChanged(editStamp({ ...project, segments: [] }));
		expect(view.text()).toBe("");
	});

	test("an edit-bound notice also clears after 6 s", () => {
		const view = harness();
		view.notices.set("Media imported.", editStamp(project), {
			clearOn: "edit",
		});
		view.advance(STATUS_NOTICE_MS - 1);
		expect(view.text()).toBe("Media imported.");
		view.advance(1);
		expect(view.text()).toBe("");
	});

	test("a timed notice clears after its own time; plain messages stay", () => {
		const view = harness();
		view.notices.set("Copied.", editStamp(project), { clearOn: 500 });
		view.advance(500);
		expect(view.text()).toBe("");
		view.notices.set("Project saved.", editStamp(project));
		view.advance(STATUS_NOTICE_MS * 2);
		view.notices.projectChanged(editStamp({ ...project, segments: [] }));
		expect(view.text()).toBe("Project saved.");
	});

	test("a newer message replaces the notice and is never cleared by it", () => {
		const view = harness();
		view.notices.set("Media imported.", editStamp(project), {
			clearOn: "edit",
		});
		view.notices.set("Rendering…", editStamp(project));
		view.advance(STATUS_NOTICE_MS);
		view.notices.projectChanged(editStamp({ ...project, segments: [] }));
		expect(view.text()).toBe("Rendering…");
	});
});
