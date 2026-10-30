import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import type { Asset, Project } from "../../../shared/project.ts";
import type { FontChoice } from "../../../shared/schema/font.ts";
import { TITLE_FONTS } from "../../../shared/text-style.ts";
import {
	applyTextTemplate,
	TEXT_TEMPLATES,
	type TextTemplate,
	type TextTemplateCategory,
} from "../../../shared/text-templates.ts";
import "../fonts.css";
import { useEditorProject } from "../editor/context.tsx";
import { ImportedFontField } from "../ImportedFontField.tsx";
import type { PanelTab } from "./types.ts";

/**
 * Its own library tab while this is non-null; otherwise the panel mounts
 * inside its home category (Titles), below the title list.
 */
export const textTemplatesPanelTab: PanelTab | null = null;

const CATEGORY_LABELS: Record<TextTemplateCategory, string> = {
	"call-to-action": "Calls to action",
	callout: "Callouts",
	"lower-third": "Lower thirds",
	quote: "Quotes",
	social: "Social",
	"title-card": "Title cards",
};

/** Templates grouped by category, in catalog order. */
export function templatesByCategory(
	templates: readonly TextTemplate[] = TEXT_TEMPLATES
): [TextTemplateCategory, TextTemplate[]][] {
	const groups = new Map<TextTemplateCategory, TextTemplate[]>();
	for (const template of templates) {
		groups.set(template.category, [
			...(groups.get(template.category) ?? []),
			template,
		]);
	}
	return [...groups];
}

/**
 * The project with `template` placed at `time`, its first line replaced by
 * `text` when given and every title set in `font` when one is chosen, or an
 * error message.
 */
export function placeTemplate(
	project: Project,
	assets: readonly Asset[],
	template: TextTemplate,
	time: number,
	text: string,
	font: FontChoice = {}
): { error: string } | { project: Project } {
	try {
		return {
			project: applyTextTemplate(project, assets, template.id, {
				font,
				start: time,
				texts: text.trim() ? [text] : undefined,
			}),
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : "Template failed.",
		};
	}
}

/** The lead title's background box as a CSS color, or transparent. */
function leadBoxColor(lead: TextTemplate["titles"][number] | undefined) {
	if (!lead?.backgroundColor) {
		return "transparent";
	}
	const opacity = Math.round((lead.backgroundOpacity ?? 1) * 100);
	return `color-mix(in srgb, ${lead.backgroundColor} ${opacity}%, transparent)`;
}

function TemplateCard({
	onAdd,
	template,
}: {
	onAdd: () => void;
	template: TextTemplate;
}) {
	const tl = useLiteralMessages();
	const lead = template.titles[0];
	return (
		<div
			className="flex flex-col gap-1 rounded-md border p-2"
			data-text-template={template.id}
		>
			<div
				aria-hidden="true"
				className="truncate rounded bg-neutral-900 px-2 py-3 text-center text-sm"
			>
				<span
					className="px-1"
					style={{
						backgroundColor: leadBoxColor(lead),
						borderRadius: lead?.backgroundRadius ? "999px" : undefined,
						color: lead?.color,
						fontFamily: TITLE_FONTS[lead?.fontFamily ?? "system-sans"].css,
						fontStyle: lead?.italic ? "italic" : undefined,
						fontWeight: lead?.fontWeight ?? 700,
					}}
				>
					{lead?.text.split("\n")[0]}
				</span>
			</div>
			<div className="font-medium text-sm">{template.name}</div>
			<p className="text-muted-foreground text-xs">{template.description}</p>
			<Button
				aria-label={tl("Add {name} template at the playhead", {
					name: template.name,
				})}
				onClick={onAdd}
				size="sm"
				variant="outline"
			>
				Add
			</Button>
		</div>
	);
}

/** Text templates: original title presets placed at the playhead. */
export function TextTemplatesPanel() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const [text, setText] = useState("");
	const [font, setFont] = useState<FontChoice>({});
	const add = (template: TextTemplate) => {
		const placed = placeTemplate(
			runtime.project,
			runtime.assets,
			template,
			runtime.time,
			text,
			font
		);
		if ("error" in placed) {
			runtime.setStatus(placed.error);
			return;
		}
		runtime.edit(placed.project, `Add ${template.name}`);
		runtime.setStatus(
			tl("Added the {name} text template.", { name: template.name })
		);
	};
	return (
		<RyuAppSection title="Text templates">
			<RyuAppField label="Text (optional, replaces the first line)">
				<Input
					aria-label="Template text"
					maxLength={500}
					onChange={(event) => setText(event.target.value)}
					placeholder="Use the template's sample text"
					value={text}
				/>
			</RyuAppField>
			<ImportedFontField label="Template" onChange={setFont} value={font} />
			{templatesByCategory().map(([category, templates]) => (
				<section aria-label={CATEGORY_LABELS[category]} key={category}>
					<h3 className="mb-1 font-medium text-xs uppercase">
						{CATEGORY_LABELS[category]}
					</h3>
					<div className="grid grid-cols-2 gap-2">
						{templates.map((template) => (
							<TemplateCard
								key={template.id}
								onAdd={() => add(template)}
								template={template}
							/>
						))}
					</div>
				</section>
			))}
		</RyuAppSection>
	);
}
