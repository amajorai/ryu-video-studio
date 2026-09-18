interface PreviewAsset {
	id: string;
	kind: "audio" | "image" | "video";
}

/** Owns only the media referenced by the current preview, including pending reads. */
export class PreviewSources {
	private readonly sources: Record<string, string> = {};
	private readonly pending = new Map<
		string,
		{ promise: Promise<Blob>; controller: AbortController }
	>();
	private generation = 0;

	constructor(
		private readonly load: (
			asset: PreviewAsset,
			signal: AbortSignal
		) => Promise<Blob>,
		private readonly createUrl = URL.createObjectURL,
		private readonly revokeUrl = URL.revokeObjectURL
	) {}

	snapshot(): Record<string, string> {
		return { ...this.sources };
	}

	remove(id: string): void {
		this.pending.get(id)?.controller.abort();
		this.pending.delete(id);
		const url = this.sources[id];
		if (url) {
			this.revokeUrl(url);
			delete this.sources[id];
		}
	}

	sync(
		assets: readonly PreviewAsset[],
		onChange: (sources: Record<string, string>) => void,
		onError: (error: unknown) => void
	): () => void {
		const generation = ++this.generation;
		const active = () => generation === this.generation;
		const ids = new Set(assets.map((asset) => asset.id));
		for (const id of this.pending.keys()) {
			if (!ids.has(id)) {
				this.remove(id);
			}
		}
		let removed = false;
		for (const id of Object.keys(this.sources)) {
			if (!ids.has(id)) {
				this.remove(id);
				removed = true;
			}
		}
		if (removed) {
			onChange(this.snapshot());
		}
		void (async () => {
			for (const asset of assets) {
				if (!active()) {
					return;
				}
				if (this.sources[asset.id]) {
					continue;
				}
				let request = this.pending.get(asset.id);
				try {
					if (!request) {
						const controller = new AbortController();
						request = {
							controller,
							promise: Promise.resolve().then(() => {
								controller.signal.throwIfAborted();
								return this.load(asset, controller.signal);
							}),
						};
						this.pending.set(asset.id, request);
						const clear = () => {
							if (this.pending.get(asset.id) === request) {
								this.pending.delete(asset.id);
							}
						};
						void request.promise.then(clear, clear);
					}
					const blob = await request.promise;
					if (!active()) {
						return;
					}
					this.sources[asset.id] = this.createUrl(blob);
					onChange(this.snapshot());
				} catch (error) {
					if (!active()) {
						return;
					}
					if (!request?.controller.signal.aborted) {
						onError(error);
					}
				}
			}
		})();
		return () => {
			if (active()) {
				this.generation += 1;
			}
		};
	}

	dispose(): void {
		this.generation += 1;
		for (const id of Object.keys(this.sources)) {
			this.remove(id);
		}
		for (const { controller } of this.pending.values()) {
			controller.abort();
		}
		this.pending.clear();
	}
}
