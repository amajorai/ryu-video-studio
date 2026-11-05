import { ToggleGroup, ToggleGroupItem } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { TRIM_TOOLS, type TrimTool } from "./editing-ui.ts";

export function TrimToolSelector({
	onChange,
	tool,
}: {
	onChange: (tool: TrimTool) => void;
	tool: TrimTool;
}) {
	const tl = useLiteralMessages();
	return (
		<ToggleGroup
			aria-label="Timeline edit tool"
			onValueChange={(values: string[]) => {
				const next = TRIM_TOOLS.find((entry) => entry.tool === values[0]);
				if (next) {
					onChange(next.tool);
				}
			}}
			size="sm"
			spacing={0}
			value={[tool]}
			variant="outline"
		>
			{TRIM_TOOLS.map((entry) => (
				<ToggleGroupItem
					aria-keyshortcuts={entry.key.toUpperCase()}
					aria-label={tl("{tool} tool ({shortcut})", {
						shortcut: entry.key.toUpperCase(),
						tool: tl(entry.label),
					})}
					key={entry.tool}
					title={tl("{description} Shortcut: {shortcut}.", {
						description: tl(entry.description),
						shortcut: entry.key.toUpperCase(),
					})}
					value={entry.tool}
				>
					{entry.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
