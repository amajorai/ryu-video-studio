import { RyuAppActions, RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	MAX_SFX_SECONDS,
	MAX_SFX_SEED,
	MIN_SFX_SECONDS,
	SFX_DEFAULT_DURATIONS,
	SFX_LABELS,
	type SfxKind,
	sfxKindSchema,
} from "../../shared/sfx.ts";
import { TaskModelFields } from "./ai/TaskModelFields.tsx";
import type { TaskModelChoice } from "./ai/task-generation.ts";

/** The sound effect source, model, kind, and synthesis controls. */
export function SoundtrackSfxSection({
	busy,
	generateSfx,
	generateWithModel,
	generatedReason,
	setSfxChoice,
	setSfxDescription,
	setSfxDuration,
	setSfxKind,
	setSfxSeed,
	setSfxSource,
	sfxChoice,
	sfxDescription,
	sfxDuration,
	sfxKind,
	sfxSeed,
	sfxSource,
	working,
}: {
	busy: boolean;
	generateSfx: () => Promise<void>;
	generateWithModel: (task: "music" | "sfx") => Promise<void>;
	generatedReason: (task: "music" | "sfx") => string | undefined;
	setSfxChoice: (choice: TaskModelChoice) => void;
	setSfxDescription: (description: string) => void;
	setSfxDuration: (duration: number | undefined) => void;
	setSfxKind: (kind: SfxKind) => void;
	setSfxSeed: (seed: number) => void;
	setSfxSource: (source: "procedural" | "generate") => void;
	sfxChoice: TaskModelChoice;
	sfxDescription: string;
	sfxDuration: number | undefined;
	sfxKind: SfxKind;
	sfxSeed: number;
	sfxSource: "procedural" | "generate";
	working: boolean;
}) {
	return (
		<>
			<RyuAppField label="Sound effect source">
				<NativeSelect
					aria-label="Sound effect source"
					disabled={busy}
					onChange={(event) =>
						setSfxSource(
							event.target.value === "generate" ? "generate" : "procedural"
						)
					}
					value={sfxSource}
				>
					<NativeSelectOption value="procedural">
						Local synthesizer
					</NativeSelectOption>
					<NativeSelectOption value="generate">
						Generate (cloud model)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			{sfxSource === "generate" && (
				<>
					<RyuAppField label="Describe the sound">
						<Textarea
							aria-label="Describe the sound effect"
							disabled={busy}
							maxLength={2000}
							onChange={(event) => setSfxDescription(event.target.value)}
							placeholder="For example: a heavy wooden door slamming shut"
							rows={2}
							value={sfxDescription}
						/>
					</RyuAppField>
					<TaskModelFields
						choice={sfxChoice}
						disabled={busy}
						onChange={setSfxChoice}
						task="sfx"
					/>
					{generatedReason("sfx") && (
						<p className="text-xs">{generatedReason("sfx")}</p>
					)}
				</>
			)}
			<RyuAppField label="Sound effect">
				<NativeSelect
					aria-label="Sound effect kind"
					disabled={busy}
					onChange={(event) => {
						setSfxKind(sfxKindSchema.parse(event.target.value));
						setSfxDuration(undefined);
					}}
					value={sfxKind}
				>
					{sfxKindSchema.options.map((kind) => (
						<NativeSelectOption key={kind} value={kind}>
							{SFX_LABELS[kind]}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<div className="studio-inline-fields">
				<Input
					aria-label="Sound effect duration"
					disabled={busy}
					max={MAX_SFX_SECONDS}
					min={MIN_SFX_SECONDS}
					onChange={(event) =>
						setSfxDuration(
							event.target.value === "" ? undefined : Number(event.target.value)
						)
					}
					placeholder={`${SFX_DEFAULT_DURATIONS[sfxKind]} s`}
					step={0.01}
					type="number"
					value={sfxDuration ?? ""}
				/>
				<Input
					aria-label="Sound effect seed"
					disabled={busy}
					max={MAX_SFX_SEED}
					min={0}
					onChange={(event) =>
						setSfxSeed(Math.max(0, Math.trunc(Number(event.target.value))))
					}
					step={1}
					type="number"
					value={sfxSeed}
				/>
				<Button
					disabled={busy}
					onClick={() => setSfxSeed(Math.floor(Math.random() * 10_000))}
					variant="ghost"
				>
					Vary
				</Button>
			</div>
			<RyuAppActions>
				{sfxSource === "generate" ? (
					<Button
						disabled={busy || Boolean(generatedReason("sfx"))}
						onClick={() => void generateWithModel("sfx")}
						variant="outline"
					>
						{working ? "Generating…" : "Generate sound effect"}
					</Button>
				) : (
					<Button
						disabled={busy}
						onClick={() => void generateSfx()}
						variant="outline"
					>
						{working ? "Generating…" : "Create sound effect"}
					</Button>
				)}
			</RyuAppActions>
		</>
	);
}
