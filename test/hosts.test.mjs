import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalRedirect, isProduction, legacyPostUrl } from "../src/utils/hosts.ts";

const r = (u) => canonicalRedirect(new URL(u));

test("old Ghost URLs 301 to https://www with path and query intact", () => {
	assert.equal(r("http://www.jetsfix.com/some-post/"), "https://www.jetsfix.com/some-post/");
	assert.equal(r("http://jetsfix.com/some-post/?a=1#x"), "https://www.jetsfix.com/some-post/?a=1#x");
	assert.equal(r("https://jetsfix.com/rss/"), "https://www.jetsfix.com/rss/");
});

test("canonical production URL is served as-is", () => {
	assert.equal(r("https://www.jetsfix.com/some-post/"), null);
});

test("preview mirrors production: bare domain and http go to https://www", () => {
	assert.equal(r("https://jetsfix-preview.com/p/"), "https://www.jetsfix-preview.com/p/");
	assert.equal(r("http://www.jetsfix-preview.com/p/"), "https://www.jetsfix-preview.com/p/");
	assert.equal(r("https://www.jetsfix-preview.com/p/"), null);
});

test("unknown hosts are left alone", () => {
	assert.equal(r("http://localhost:4321/p/"), null);
	assert.equal(r("https://jetsfix.marcus.workers.dev/p/"), null);
});

test("only production is production", () => {
	assert.equal(isProduction(new URL("https://www.jetsfix.com/")), true);
	assert.equal(isProduction(new URL("https://www.jetsfix-preview.com/")), false);
});

test("Disqus thread key stays the old http URL", () => {
	assert.equal(legacyPostUrl("abc"), "http://www.jetsfix.com/abc/");
});
