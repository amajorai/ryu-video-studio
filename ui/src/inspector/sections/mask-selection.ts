import { useSyncExternalStore } from "react";

/**
 * Which mask the inspector's mask list and the preview's mask handles are
 * editing (W2-V3). Transient viewer state shared between `MaskSection` and
 * `MaskHandles`; it never enters the project.
 */
export interface ActiveMask {
	maskId: string;
	segmentId: string;
}

let active: ActiveMask | null = null;
const listeners = new Set<() => void>();

export function getActiveMask(): ActiveMask | null {
	return active;
}

export function setActiveMask(next: ActiveMask | null): void {
	if (
		next?.maskId === active?.maskId &&
		next?.segmentId === active?.segmentId
	) {
		return;
	}
	active = next;
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * The active mask id on `segmentId`, falling back to its first mask when the
 * active one belongs to another clip or was removed.
 */
export function useActiveMaskId(
	segmentId: string | undefined,
	maskIds: readonly string[]
): string | undefined {
	const current = useSyncExternalStore(subscribe, getActiveMask, getActiveMask);
	if (
		current &&
		current.segmentId === segmentId &&
		maskIds.includes(current.maskId)
	) {
		return current.maskId;
	}
	return maskIds[0];
}
