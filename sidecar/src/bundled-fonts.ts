/**
 * The bundled title fonts, embedded in the compiled sidecar. Each import
 * yields the file's path: the real `assets/fonts` file in development, or a
 * path on Bun's virtual file system inside the compiled binary, which
 * `fonts.ts` copies out to a private directory before libass reads it.
 * `verify-package.ts` checks that this list matches `BUNDLED_FONT_FILES`.
 */
import antonRegular from "../assets/fonts/Anton-Regular.ttf" with {
	type: "file",
};
import bebasNeueRegular from "../assets/fonts/BebasNeue-Regular.ttf" with {
	type: "file",
};
import interBold from "../assets/fonts/Inter-Bold.ttf" with { type: "file" };
import interRegular from "../assets/fonts/Inter-Regular.ttf" with {
	type: "file",
};
import lobsterRegular from "../assets/fonts/Lobster-Regular.ttf" with {
	type: "file",
};
import merriweatherBold from "../assets/fonts/Merriweather-Bold.ttf" with {
	type: "file",
};
import merriweatherRegular from "../assets/fonts/Merriweather-Regular.ttf" with {
	type: "file",
};
import montserratBold from "../assets/fonts/Montserrat-Bold.ttf" with {
	type: "file",
};
import montserratRegular from "../assets/fonts/Montserrat-Regular.ttf" with {
	type: "file",
};
import oswaldBold from "../assets/fonts/Oswald-Bold.ttf" with { type: "file" };
import oswaldRegular from "../assets/fonts/Oswald-Regular.ttf" with {
	type: "file",
};
import permanentMarkerRegular from "../assets/fonts/PermanentMarker-Regular.ttf" with {
	type: "file",
};
import playfairDisplayBold from "../assets/fonts/PlayfairDisplay-Bold.ttf" with {
	type: "file",
};
import playfairDisplayRegular from "../assets/fonts/PlayfairDisplay-Regular.ttf" with {
	type: "file",
};
import poppinsBold from "../assets/fonts/Poppins-Bold.ttf" with {
	type: "file",
};
import poppinsRegular from "../assets/fonts/Poppins-Regular.ttf" with {
	type: "file",
};
import robotoBold from "../assets/fonts/Roboto-Bold.ttf" with { type: "file" };
import robotoRegular from "../assets/fonts/Roboto-Regular.ttf" with {
	type: "file",
};
import sourceCodeProBold from "../assets/fonts/SourceCodePro-Bold.ttf" with {
	type: "file",
};
import sourceCodeProRegular from "../assets/fonts/SourceCodePro-Regular.ttf" with {
	type: "file",
};

/** Embedded path of each bundled font file, by file name. */
export const EMBEDDED_FONTS: Readonly<Record<string, string>> = {
	"Anton-Regular.ttf": antonRegular,
	"BebasNeue-Regular.ttf": bebasNeueRegular,
	"Inter-Bold.ttf": interBold,
	"Inter-Regular.ttf": interRegular,
	"Lobster-Regular.ttf": lobsterRegular,
	"Merriweather-Bold.ttf": merriweatherBold,
	"Merriweather-Regular.ttf": merriweatherRegular,
	"Montserrat-Bold.ttf": montserratBold,
	"Montserrat-Regular.ttf": montserratRegular,
	"Oswald-Bold.ttf": oswaldBold,
	"Oswald-Regular.ttf": oswaldRegular,
	"PermanentMarker-Regular.ttf": permanentMarkerRegular,
	"PlayfairDisplay-Bold.ttf": playfairDisplayBold,
	"PlayfairDisplay-Regular.ttf": playfairDisplayRegular,
	"Poppins-Bold.ttf": poppinsBold,
	"Poppins-Regular.ttf": poppinsRegular,
	"Roboto-Bold.ttf": robotoBold,
	"Roboto-Regular.ttf": robotoRegular,
	"SourceCodePro-Bold.ttf": sourceCodeProBold,
	"SourceCodePro-Regular.ttf": sourceCodeProRegular,
};
