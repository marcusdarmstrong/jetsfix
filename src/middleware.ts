import { defineMiddleware } from "astro:middleware";

import { CANONICAL_HOST, isProduction } from "./utils/hosts";

/**
 * Host policy.
 *
 * Production (after cutover): Ghost served http://www.jetsfix.com/<slug>/ —
 * plain HTTP, www canonical, with jetsfix.com 301ing to www. Every one of
 * those URLs must keep working, so we 301 http -> https and the apex -> www,
 * preserving path and query. The certificate is Cloudflare-managed and
 * renews automatically.
 *
 * Everything else (jetsfix-preview.com, *.workers.dev, localhost) is a copy of
 * the production content and is kept out of search indexes so it can't
 * compete with jetsfix.com as duplicate content.
 */
export const onRequest = defineMiddleware(async (context, next) => {
	const url = context.url;

	if (isProduction(url)) {
		if (url.protocol === "http:" || url.hostname !== CANONICAL_HOST) {
			const target = new URL(url);
			target.protocol = "https:";
			target.hostname = CANONICAL_HOST;
			target.port = "";
			return context.redirect(target.href, 301);
		}
		return next();
	}

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
