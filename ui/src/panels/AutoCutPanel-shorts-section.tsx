import { RyuAppActions, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import type { Project } from "../../../shared/project.ts";
import { openProject } from "../editor/project-actions.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { NumberField } from "../NumberField.tsx";
import { AspectSelect, CheckField } from "./AutoCutPanel-fields.tsx";
import {
	errorText,
	remember,
	type ShortsForm,
	type ShortsResponse,
	shortsBody,
	shortsResponseSchema,
} from "./AutoCutPanel-model.ts";

export function ShortsSection({
	project,
	runtime,
}: {
	project: Project;
	runtime: EditorRuntime;
}) {
	const tl = useLiteralMessages();
	const [form, setForm] = useState<ShortsForm>({
		aspect: "9:16",
		captions: true,
		count: 3,
		exportShorts: false,
		maxSeconds: 60,
		minSeconds: 15,
	});
	const [working, setWorking] = useState(false);
	const [shorts, setShorts] = useState<ShortsResponse["shorts"] | null>(null);
	const change = (patch: Partial<ShortsForm>) =>
		setForm((current) => ({ ...current, ...patch }));
	const disabled = runtime.busy || working;

	const make = async () => {
		setWorking(true);
		try {
			const saved = await runtime.ensureSaved();
			if (!saved) {
				return;
			}
			const result = shortsResponseSchema.parse(
				await runtime.api(
					`/projects/${saved.id}/shorts`,
					shortsBody(form, saved.revision) as Record<string, unknown>
				)
			);
			for (const short of result.shorts) {
				remember(runtime, short.project);
			}
			setShorts(result.shorts);
			const failed = result.shorts.filter((short) => short.exportError).length;
			runtime.setStatus(
				form.exportShorts
					? tl(
							"Created {count, plural, one {# short} other {# shorts}} from {title}; {queued, plural, one {# export} other {# exports}} queued.",
							{
								count: result.shorts.length,
								queued: result.shorts.length - failed,
								title: project.title,
							}
						)
					: tl(
							"Created {count, plural, one {# short} other {# shorts}} from {title}.",
							{ count: result.shorts.length, title: project.title }
						)
			);
		} catch (error) {
			runtime.setStatus(errorText(error, "Making shorts failed."));
		} finally {
			setWorking(false);
		}
	};

	return (
		<RyuAppSection title="Vertical shorts">
			<p>
				Turn this project's best highlights into separate short projects:
				reframed for the new aspect, captioned one word at a time, with a
				matching publish preset.
			</p>
			<NumberField
				label="Shorts to make"
				max={10}
				min={1}
				onChange={(count) => change({ count: Math.round(count) })}
				step={1}
				value={form.count}
			/>
			<NumberField
				label="Shortest short (seconds)"
				max={600}
				min={1}
				onChange={(minSeconds) => change({ minSeconds })}
				step={1}
				value={form.minSeconds}
			/>
			<NumberField
				label="Longest short (seconds)"
				max={600}
				min={1}
				onChange={(maxSeconds) => change({ maxSeconds })}
				step={1}
				value={form.maxSeconds}
			/>
			<AspectSelect
				label="Shorts aspect"
				onChange={(aspect) => change({ aspect })}
				value={form.aspect}
			/>
			<CheckField
				checked={form.captions}
				disabled={disabled}
				label="Word-by-word captions"
				onChange={(captions) => change({ captions })}
			/>
			<CheckField
				checked={form.exportShorts}
				disabled={disabled}
				label="Export each short"
				onChange={(exportShorts) => change({ exportShorts })}
			/>
			<RyuAppActions>
				<Button disabled={disabled} onClick={() => void make()}>
					Make shorts
				</Button>
			</RyuAppActions>
			{shorts && shorts.length > 0 && (
				<ol aria-label="Created shorts" className="flex flex-col gap-1">
					{shorts.map((short) => (
						<li className="flex items-center gap-2" key={short.project.id}>
							<span>
								{short.project.title} · {(short.end - short.start).toFixed(1)} s
								{short.exportError
									? ` ${tl("· export failed: {exportError}", { exportError: short.exportError })}`
									: ""}
							</span>
							<Button
								aria-label={tl("Open {title}", { title: short.project.title })}
								disabled={disabled}
								onClick={() => void openProject(runtime, short.project.id)}
								size="sm"
								variant="outline"
							>
								Open
							</Button>
						</li>
					))}
				</ol>
			)}
		</RyuAppSection>
	);
}
