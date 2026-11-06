/**
 * Host policy for the sites this Worker serves.
 *
 * Both sites use www as the canonical host (as Ghost did for jetsfix.com);
 * the bare domain and plain http 301 to https://www.<domain>, keeping the
 * path. Only production is indexable. Any other host (*.workers.dev,
 * localhost) gets no redirects and is noindexed.
 */
interface Site {
	canonical: string;
	aliases: string[];
	indexable: boolean;
}

export const PRODUCTION: Site = {
	canonical: "www.jetsfix.com",
	aliases: ["jetsfix.com"],
	indexable: true,
};

/** Evaluation copy for the editor; same content, kept out of search. */
export const PREVIEW: Site = {
	canonical: "www.jetsfix-preview.com",
	aliases: ["jetsfix-preview.com"],
	indexable: false,
};

const SITES = [PRODUCTION, PREVIEW];

export function siteFor(hostname: string): Site | undefined {
	return SITES.find((s) => s.canonical === hostname || s.aliases.includes(hostname));
}

/**
 * Where a request to a known site should be 301'd (https + canonical host,
 * path and query kept), or null if it's already canonical / not ours.
 */
export function canonicalRedirect(url: URL): string | null {
	const site = siteFor(url.hostname);
	if (!site || (url.protocol === "https:" && url.hostname === site.canonical)) return null;
	const target = new URL(url.href);
	target.protocol = "https:";
	target.hostname = site.canonical;
	target.port = "";
	return target.href;
}

export function isProduction(url: URL): boolean {
	return siteFor(url.hostname) === PRODUCTION;
}

/**
 * The URL Ghost served a post at. Disqus threads are keyed by this exact
 * string (the old theme set page.url and no identifier), so it must not
 * change — not even to https — or every thread would start empty.
 */
export function legacyPostUrl(slug: string): string {
	return `http://www.jetsfix.com/${slug}/`;
}

export const DISQUS_SHORTNAME = "jetsfix";
