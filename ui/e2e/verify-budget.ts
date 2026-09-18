import assert from "node:assert/strict";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("Core exposes the Gateway budget snapshot", async () => {
	const host = await createCoreSpeechHost({ mediaOnly: true });
	try {
		await host.enableBudget();
		const snapshot = (await host.budget()) as {
			reachable?: unknown;
			users?: unknown;
			agents?: unknown;
			sessions?: unknown;
			limits?: unknown;
		};
		assert.equal(typeof snapshot.reachable, "boolean");
		assert.ok(snapshot.users && typeof snapshot.users === "object");
		assert.ok(snapshot.agents && typeof snapshot.agents === "object");
		assert.ok(snapshot.sessions && typeof snapshot.sessions === "object");
		assert.ok(snapshot.limits && typeof snapshot.limits === "object");
		const audit = (await host.audit()) as {
			entries?: unknown;
			reachable?: unknown;
		};
		assert.equal(typeof audit.reachable, "boolean");
		assert.ok(Array.isArray(audit.entries));
		process.stdout.write(
			`PASS: Core returned Gateway budget and audit snapshots (budget=${String(snapshot.reachable)}, audit=${String(audit.reachable)}, entries=${audit.entries.length}).\n`
		);
	} finally {
		host.stop();
	}
});
