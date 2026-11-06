import { defineMiddleware } from "astro:middleware";

import { canonicalRedirect, siteFor } from "./utils/hosts";

/**
 * Host policy (see src/utils/hosts.ts).
 *
 * Ghost served http://www.jetsfix.com/<slug>/ — plain HTTP, www canonical,
 * with jetsfix.com 301ing to www. Every one of those URLs must keep working,
 * so known sites 301 http -> https and the bare domain -> www, preserving
 * path and query. Certificates are Cloudflare-managed and renew
 * automatically. jetsfix-preview.com follows the same shape.
 *
 * Anything not indexable (the preview, *.workers.dev, localhost) is a copy of
 * the production content and is kept out of search indexes so it can't
 * compete with jetsfix.com as duplicate content.
 */
export const onRequest = defineMiddleware(async (context, next) => {
	const url = context.url;
	const redirect = canonicalRedirect(url);
	if (redirect) return context.redirect(redirect, 301);

	const site = siteFor(url.hostname);

	if (site?.indexable) return next();

	if (url.pathname === "/robots.txt") {
		return new Response("User-agent: *\nDisallow: /\n", {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}

	const response = await next();
	const headers = new Headers(response.headers);
	headers.set("X-Robots-Tag", "noindex, nofollow");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
});
