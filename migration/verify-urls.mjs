#!/usr/bin/env node
/**
 * URL-compatibility check: every URL the Ghost site served must still work.
 *
 *   node migration/verify-urls.mjs --base https://www.jetsfix-preview.com \
 *        [--urls migration/out/urls.txt] [--sitemap http://www.jetsfix.com/sitemap.xml]
 *
 * --urls     paths from `ghost-to-emdash.mjs convert` (every published post)
 * --sitemap  also pull every <loc> from the live Ghost sitemap (index or
 *            urlset), so authors/pages/tags Google knows about are covered
 *
 * A URL passes if it returns 200, or redirects (301/308) to something that
 * returns 200. Exit code 1 if anything fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		base: { type: "string" },
		urls: { type: "string" },
		sitemap: { type: "string" },
		concurrency: { type: "string", default: "16" },
		out: { type: "string", default: "verify-failures.json" },
	},
});
if (!args.base) throw new Error("--base <new site origin> is required");
const base = args.base.replace(/\/$/, "");

const paths = new Set();
if (args.urls) {
	for (const line of readFileSync(args.urls, "utf8").split("\n")) if (line.trim()) paths.add(line.trim());
}
if (args.sitemap) {
	for (const loc of await sitemapLocs(args.sitemap)) {
		const u = new URL(loc);
		paths.add(u.pathname + u.search);
	}
}
if (!paths.size) throw new Error("nothing to check: pass --urls and/or --sitemap");

async function sitemapLocs(url, depth = 0) {
	const xml = await (await fetch(url)).text();
	const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
	if (/<sitemapindex/.test(xml) && depth < 2) {
		return (await Promise.all(locs.map((l) => sitemapLocs(l, depth + 1)))).flat();
	}
	return locs;
}

async function check(path) {
	let url = base + path;
	const hops = [];
	for (let i = 0; i < 5; i++) {
		const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "jetsfix-url-verify" } });
		hops.push(`${res.status} ${new URL(url).pathname}`);
		await res.body?.cancel();
		if (res.status === 200) return { ok: true, hops };
		if ([301, 308].includes(res.status)) {
			url = new URL(res.headers.get("location"), url).href;
			continue;
		}
		return { ok: false, hops };
	}
	return { ok: false, hops: [...hops, "too many redirects"] };
}

const queue = [...paths];
const failures = [];
const counts = { direct: 0, redirected: 0 };
let done = 0;
await Promise.all(
	Array.from({ length: Number(args.concurrency) }, async () => {
		for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
			let r;
			try {
				r = await check(p);
			} catch (err) {
				r = { ok: false, hops: [String(err)] };
			}
			if (!r.ok) failures.push({ path: p, hops: r.hops });
			else counts[r.hops.length === 1 ? "direct" : "redirected"]++;
			if (++done % 1000 === 0) console.log(`  ${done}/${paths.size} checked, ${failures.length} failing`);
		}
	}),
);

writeFileSync(args.out, JSON.stringify(failures, null, 2) + "\n");
console.log(
	`${paths.size} URLs: ${counts.direct} served directly, ${counts.redirected} via redirect, ${failures.length} FAILED`,
);
for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f.path}  [${f.hops.join(" -> ")}]`);
if (failures.length) {
	console.log(`full list in ${args.out}`);
	process.exitCode = 1;
}
