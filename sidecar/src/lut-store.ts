/**
 * Imported `.cube` LUTs (W2-V5): `<storeDir>/luts/<id>.cube` plus a
 * `luts.json` index of `lutRecordSchema` records. Files are always the
 * canonical serialization of a validated LUT, so `lut3d` never reads user
 * text directly. Writes go through a temporary file and a rename. A LUT
 * deleted while only saved history references it is retired (`retired.json`)
 * rather than erased, so undo never leaves a clip pointing at nothing.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseCubeLut, serializeCubeLut } from "../../shared/cube-lut.ts";
import { lutIdsIn } from "../../shared/library-refs.ts";
import type { Project } from "../../shared/project.ts";
import { type LutRecord, lutRecordSchema } from "../../shared/schema/color.ts";

const indexSchema = z.array(lutRecordSchema);

/** Most LUTs one library keeps. */
export const MAX_STORED_LUTS = 200;

/** Thrown when a LUT is still referenced by a project and cannot be removed. */
export class LutInUseError extends Error {
	readonly projects: string[];
	constructor(projects: string[]) {
		super(
			`This LUT is used by ${projects.length === 1 ? "a project" : `${projects.length} projects`} (${projects.slice(0, 3).join(", ")}). Remove it from those clips first.`
		);
		this.name = "LutInUseError";
		this.projects = projects;
	}
}

/**
 * Titles of the projects whose JSON references `lutId` anywhere, each
 * project listed once (under its first matching revision when history
 * revisions are passed too).
 */
export function projectsUsingLut(
	projects: readonly Project[],
	lutId: string
): string[] {
	const needle = `"lutId":"${lutId}"`;
	const users = new Map<string, string>();
	for (const project of projects) {
		if (!users.has(project.id) && JSON.stringify(project).includes(needle)) {
			users.set(project.id, project.title);
		}
	}
	return [...users.values()];
}

/** What `remove` did with a LUT's file. */
export interface LutRemoval {
	/** True when saved history still references the LUT, so its file was kept. */
	keptForHistory: boolean;
}

export class LutStore {
	readonly directory: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(storeDirectory: string) {
		this.directory = join(storeDirectory, "luts");
	}

	/** Absolute path of a stored LUT (it may not exist). */
	path(id: string): string {
		return join(this.directory, `${z.uuid().parse(id)}.cube`);
	}

	private get indexPath() {
		return join(this.directory, "luts.json");
	}

	/**
	 * LUTs deleted from the library while a saved history revision still
	 * referenced them. Their files stay so undo or a history restore renders
	 * the same picture; they are purged once nothing references them.
	 */
	private get retiredPath() {
		return join(this.directory, "retired.json");
	}

	/** Serialize index mutations so concurrent imports never lose records. */
	private exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
		const next = this.queue.then(operation, operation);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async readIndex(path: string): Promise<LutRecord[]> {
		if (!existsSync(path)) {
			return [];
		}
		const parsed = indexSchema.safeParse(
			JSON.parse(await readFile(path, "utf8"))
		);
		return parsed.success ? parsed.data : [];
	}

	/** The LUTs in the library. */
	list(): Promise<LutRecord[]> {
		return this.readIndex(this.indexPath);
	}

	/** Deleted LUTs whose files are kept for saved history. */
	retired(): Promise<LutRecord[]> {
		return this.readIndex(this.retiredPath);
	}

	/** A library LUT, or a retired one that history can still bring back. */
	async get(id: string): Promise<LutRecord | undefined> {
		return (
			(await this.list()).find((record) => record.id === id) ??
			(await this.retired()).find((record) => record.id === id)
		);
	}

	/** The canonical `.cube` text of a stored (or retired) LUT. */
	async read(id: string): Promise<string> {
		if (!(await this.get(id))) {
			throw new Error("LUT not found.");
		}
		return await readFile(this.path(id), "utf8");
	}

	private async writeIndex(path: string, records: LutRecord[]) {
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(records, null, "\t"));
		await rename(temporary, path);
	}

	/** Validate, canonicalize and store a `.cube` LUT. */
	async add(name: string, text: string): Promise<LutRecord> {
		const lut = parseCubeLut(text);
		return await this.exclusive(async () => {
			const records = await this.list();
			if (records.length >= MAX_STORED_LUTS) {
				throw new Error(
					`The library already holds ${MAX_STORED_LUTS} LUTs. Delete one first.`
				);
			}
			await mkdir(this.directory, { recursive: true });
			const record = lutRecordSchema.parse({
				createdAt: new Date().toISOString(),
				id: crypto.randomUUID(),
				name: name.trim().slice(0, 120) || lut.title || "LUT",
				size: lut.size,
			});
			const temporary = `${this.path(record.id)}.tmp`;
			await writeFile(temporary, serializeCubeLut(lut));
			await rename(temporary, this.path(record.id));
			await this.writeIndex(this.indexPath, [...records, record]);
			return record;
		});
	}

	/**
	 * Store a LUT carried by a project archive under its original id (LUT ids
	 * are random UUIDs, so an id already on this node is the same LUT and is
	 * reused; a retired one moves back into the library). The text is
	 * validated and canonicalized like an import. Returns whether the LUT was
	 * written (`added`) or already present (`reused`).
	 */
	async adopt(record: LutRecord, text: string): Promise<"added" | "reused"> {
		const lut = parseCubeLut(text);
		const adopted = lutRecordSchema.parse({ ...record, size: lut.size });
		return await this.exclusive(async () => {
			const records = await this.list();
			if (records.some((entry) => entry.id === adopted.id)) {
				return "reused";
			}
			const retired = await this.retired();
			const previous = retired.find((entry) => entry.id === adopted.id);
			if (records.length >= MAX_STORED_LUTS) {
				throw new Error(
					`The library already holds ${MAX_STORED_LUTS} LUTs. Delete one before importing ${adopted.name}.`
				);
			}
			await mkdir(this.directory, { recursive: true });
			if (!(previous && existsSync(this.path(adopted.id)))) {
				const temporary = `${this.path(adopted.id)}.tmp`;
				await writeFile(temporary, serializeCubeLut(lut));
				await rename(temporary, this.path(adopted.id));
			}
			if (previous) {
				await this.writeIndex(
					this.retiredPath,
					retired.filter((entry) => entry.id !== adopted.id)
				);
			}
			await this.writeIndex(this.indexPath, [...records, previous ?? adopted]);
			return previous ? "reused" : "added";
		});
	}

	/**
	 * Delete a LUT from the library unless a current project references it.
	 * When only saved history revisions (`history`) reference it, the record
	 * moves to the retired index and its file stays, so undo still renders.
	 * Retired LUTs nothing references any more are purged on the way.
	 */
	async remove(
		id: string,
		projects: readonly Project[],
		history: readonly Project[] = []
	): Promise<LutRemoval> {
		return await this.exclusive(async () => {
			const records = await this.list();
			const retired = await this.retired();
			const record =
				records.find((entry) => entry.id === id) ??
				retired.find((entry) => entry.id === id);
			if (!record) {
				throw new Error("LUT not found.");
			}
			const users = projectsUsingLut(projects, id);
			if (users.length) {
				throw new LutInUseError(users);
			}
			const referenced = lutIdsIn([...projects, ...history]);
			const keptForHistory = referenced.has(id);
			const keep = [
				...retired.filter(
					(entry) => entry.id !== id && referenced.has(entry.id)
				),
				...(keptForHistory ? [record] : []),
			];
			const purge = retired.filter(
				(entry) => entry.id !== id && !referenced.has(entry.id)
			);
			await this.writeIndex(
				this.indexPath,
				records.filter((entry) => entry.id !== id)
			);
			await this.writeIndex(this.retiredPath, keep);
			for (const entry of [...purge, ...(keptForHistory ? [] : [record])]) {
				await rm(this.path(entry.id), { force: true });
			}
			return { keptForHistory };
		});
	}

	/**
	 * Throw a clear error unless every LUT id referenced in `value` is stored
	 * (in the library, or retired but still restorable).
	 */
	async assertAvailable(value: unknown): Promise<void> {
		const ids = lutIdsIn(value);
		if (!ids.size) {
			return;
		}
		const stored = new Set(
			[...(await this.list()), ...(await this.retired())].map(
				(record) => record.id
			)
		);
		const missing = [...ids].filter((id) => !stored.has(id));
		if (missing.length) {
			throw new Error(
				`The LUT ${missing[0]} is not in the library. Import it before assigning it to a clip.`
			);
		}
	}
}

const stores = new Map<string, LutStore>();

/** One LUT store per project-store directory, shared by the routes and the render. */
export function lutStoreFor(storeDirectory: string): LutStore {
	let store = stores.get(storeDirectory);
	if (!store) {
		store = new LutStore(storeDirectory);
		stores.set(storeDirectory, store);
	}
	return store;
}

/**
 * The `lutPath` resolver every real render passes to `buildRender`: the stored
 * canonical file of an imported LUT, or a clear error when it is gone.
 */
export function lutResolver(storeDirectory: string): (lutId: string) => string {
	const store = lutStoreFor(storeDirectory);
	return (lutId) => {
		const path = store.path(lutId);
		if (!existsSync(path)) {
			throw new Error(
				`The LUT ${lutId} is missing from the library. Import it again or remove it from the clip.`
			);
		}
		return path;
	};
}
