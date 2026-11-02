import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	builtinHandlerKeys,
	diffInventory,
	openapiKeys,
	registryHandlerKey,
} from "./handler-inventory.ts";
import { studioRoutes } from "./routes/index.ts";
import { openapi } from "./server.ts";

const serverSource = await Bun.file(join(import.meta.dir, "server.ts")).text();
const manifest = (await Bun.file(
	join(import.meta.dir, "../../manifest.json")
).json()) as {
	sidecars: { http: { routes: { method: string; path: string }[] } }[];
};
const manifestKeys = (manifest.sidecars[0]?.http.routes ?? []).map(
	(route) => `${route.method} ${route.path}`
);
const builtin = builtinHandlerKeys(serverSource);
const registry = studioRoutes.map(registryHandlerKey);

describe("handler inventory", () => {
	test("every built-in handler publishes an OpenAPI operation", () => {
		const diff = diffInventory(
			openapiKeys(openapi([]).paths as Record<string, Record<string, unknown>>),
			builtin
		);
		expect(diff).toEqual({ duplicates: [], extra: [], missing: [] });
	});

	test("registry handlers are distinct from built-ins", () => {
		const diff = diffInventory([], [...builtin, ...registry]);
		expect(diff.duplicates).toEqual([]);
	});

	test("manifest routes match the handlers one to one", () => {
		const diff = diffInventory(manifestKeys, [...builtin, ...registry]);
		expect(diff).toEqual({ duplicates: [], extra: [], missing: [] });
	});

	test("every manifest route has an OpenAPI operation", () => {
		const published = new Set(
			openapiKeys(openapi().paths as Record<string, Record<string, unknown>>)
		);
		expect(manifestKeys.filter((key) => !published.has(key))).toEqual([]);
	});

	test("the parser reads ids, literals and sub-actions", () => {
		expect(builtin).toContain("POST /projects/package");
		expect(builtin).toContain("GET /projects");
		expect(builtin).toContain("PUT /projects/:id");
		expect(builtin).toContain("POST /projects/:id/speed-ramp/reset");
		expect(builtin).toContain("POST /projects/:id/speed-curve/bake");
		expect(builtin).toContain("GET /search");
		expect(builtin).toContain("PUT /uploads/:id");
		expect(builtin).toContain("GET /renders/:id/data");
		expect(registry).toContain("POST /templates/:id/instantiate");
		expect(registry).toContain("POST /projects/:id/captions/rechunk");
	});

	test("the parser fails closed on method checks it can't read", () => {
		const anchor = 'if (id && action === "timeline" && method === "GET")';
		expect(serverSource).toContain(anchor);
		const inject = (line: string) =>
			serverSource.replace(anchor, `${line} {}\n${anchor}`);
		expect(
			builtinHandlerKeys(
				inject('if (id && action === "evil" && method === "POST")')
			)
		).toContain("POST /projects/:id/evil");
		for (const line of [
			'if (id && action === "evil" && ["POST", "PUT"].includes(method))',
			'if (id && action === "evil" && request.method === "POST")',
			'if (url.pathname.endsWith("/evil3") && method === "POST")',
			'if (id && action === "evil" && method !== "GET")',
		]) {
			expect(() => builtinHandlerKeys(inject(line))).toThrow(
				/Unreadable dispatch condition/
			);
		}
	});
});

describe("OpenAPI path parameters", () => {
	test("every templated path declares its required path parameters", () => {
		const missing: string[] = [];
		const paths = openapi([]).paths as Record<
			string,
			Record<
				string,
				{ parameters?: { name: string; in: string; required?: boolean }[] }
			>
		>;
		for (const [path, operations] of Object.entries(paths)) {
			const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
			for (const [method, operation] of Object.entries(operations)) {
				for (const name of names) {
					const declared = operation.parameters?.some(
						(parameter) =>
							parameter.name === name &&
							parameter.in === "path" &&
							parameter.required === true
					);
					if (!declared) {
						missing.push(`${method} ${path} {${name}}`);
					}
				}
			}
		}
		expect(missing).toEqual([]);
	});

	test("inspect-frame and interchange keep their query parameters", () => {
		const paths = openapi([]).paths as Record<
			string,
			Record<string, { parameters?: { name: string; in: string }[] }>
		>;
		const names = (path: string) =>
			paths[`/api/video-studio${path}`]?.get?.parameters?.map(
				(parameter) => `${parameter.in}:${parameter.name}`
			);
		expect(names("/projects/{id}/inspect-frame")).toEqual([
			"path:id",
			"query:time",
			"query:ungraded",
		]);
		expect(names("/projects/{id}/interchange")).toEqual([
			"path:id",
			"query:format",
		]);
	});
});
