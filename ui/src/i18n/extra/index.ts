/**
 * Video Studio copy for languages beyond the host's 11 official packs: the
 * further languages the reference editor ships. Each `<locale>.json` holds a
 * complete catalog keyed by the exact English text: every literal string of
 * `STUDIO_MESSAGES` and every ICU template `studioFormat` uses, with the
 * locale's own plural categories. `catalog.test.tsx` fails on any missing key
 * or changed placeholder, so new English copy must be drafted here too.
 *
 * These catalogs are machine-drafted (`status: "machine-drafted"`) and not
 * yet reviewed by native speakers. They only apply when the host runs in that language, which needs
 * a host language pack for the locale (installed through Ryu's community
 * language packs); the app shell then layers them like the official ones.
 *
 * Known cost: every catalog (about 2.7 MB of JSON) is imported statically and
 * validated when this module loads, for every user. Loading only the active
 * locale's catalog is a follow-up recorded in `docs/video-editing-parity.md`;
 * it needs the shell's overlays to accept a catalog that arrives after the
 * first render.
 */
import { z } from "zod";
import cs from "./cs.json" with { type: "json" };
import da from "./da.json" with { type: "json" };
import el from "./el.json" with { type: "json" };
import fi from "./fi.json" with { type: "json" };
import he from "./he.json" with { type: "json" };
import hu from "./hu.json" with { type: "json" };
import id from "./id.json" with { type: "json" };
import nb from "./nb.json" with { type: "json" };
import nl from "./nl.json" with { type: "json" };
import pl from "./pl.json" with { type: "json" };
import ro from "./ro.json" with { type: "json" };
import sv from "./sv.json" with { type: "json" };
import th from "./th.json" with { type: "json" };
import tr from "./tr.json" with { type: "json" };
import uk from "./uk.json" with { type: "json" };
import vi from "./vi.json" with { type: "json" };
import zhTW from "./zh-TW.json" with { type: "json" };

export const extraCatalogSchema = z
	.object({
		language: z.string().min(1).max(60),
		locale: z.string().min(2).max(20),
		messages: z.record(z.string().min(1).max(400), z.string().min(1).max(800)),
		/** Every extra catalog is a machine draft until a reviewer signs it off. */
		status: z.enum(["machine-drafted", "reviewed"]),
	})
	.strict();
export type ExtraCatalog = z.infer<typeof extraCatalogSchema>;

/** The extra catalogs as shipped, validated. */
export const EXTRA_CATALOGS: readonly ExtraCatalog[] = [
	cs,
	da,
	el,
	fi,
	he,
	hu,
	id,
	nb,
	nl,
	pl,
	ro,
	sv,
	th,
	tr,
	uk,
	vi,
	zhTW,
].map((catalog) => extraCatalogSchema.parse(catalog));

/** Locale → English text → translation, for the extra languages. */
export const EXTRA_LOCALE_CATALOGS: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = Object.fromEntries(
	EXTRA_CATALOGS.map((catalog) => [catalog.locale, catalog.messages])
);
