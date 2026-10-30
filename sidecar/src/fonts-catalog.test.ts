import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsForProject, creditsMarkdown } from "../../shared/credits.ts";
import { newProject } from "../../shared/project.ts";
import type { FontOrigin } from "../../shared/schema/font.ts";
import { fontLibraryFor } from "./font-library.ts";
import {
	allowedFontUrl,
	clearFontCatalogCache,
	type FetchLike,
	FontLicenseError,
	importCatalogFont,
	searchFontCatalog,
} from "./fonts-catalog.ts";

const lobster = await Bun.file(
	join(import.meta.dir, "../assets/fonts/Lobster-Regular.ttf")
).bytes();

const CATALOG = [
	{
		category: "display",
		defSubset: "latin",
		family: "Lobster",
		id: "lobster",
		license: "OFL-1.1",
		styles: ["normal"],
		subsets: ["latin", "cyrillic"],
		weights: [400],
	},
	{
		defSubset: "latin",
		family: "Lobster Two",
		id: "lobster-two",
		license: "OFL-1.1",
		styles: ["normal", "italic"],
		subsets: ["latin"],
		weights: [400, 700],
	},
	{
		defSubset: "latin",
		family: "Lobster Mono",
		id: "lobster-mono",
		license: "CC0-1.0",
		styles: ["normal"],
		subsets: ["latin"],
		weights: [400],
	},
	{
		family: "Ubuntu",
		id: "ubuntu",
		license: "UFL-1.0",
		subsets: ["latin"],
		weights: [400],
	},
];

const ttfUrl = (id: string) =>
	`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-400-normal.ttf`;

function detail(id: string, overrides: Record<string, unknown> = {}) {
	const entry = CATALOG.find((item) => item.id === id) ?? CATALOG[0];
	return {
		...entry,
		source: "https://github.com/google/fonts",
		variants: {
			400: { normal: { latin: { url: { ttf: ttfUrl(id) } } } },
		},
		...overrides,
	};
}

/** A fetch that answers from a table of URLs and records every request. */
function mockFetch(routes: Record<string, () => Response>) {
	const requested: string[] = [];
	const redirects: (RequestRedirect | undefined)[] = [];
	const fetcher: FetchLike = (input, init) => {
		requested.push(input);
		redirects.push(init?.redirect);
		const route = routes[input];
		return Promise.resolve(
			route ? route() : new Response("not found", { status: 404 })
		);
	};
	return { fetcher, redirects, requested };
}

const jsonResponse = (body: unknown) => Response.json(body);

let directory = "";
beforeEach(async () => {
	clearFontCatalogCache();
	directory = await mkdtemp(join(tmpdir(), "ryu-font-catalog-"));
});
afterEach(async () => {
	await rm(directory, {
		force: true,
		recursive: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

test("only HTTPS URLs on the exact allowlisted host pass", () => {
	const host = "cdn.jsdelivr.net";
	expect(allowedFontUrl(ttfUrl("lobster"), host)).not.toBeNull();
	expect(allowedFontUrl("http://cdn.jsdelivr.net/x.ttf", host)).toBeNull();
	expect(
		allowedFontUrl("https://cdn.jsdelivr.net.evil.test/x.ttf", host)
	).toBeNull();
	expect(
		allowedFontUrl("https://evil.test/cdn.jsdelivr.net/x.ttf", host)
	).toBeNull();
	expect(
		allowedFontUrl("https://user@cdn.jsdelivr.net/x.ttf", host)
	).toBeNull();
	expect(
		allowedFontUrl("https://cdn.jsdelivr.net:8443/x.ttf", host)
	).toBeNull();
	expect(allowedFontUrl("not a url", host)).toBeNull();
});

test("search lists open-licensed matches, prefix matches first", async () => {
	const { fetcher, requested } = mockFetch({
		"https://api.fontsource.org/v1/fonts": () => jsonResponse(CATALOG),
	});
	const results = await searchFontCatalog("LOBSTER", { fetch: fetcher });
	expect(results.map((font) => font.id)).toEqual(["lobster", "lobster-two"]);
	expect(results[0]).toEqual({
		category: "display",
		defaultSubset: "latin",
		family: "Lobster",
		id: "lobster",
		license: "OFL-1.1",
		styles: ["normal"],
		subsets: ["latin", "cyrillic"],
		weights: [400],
	});
	// The CC0 font is left out; UFL is accepted.
	expect(
		(await searchFontCatalog("ubu", { fetch: fetcher })).map((f) => f.license)
	).toEqual(["UFL-1.0"]);
	// The listing is cached between searches.
	expect(requested).toEqual(["https://api.fontsource.org/v1/fonts"]);
});

test("a catalog request that redirects is refused, not followed", async () => {
	const { fetcher } = mockFetch({
		"https://api.fontsource.org/v1/fonts": () =>
			Response.redirect("https://evil.test/fonts", 302),
	});
	await expect(searchFontCatalog("", { fetch: fetcher })).rejects.toThrow(
		/redirected/
	);
});

test("imports the TTF from the CDN and records its license for the credits", async () => {
	const { fetcher, redirects, requested } = mockFetch({
		"https://api.fontsource.org/v1/fonts/lobster": () =>
			jsonResponse(detail("lobster")),
		[ttfUrl("lobster")]: () => new Response(lobster),
	});
	const library = fontLibraryFor(directory);
	const font = await importCatalogFont(
		library,
		{ id: "lobster", style: "normal", weight: 400 },
		{ fetch: fetcher }
	);
	expect(requested).toEqual([
		"https://api.fontsource.org/v1/fonts/lobster",
		ttfUrl("lobster"),
	]);
	// Redirects are never followed to another host.
	expect(redirects).toEqual(["manual", "manual"]);
	expect(font).toMatchObject({
		family: "Lobster",
		name: "Lobster 400",
		origin: {
			identifier: "lobster:latin-400-normal",
			license: "OFL-1.1",
			licenseUrl: "https://spdx.org/licenses/OFL-1.1.html",
			pageUrl: "https://fontsource.org/fonts/lobster",
			provider: "fontsource",
		},
		size: lobster.byteLength,
	});
	const project = newProject("Credits");
	// The credits list the online fonts the project actually uses.
	const withFont = {
		...project,
		captionStyle: { customFont: { family: font.family, id: font.id } },
	} as unknown as typeof project;
	const credits = creditsForProject(withFont, [], await library.list());
	expect(credits.fonts).toEqual([
		{ family: "Lobster", fontId: font.id, origin: font.origin as FontOrigin },
	]);
	expect(creditsMarkdown(credits)).toContain(
		"License: OFL-1.1 (https://spdx.org/licenses/OFL-1.1.html)"
	);
	expect(creditsForProject(project, [], await library.list()).fonts).toBe(
		undefined
	);
});

test("refuses a font whose license is not open, before downloading it", async () => {
	const { fetcher, requested } = mockFetch({
		"https://api.fontsource.org/v1/fonts/lobster-mono": () =>
			jsonResponse(detail("lobster-mono")),
		[ttfUrl("lobster-mono")]: () => new Response(lobster),
	});
	const attempt = importCatalogFont(
		fontLibraryFor(directory),
		{ id: "lobster-mono", style: "normal", weight: 400 },
		{ fetch: fetcher }
	);
	await expect(attempt).rejects.toBeInstanceOf(FontLicenseError);
	await attempt.catch(() => undefined);
	expect(requested).toEqual([
		"https://api.fontsource.org/v1/fonts/lobster-mono",
	]);
	expect(await fontLibraryFor(directory).list()).toEqual([]);
});

test("refuses a file URL off the CDN allowlist and a file that is not a font", async () => {
	const offHost = mockFetch({
		"https://api.fontsource.org/v1/fonts/lobster": () =>
			jsonResponse(
				detail("lobster", {
					variants: {
						400: {
							normal: {
								latin: { url: { ttf: "https://evil.test/lobster.ttf" } },
							},
						},
					},
				})
			),
	});
	await expect(
		importCatalogFont(
			fontLibraryFor(directory),
			{ id: "lobster", style: "normal", weight: 400 },
			{ fetch: offHost.fetcher }
		)
	).rejects.toThrow(/limited to https:\/\/cdn\.jsdelivr\.net/);
	expect(offHost.requested).not.toContain("https://evil.test/lobster.ttf");

	const notFont = mockFetch({
		"https://api.fontsource.org/v1/fonts/lobster": () =>
			jsonResponse(detail("lobster")),
		[ttfUrl("lobster")]: () => new Response("<html>not a font</html>"),
	});
	await expect(
		importCatalogFont(
			fontLibraryFor(directory),
			{ id: "lobster", style: "normal", weight: 400 },
			{ fetch: notFont.fetcher }
		)
	).rejects.toThrow(/not a TrueType or OpenType font/);
});

test("a missing weight is reported with the font's name", async () => {
	const { fetcher } = mockFetch({
		"https://api.fontsource.org/v1/fonts/lobster": () =>
			jsonResponse(detail("lobster")),
	});
	await expect(
		importCatalogFont(
			fontLibraryFor(directory),
			{ id: "lobster", style: "italic", weight: 700 },
			{ fetch: fetcher }
		)
	).rejects.toThrow("Lobster has no italic 700 weight in the latin subset.");
});
