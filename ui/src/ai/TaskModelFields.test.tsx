import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { initialTaskChoice, LOCAL_ENGINE_NOTE, TaskModelFields } = await import(
	"./TaskModelFields.tsx"
);
const { LOCAL_ENGINE_CHOICE_ID, localEngineChoice } = await import(
	"./task-generation.ts"
);

type TaskModelChoice = import("./task-generation.ts").TaskModelChoice;
type GenerationTask =
	import("../../../shared/generation-models.ts").GenerationTask;

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
	document.body.replaceChildren();
});

async function render(
	task: GenerationTask,
	choice: TaskModelChoice,
	onChange: (next: TaskModelChoice) => void = () => undefined
) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<TaskModelFields choice={choice} onChange={onChange} task={task} />
		);
	});
	return host;
}

function presetSelect(host: HTMLElement): HTMLSelectElement {
	const select = host.querySelector<HTMLSelectElement>(
		'select[aria-label$="model preset"]'
	);
	if (!select) {
		throw new Error("missing preset select");
	}
	return select;
}

describe("TaskModelFields local engine option", () => {
	test("first/last-frame motion offers the local engine and picking it clears the cloud fields", async () => {
		const changes: TaskModelChoice[] = [];
		const host = await render("flf", initialTaskChoice("flf"), (next) =>
			changes.push(next)
		);
		const select = presetSelect(host);
		const values = [...select.options].map((option) => option.value);
		expect(values).toContain(LOCAL_ENGINE_CHOICE_ID);
		await act(async () => {
			select.value = LOCAL_ENGINE_CHOICE_ID;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(changes.at(-1)).toEqual(localEngineChoice());
	});

	test("the local choice hides provider fields and says what the node needs", async () => {
		const host = await render("flf", localEngineChoice());
		expect(presetSelect(host).value).toBe(LOCAL_ENGINE_CHOICE_ID);
		expect(host.querySelector('input[aria-label$="provider"]')).toBeNull();
		expect(host.textContent).toContain(LOCAL_ENGINE_NOTE);
	});

	test("tasks without a local model do not offer it", async () => {
		const host = await render("v2v", initialTaskChoice("v2v"));
		const values = [...presetSelect(host).options].map(
			(option) => option.value
		);
		expect(values).not.toContain(LOCAL_ENGINE_CHOICE_ID);
	});
});
