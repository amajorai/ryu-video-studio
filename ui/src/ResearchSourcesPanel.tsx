import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input, Textarea } from "@ryu/blocks/companion/controls";
import { useState } from "react";
import type { ResearchSource } from "../../shared/research.ts";

export function ResearchSourcesPanel({
	onChange,
	sources,
}: {
	onChange: (sources: ResearchSource[]) => void;
	sources: ResearchSource[];
}) {
	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [note, setNote] = useState("");
	const [error, setError] = useState("");
	const add = () => {
		try {
			const parsed = new URL(url.trim());
			if (parsed.protocol !== "https:") {
				throw new Error("Research sources require HTTPS.");
			}
			if (!title.trim()) {
				throw new Error("Add a title for this source.");
			}
			if (sources.some((source) => source.url === parsed.toString())) {
				throw new Error("This research source is already saved.");
			}
			onChange([
				...sources,
				{
					id: crypto.randomUUID(),
					...(note.trim() ? { note: note.trim() } : {}),
					retrievedAt: new Date().toISOString(),
					title: title.trim(),
					url: parsed.toString(),
				},
			]);
			setTitle("");
			setUrl("");
			setNote("");
			setError("");
		} catch (value) {
			setError(value instanceof Error ? value.message : "Invalid source.");
		}
	};
	return (
		<RyuAppSection title="Research sources">
			<p className="text-muted-foreground">
				Keep source citations with the production brief. Video Studio stores the
				URL, title, note, and retrieval time; it does not claim to verify the
				source.
			</p>
			<RyuAppField label="Source title">
				<Input
					aria-label="Research source title"
					maxLength={240}
					onChange={(event) => setTitle(event.target.value)}
					value={title}
				/>
			</RyuAppField>
			<RyuAppField label="HTTPS URL">
				<Input
					aria-label="Research source URL"
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://example.com/article"
					value={url}
				/>
			</RyuAppField>
			<RyuAppField label="Research note">
				<Textarea
					aria-label="Research source note"
					maxLength={2000}
					onChange={(event) => setNote(event.target.value)}
					value={note}
				/>
			</RyuAppField>
			{error ? <small role="alert">{error}</small> : null}
			<RyuAppActions>
				<Button
					disabled={sources.length >= 100}
					onClick={add}
					variant="outline"
				>
					Add research source
				</Button>
			</RyuAppActions>
			{sources.map((source) => (
				<div className="studio-scene" key={source.id}>
					<strong>{source.title}</strong>
					<small>{source.url}</small>
					{source.note ? <p>{source.note}</p> : null}
					<small>
						Retrieved {new Date(source.retrievedAt).toLocaleString()}
					</small>
					<Button
						aria-label={`Remove research source ${source.title}`}
						onClick={() =>
							onChange(sources.filter((item) => item.id !== source.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove source
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
