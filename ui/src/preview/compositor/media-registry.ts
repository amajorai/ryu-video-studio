import { createContext } from "react";
import { glRedrawEvents } from "../gl/GlLayer.tsx";
import type { GlSource } from "../gl/pipeline.ts";

/**
 * The preview's media elements by clip id, so the blend compositor samples
 * the same `<video>`/`<img>` each `PreviewMediaLayer` already seeks, plays
 * and mixes. Listeners hear when an element registers, leaves, or has a new
 * frame (`glRedrawEvents`).
 */
export class PreviewMediaRegistry {
	readonly #elements = new Map<string, GlSource>();
	readonly #listeners = new Set<() => void>();

	readonly #notify = () => {
		for (const listener of this.#listeners) {
			listener();
		}
	};

	get(segmentId: string): GlSource | undefined {
		return this.#elements.get(segmentId);
	}

	/** Register a clip's element; returns the matching unregister. */
	register(segmentId: string, element: GlSource): () => void {
		this.#elements.set(segmentId, element);
		for (const event of glRedrawEvents) {
			element.addEventListener(event, this.#notify);
		}
		this.#notify();
		return () => {
			for (const event of glRedrawEvents) {
				element.removeEventListener(event, this.#notify);
			}
			if (this.#elements.get(segmentId) === element) {
				this.#elements.delete(segmentId);
			}
			this.#notify();
		};
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
}

export const PreviewMediaRegistryContext =
	createContext<PreviewMediaRegistry | null>(null);
