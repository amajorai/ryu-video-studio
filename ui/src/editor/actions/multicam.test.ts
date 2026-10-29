import { expect, test } from "bun:test";
import { createMulticamGroup } from "../../../../shared/multicam.ts";
import { newProject } from "../../../../shared/project.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import {
	multicamActions,
	shortcutDigit,
	switchMulticamAt,
} from "./multicam.ts";
import type { ShortcutEventLike } from "./types.ts";

function session() {
	const wide = testVideo("Wide", 6);
	const close = { ...testVideo("Close", 6), name: "Close" };
	const host = {
		...testVideo("Host", 6),
		kind: "audio" as const,
		name: "Host",
	};
	const guest = {
		...testVideo("Guest", 6),
		kind: "audio" as const,
		name: "Guest",
	};
	const assets = [wide, close, host, guest];
	const project = newProject("Shortcut multicam");
	const created = createMulticamGroup(project, assets, {
		action: "create",
		masterAssetId: host.id,
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: host.id, kind: "mic", label: "Host" },
			{ assetId: guest.id, kind: "mic", label: "Guest" },
		],
		revision: project.revision,
	});
	return { assets, created };
}

function key(code: string, alt = false): ShortcutEventLike {
	return {
		altKey: alt,
		code,
		ctrlKey: false,
		key: alt ? "¡" : code.replace("Digit", ""),
		metaKey: false,
		preventDefault: () => undefined,
		shiftKey: false,
		target: null,
	};
}

test("shortcut digits read the physical key so Alt+digit works on every layout", () => {
	expect(shortcutDigit(key("Digit3"))).toBe(3);
	expect(shortcutDigit(key("Digit2", true))).toBe(2);
	expect(shortcutDigit(key("Numpad9"))).toBe(9);
	expect(shortcutDigit(key("Digit0"))).toBeNull();
	expect(shortcutDigit(undefined)).toBeNull();
});

test("1-9 cuts to an angle and Alt+1-9 switches the mic from the playhead", () => {
	const { assets, created } = session();
	const runtime = createTestRuntime(created.project, assets);
	const routed: unknown[] = [];
	runtime.routeEdit = (action, body, describe) => {
		routed.push([action, body, describe({})]);
		return Promise.resolve({ extras: {}, status: "ok" as const });
	};
	runtime.time = 2;
	expect(
		multicamActions["multicam.switchAngle"]?.(runtime, key("Digit2"))
	).toBe(true);
	expect(
		multicamActions["multicam.switchMic"]?.(runtime, key("Digit2", true))
	).toBe(true);
	expect(routed).toEqual([
		[
			"multicam",
			{
				action: "change",
				entries: [{ angle: "Close", end: 6, start: 2 }],
				groupId: created.group.id,
			},
			"Cut to Close at 2.00s.",
		],
		[
			"multicam",
			{
				action: "change",
				entries: [{ audio: "Guest", end: 6, start: 2 }],
				groupId: created.group.id,
			},
			"Program audio from Guest at 2.00s.",
		],
	]);
});

test("multicam keys decline outside a session or past the member list", () => {
	const { assets, created } = session();
	const runtime = createTestRuntime(created.project, assets);
	runtime.time = 7;
	expect(switchMulticamAt(runtime, "angle", 1)).toBe(false);
	runtime.time = 1;
	expect(switchMulticamAt(runtime, "angle", 3)).toBe(false);
	expect(switchMulticamAt(runtime, "angle", 1)).toBe(true);
	expect(lastStatus(runtime)).toContain("Wide is already the program angle");
	expect(runtime.calls.some(([name]) => name === "routeEdit")).toBe(false);
});
