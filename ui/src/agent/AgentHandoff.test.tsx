import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { AgentHandoff, describeHandoffScope } = await import(
	"./AgentHandoff.tsx"
);
const {
	agentHandoffAvailable,
	askAgentHandler,
	handoffScopeFor,
	onAgentHandoffRequest,
	requestAgentHandoff,
} = await import("../editor/actions/ai.ts");
const { markRangeStart } = await import("../editor/actions/navigation.ts");
const { runAction } = await import("../shortcuts/registry.ts");

afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

afterEach(() => {
	Reflect.deleteProperty(window, "ryu");
});

type Runtime = ReturnType<typeof createTestRuntime>;

function installChat(sent: { conversationId: string; text: string }[]) {
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			chat: {
				list: async () => [
					{ id: "chat-1", title: "Edit review", updated_at: 10 },
					{ id: "chat-2", title: "Older", updated_at: 1 },
				],
				send: async (input: { conversationId: string; text: string }) => {
					sent.push(input);
					return { conversation_id: input.conversationId, status: "accepted" };
				},
			},
		},
		writable: true,
	});
}

async function render(runtime: Runtime, node: ReactNode) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(<EditorProvider value={runtime}>{node}</EditorProvider>);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

const buttonNamed = (element: HTMLElement, name: string) =>
	[...element.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === name
	);

describe("ask agent action", () => {
	test("declines without a mounted handoff or an open project", () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		expect(askAgentHandler(runtime)).toBe(false);
		expect(requestAgentHandoff({ ...runtime, project: null })).toBe(false);
	});

	test("derives the scope from the selection and marked range", () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const [first] = project.segments;
		expect(
			handoffScopeFor({
				...runtime,
				range: { end: 3, start: 1 },
				rangeMarked: true,
				selectedIds: [first?.id ?? ""],
			})
		).toEqual({ clipIds: [first?.id ?? ""], range: { end: 3, start: 1 } });
		expect(describeHandoffScope({ clipIds: ["a"], range: null })).toBe(
			"1 clip in the whole timeline"
		);
	});

	test("the editor's default range defers to the selected clips", () => {
		const { asset, project, second } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		expect(runtime.range).toEqual({ end: 1, start: 0 });
		expect(handoffScopeFor({ ...runtime, selectedIds: [second.id] })).toEqual({
			clipIds: [second.id],
			range: { end: 15, start: 10 },
		});
		expect(handoffScopeFor({ ...runtime, selectedIds: [] })).toEqual({
			clipIds: [],
			range: null,
		});
		// Once the runtime reports the range as marked, it wins even at 0-1s.
		expect(
			handoffScopeFor({
				...runtime,
				rangeMarked: true,
				selectedIds: [second.id],
			})
		).toEqual({ clipIds: [second.id], range: { end: 1, start: 0 } });
	});

	test("marking in/out sets rangeMarked and the ask-agent action uses it", () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.time = 2;
		markRangeStart(runtime);
		expect(runtime.rangeMarked).toBe(true);
		expect(handoffScopeFor(runtime).range).toEqual({ end: 3, start: 2 });
		expect(agentHandoffAvailable()).toBe(false);
		expect(runAction("ai.askAgent", runtime)).toBe(false);
		const scopes: unknown[] = [];
		const stop = onAgentHandoffRequest((scope) => scopes.push(scope));
		try {
			expect(agentHandoffAvailable()).toBe(true);
			expect(runAction("ai.askAgent", runtime)).toBe(true);
			expect(scopes).toEqual([{ clipIds: [], range: { end: 3, start: 2 } }]);
		} finally {
			stop();
		}
	});
});

describe("AgentHandoff", () => {
	test("explains the missing grant instead of offering to send", async () => {
		const { asset, project } = testProject();
		const view = await render(
			createTestRuntime(project, [asset]),
			<AgentHandoff />
		);
		expect(view.element.textContent).toContain("chat.sendFollowUp");
		expect(buttonNamed(view.element, "Ask agent")).toBeUndefined();
		await view.unmount();
	});

	test("explains the grant when the host refuses chat.list", async () => {
		const denied = Object.assign(
			new Error(
				"Capability not granted: chat.sendFollowUp (required by chat.list)"
			),
			{ code: "denied" }
		);
		let granted = false;
		Object.defineProperty(window, "ryu", {
			configurable: true,
			value: {
				chat: {
					list: () =>
						granted
							? Promise.resolve([{ id: "chat-1", title: "A", updated_at: 1 }])
							: Promise.reject(denied),
					send: () => Promise.reject(denied),
				},
			},
			writable: true,
		});
		const { asset, project } = testProject();
		const view = await render(
			createTestRuntime(project, [asset]),
			<AgentHandoff />
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(view.element.textContent).toContain("chat.sendFollowUp");
		expect(view.element.textContent).not.toContain("Capability not granted");
		expect(buttonNamed(view.element, "Ask agent")).toBeUndefined();

		granted = true;
		await act(async () => {
			buttonNamed(view.element, "Check again")?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(buttonNamed(view.element, "Ask agent")).toBeDefined();
		await view.unmount();
	});

	test("sends the composed message to the chosen chat", async () => {
		const sent: { conversationId: string; text: string }[] = [];
		installChat(sent);
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const view = await render(runtime, <AgentHandoff />);
		await act(async () => {
			await Promise.resolve();
		});
		const select = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Chat to send to"]'
		);
		expect(select?.value).toBe("chat-1");
		expect(view.element.textContent).toContain("About the whole timeline");

		const [first] = project.segments;
		await act(async () => {
			expect(
				requestAgentHandoff({
					...runtime,
					range: { end: 0, start: 0 },
					selectedIds: [first?.id ?? ""],
				})
			).toBe(true);
		});
		expect(view.element.textContent).toContain("1 clip in 0.00s-10.00s");

		await act(async () => {
			buttonNamed(view.element, "Ask agent")?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.conversationId).toBe("chat-1");
		expect(sent[0]?.text).toContain(project.id);
		expect(sent[0]?.text).toContain(first?.id ?? "-");
		expect(view.element.textContent).toContain('Sent to "Edit review".');
		await view.unmount();
		expect(requestAgentHandoff(runtime)).toBe(false);
	});
});
