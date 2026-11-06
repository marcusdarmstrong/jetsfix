/**
 * Hostnames that are the real jetsfix.com. Everything else (the
 * jetsfix-preview.com evaluation site, *.workers.dev, localhost) is a copy
 * and is noindexed.
 */
export const CANONICAL_HOST = "www.jetsfix.com";
export const PRODUCTION_HOSTS = new Set([CANONICAL_HOST, "jetsfix.com"]);

export function isProduction(url: URL): boolean {
	return PRODUCTION_HOSTS.has(url.hostname);
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
