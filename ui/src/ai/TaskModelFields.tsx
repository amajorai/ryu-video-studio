import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Input, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useState } from "react";
import {
	type GenerationTask,
	isLocalEngineProvider,
	LOCAL_ENGINE_TASKS,
	parseProviderInput,
	presetFor,
	presetsForTask,
	TASK_LABELS,
} from "../../../shared/generation-models.ts";
import {
	LOCAL_ENGINE_CHOICE_ID,
	localEngineChoice,
	presetChoice,
	type TaskModelChoice,
} from "./task-generation.ts";

/** What the local-engine option needs on the node, shown when it is picked. */
export const LOCAL_ENGINE_NOTE =
	"Runs on this node's stable-diffusion.cpp engine with both frames. Install a Wan2.1 FLF2V 14B or Wan2.2 I2V A14B (low- and high-noise pair) GGUF from the model catalog and select it as the local diffusion model; its encoders download on first use. Without one, Core refuses the request and says why. A local clip is about 2 s (33 frames at 16 fps), so it fills gaps up to 20.6 s, and Core cancels a run that takes over an hour.";

/** The initial choice for `task`: its first preset. */
export function initialTaskChoice(task: GenerationTask): TaskModelChoice {
	const preset = presetFor(task);
	return preset
		? presetChoice(preset)
		: { model: "", provider: "", providerInput: {} };
}

/**
 * Model picker for a reference-input task: a preset, the provider and model
 * ids it fills in, and the editable field map sent as `provider_input`.
 * Presets come from provider documentation and are labelled unverified.
 */
export function TaskModelFields({
	choice,
	disabled,
	onChange,
	task,
}: {
	choice: TaskModelChoice;
	disabled?: boolean;
	onChange: (choice: TaskModelChoice) => void;
	task: GenerationTask;
}) {
	const tl = useLiteralMessages();
	const presets = presetsForTask(task);
	const localAvailable = LOCAL_ENGINE_TASKS.has(task);
	const local = localAvailable && isLocalEngineProvider(choice.provider);
	const [fieldsText, setFieldsText] = useState(() =>
		JSON.stringify(choice.providerInput, null, 2)
	);
	const [fieldsError, setFieldsError] = useState("");
	const label = TASK_LABELS[task];
	const pick = (id: string) => {
		if (localAvailable && id === LOCAL_ENGINE_CHOICE_ID) {
			setFieldsError("");
			onChange(localEngineChoice());
			return;
		}
		const preset = presets.find((row) => row.id === id);
		const next = preset
			? presetChoice(preset)
			: {
					...choice,
					presetId: undefined,
					provider: local ? "" : choice.provider,
				};
		setFieldsText(JSON.stringify(next.providerInput, null, 2));
		setFieldsError("");
		onChange(next);
	};
	const note = presets.find((row) => row.id === choice.presetId)?.note;
	return (
		<>
			<RyuAppField
				description={
					local
						? LOCAL_ENGINE_NOTE
						: note
							? tl(
									"{note} Preset from the provider's documentation, not verified by Ryu. Check the model page and edit the fields if it changed.",
									{ note }
								)
							: tl(
									"Preset from the provider's documentation, not verified by Ryu. Check the model page and edit the fields if it changed."
								)
				}
				label={tl("{task} model", { task: label })}
			>
				<NativeSelect
					aria-label={tl("{task} model preset", { task: label })}
					disabled={disabled}
					onChange={(event) => pick(event.target.value)}
					value={local ? LOCAL_ENGINE_CHOICE_ID : (choice.presetId ?? "")}
				>
					{presets.map((row) => (
						<NativeSelectOption key={row.id} value={row.id}>
							{tl("{presetLabel} · {provider} (preset)", {
								presetLabel: row.label,
								provider: row.provider,
							})}
						</NativeSelectOption>
					))}
					{localAvailable && (
						<NativeSelectOption value={LOCAL_ENGINE_CHOICE_ID}>
							Local engine · installed Wan first/last-frame model
						</NativeSelectOption>
					)}
					<NativeSelectOption value="">Custom model</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{!local && (
				<CloudModelFields
					choice={choice}
					disabled={disabled}
					fieldsError={fieldsError}
					fieldsText={fieldsText}
					label={label}
					onChange={onChange}
					setFieldsError={setFieldsError}
					setFieldsText={setFieldsText}
				/>
			)}
		</>
	);
}

/** Provider, model id and field map for a cloud model choice. */
function CloudModelFields({
	choice,
	disabled,
	fieldsError,
	fieldsText,
	label,
	onChange,
	setFieldsError,
	setFieldsText,
}: {
	choice: TaskModelChoice;
	disabled?: boolean;
	fieldsError: string;
	fieldsText: string;
	label: string;
	onChange: (choice: TaskModelChoice) => void;
	setFieldsError: (error: string) => void;
	setFieldsText: (text: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<RyuAppField label="Provider and model">
				<div className="flex flex-wrap gap-2">
					<Input
						aria-label={tl("{task} provider", { task: label })}
						className="w-28"
						disabled={disabled}
						maxLength={64}
						onChange={(event) =>
							onChange({
								...choice,
								presetId: undefined,
								provider: event.target.value,
							})
						}
						placeholder="fal"
						value={choice.provider}
					/>
					<Input
						aria-label={tl("{task} model id", { task: label })}
						className="min-w-48 flex-1"
						disabled={disabled}
						maxLength={256}
						onChange={(event) =>
							onChange({
								...choice,
								model: event.target.value,
								presetId: undefined,
							})
						}
						placeholder="provider/model"
						value={choice.model}
					/>
				</div>
			</RyuAppField>
			<details>
				<summary className="cursor-pointer text-muted-foreground text-xs">
					Model fields
				</summary>
				<RyuAppField
					description="JSON merged into the provider request. Reference inputs as $input_video, $input_audio, $input_images.0, $input_images.1 or $duration_s."
					label="Model fields"
				>
					<Textarea
						aria-label={tl("{task} model fields", { task: label })}
						className="font-mono text-xs"
						disabled={disabled}
						onChange={(event) => {
							setFieldsText(event.target.value);
							try {
								const providerInput = parseProviderInput(event.target.value);
								setFieldsError("");
								onChange({ ...choice, presetId: undefined, providerInput });
							} catch (error) {
								setFieldsError(
									error instanceof Error ? error.message : "Invalid fields."
								);
							}
						}}
						rows={4}
						value={fieldsText}
					/>
				</RyuAppField>
				{fieldsError && (
					<p className="text-destructive text-xs" role="alert">
						{fieldsError}
					</p>
				)}
			</details>
		</>
	);
}
