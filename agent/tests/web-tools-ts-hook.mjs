/** Resolve sibling `.js` specifiers to `.ts` so strip-types can load web-tools sources. */
export async function resolve(specifier, context, nextResolve) {
	if (typeof specifier === "string" && specifier.endsWith(".js") && !specifier.includes("node_modules")) {
		try {
			return await nextResolve(specifier.replace(/\.js$/u, ".ts"), context);
		} catch {
			/* fall through to the original specifier */
		}
	}
	return nextResolve(specifier, context);
}
