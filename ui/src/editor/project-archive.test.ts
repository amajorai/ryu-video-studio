import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const { createTestRuntime, lastStatus, testProject } = await import(
	"./test-runtime.ts"
);
const { downloadProjectArchive, importPackage } = await import(
	"./project-actions.ts"
);

afterAll(() => {
	GlobalRegistrator.unregister();
});

interface Call {
	body?: unknown;
	method?: string;
	path: string;
}

let downloads: { name: string; size: number }[] = [];
beforeAll(() => {
	URL.createObjectURL = () => "blob:archive";
	URL.revokeObjectURL = () => undefined;
	HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
		downloads.push({ name: this.download, size: 0 });
	};
});

test("Download project archive builds it on the node and downloads every chunk", async () => {
	downloads = [];
	const runtime = createTestRuntime(testProject().project);
	const calls: Call[] = [];
	const bytes = btoa("PK\u0003\u0004archive-bytes");
	window.ryu = {
		app: {
			request: (input: Call) => {
				calls.push(input);
				if (input.path.endsWith("/package-archive")) {
					return Promise.resolve({
						archiveId: "a1",
						assets: 2,
						filename: "Demo.ryu-video-project.zip",
						missing: [],
						size: 17,
					});
				}
				return Promise.resolve({
					data: bytes,
					done: true,
					offset: 0,
					size: 17,
				});
			},
		},
	} as never;
	await downloadProjectArchive(runtime);
	expect(calls.map((call) => call.path)).toEqual([
		`/projects/${runtime.project?.id}/package-archive`,
		"/package-archive-data?id=a1&offset=0",
	]);
	expect(downloads.map((item) => item.name)).toEqual([
		"Demo.ryu-video-project.zip",
	]);
	expect(lastStatus(runtime)).toContain("2 media files");
});

test("importing a ZIP uploads it in chunks and opens the imported project", async () => {
	const runtime = createTestRuntime(testProject().project);
	const imported = { ...testProject().project, title: "Demo (imported)" };
	const calls: Call[] = [];
	window.ryu = {
		app: {
			request: (input: Call) => {
				calls.push(input);
				if (input.path === "/package-archive-imports") {
					return Promise.resolve({ chunkSize: 4, id: "u1" });
				}
				if (input.path === "/package-archive-import-chunks") {
					const body = input.body as { data: string; offset: number };
					return Promise.resolve({
						offset: body.offset + atob(body.data).length,
					});
				}
				if (input.path === "/package-archive-import-finish") {
					return Promise.resolve({
						added: ["x"],
						project: imported,
						reused: [],
					});
				}
				return Promise.resolve({ assets: [] });
			},
		},
	} as never;
	const zip = new File(
		[new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5])],
		"p.zip"
	);
	await importPackage(runtime, zip);
	expect(
		calls.filter((call) => call.path === "/package-archive-import-chunks")
	).toHaveLength(3);
	const opened = runtime.calls.find(([name]) => name === "setProject");
	expect((opened?.[1] as { title: string }).title).toBe("Demo (imported)");
	expect(lastStatus(runtime)).toContain("1 new media file");
});

test("archive status lines name carried LUTs and fonts and what was left out", async () => {
	const { archiveDownloadStatus } = await import("./project-actions.ts");
	expect(
		archiveDownloadStatus({
			assets: 2,
			fonts: 1,
			luts: 2,
			missing: [],
			missingFonts: [],
			missingLuts: [],
		})
	).toBe(
		"Project archive downloaded with 2 media files plus 2 LUTs and 1 font."
	);
	expect(
		archiveDownloadStatus({
			assets: 3,
			fonts: 0,
			luts: 0,
			missing: ["a"],
			missingFonts: ["f"],
			missingLuts: ["l1", "l2"],
		})
	).toBe(
		"Project archive downloaded with 2 of 3 media files; 1 offline file, 2 missing LUTs, 1 missing font left out."
	);

	const runtime = createTestRuntime(testProject().project);
	window.ryu = {
		app: {
			request: (input: Call) => {
				if (input.path === "/package-archive-imports") {
					return Promise.resolve({ chunkSize: 64, id: "u2" });
				}
				if (input.path === "/package-archive-import-chunks") {
					const body = input.body as { data: string; offset: number };
					return Promise.resolve({
						offset: body.offset + atob(body.data).length,
					});
				}
				if (input.path === "/package-archive-import-finish") {
					return Promise.resolve({
						added: ["x"],
						fonts: { added: ["f"], reused: [] },
						luts: { added: ["l"], reused: [] },
						project: testProject().project,
						reused: [],
					});
				}
				return Promise.resolve({ assets: [] });
			},
		},
	} as never;
	await importPackage(
		runtime,
		new File([new Uint8Array([0x50, 0x4b, 3, 4, 1])], "p.zip")
	);
	expect(lastStatus(runtime)).toContain(
		"1 new media file plus 1 LUT and 1 font"
	);
});
