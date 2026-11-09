import { z } from "zod";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("Core exposes the Gateway budget snapshot", async () => {
	const host = await createCoreSpeechHost({ mediaOnly: true });
	try {
		await host.enableBudget();
		const counters = z.record(z.string(), z.number());
		const snapshot = z
			.object({
				reachable: z.boolean(),
				users: counters,
				agents: counters,
				sessions: counters,
				limits: z.object({
					users: counters.optional(),
					agents: counters.optional(),
					session: z.number().optional(),
				}),
			})
			.parse(await host.budget());
		const audit = z
			.object({ reachable: z.boolean(), entries: z.array(z.json()) })
			.parse(await host.audit());
		process.stdout.write(
			`PASS: Core returned Gateway budget and audit snapshots (budget=${String(snapshot.reachable)}, audit=${String(audit.reachable)}, entries=${audit.entries.length}).\n`
		);
	} finally {
		host.stop();
	}
});
