import { expect, mock, spyOn, test } from "bun:test";
import * as processes from "node:child_process";
import { PassThrough } from "node:stream";
import { runMedia } from "./media.ts";
import {
	acquireMediaOperation,
	withMediaOperation,
} from "./media-operation.ts";

test("a spawned process error retains admission until its actual close", async () => {
	const child = new processes.ChildProcess();
	Object.defineProperties(child, {
		pid: { value: 12_345 },
		stdout: { value: new PassThrough() },
		stderr: { value: new PassThrough() },
	});
	spyOn(processes, "spawn").mockReturnValue(child);
	const other = acquireMediaOperation(10_000);
	let settled = false;
	const operation = withMediaOperation(
		10_000,
		{},
		async () => await runMedia([])
	);
	const result = operation.catch((error) => {
		settled = true;
		return error;
	});
	try {
		child.emit("error", new Error("fixture runtime failure"));
		child.emit("error", new Error("fixture repeated failure"));
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(() => acquireMediaOperation(10_000)).toThrow("Two media operations");
		child.emit("close", 1);
		expect(await result).toMatchObject({
			message: "The media process failed before completing its operation.",
		});
		const recovered = acquireMediaOperation(10_000);
		recovered.release();
	} finally {
		child.emit("close", 1);
		await result;
		other.release();
		mock.restore();
	}
});
