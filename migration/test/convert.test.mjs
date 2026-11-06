import assert from "node:assert/strict";
import { test } from "node:test";

import { convertHtml } from "../lib/convert.mjs";
import { ghostDate } from "../lib/ghost.mjs";

const types = (blocks) => blocks.map((b) => b._type);
const legacy = (blocks) => blocks.filter((b) => b._type === "htmlBlock").map((b) => b.html);
const text = (blocks) =>
	blocks
		.filter((b) => b._type === "block")
		.map((b) => b.children.map((c) => c.text).join(""))
		.join("\n");

test("prose with Ghost's spaced attributes keeps links and images", () => {
	const { blocks } = convertHtml(
		`<p>Via SNY, <a href = "https://sny.tv/x" target="_blank">an article</a>.</p>\n<p><img src = "https://pbs.twimg.com/media/a.jpg"></p>`,
	);
	assert.deepEqual(types(blocks), ["block", "image"]);
	assert.equal(blocks[0].markDefs[0].href, "https://sny.tv/x");
	assert.equal(blocks[1].asset.url, "https://pbs.twimg.com/media/a.jpg");
});

test("links to jetsfix.com become site-relative, preserving the old path", () => {
	const { blocks } = convertHtml(
		`<p><a href="http://www.jetsfix.com/some-post/">a</a> <a href="https://jetsfix.com/other/#c">b</a> <a href="https://example.com/x">c</a></p>`,
	);
	assert.deepEqual(
		blocks[0].markDefs.map((m) => m.href),
		["/some-post/", "/other/#c", "https://example.com/x"],
	);
});

test("empty <img src \"\"> is dropped", () => {
	const { blocks, stats } = convertHtml(`<p>before</p><p><img src ""></p><p>after</p>`);
	assert.deepEqual(types(blocks), ["block", "block"]);
	assert.equal(stats.droppedEmptyImages, 1);
});

test("tweet becomes a verbatim embed with one widgets.js; trailing script dropped", () => {
	const { blocks } = convertHtml(
		`<p>Moves:</p>\n<blockquote class="twitter-tweet"><p lang="en">Signed X</p>&mdash; Jets (@nyjets) <a href="https://x.com/nyjets/status/1">Nov 4</a></blockquote>\n<script async src="https://platform.x.com/widgets.js" charset="utf-8"></script>\n<p>More.</p>`,
	);
	assert.deepEqual(types(blocks), ["block", "htmlBlock", "block"]);
	const [html] = legacy(blocks);
	assert.match(html, /^<div data-ghost-embed="twitter"><blockquote class="twitter-tweet">/);
	assert.equal(html.match(/widgets\.js/g).length, 1);
});

test("giphy iframe (wrapped in <p><div>) becomes a GIF image; attribution kept", () => {
	const { blocks } = convertHtml(
		`<p><div class="rif rif-giphy"><iframe src="https://giphy.com/embed/VEo00zXv3o2M7xQrCU" frameBorder="0" class="giphy-embed" allowFullScreen></iframe></div><p><a href="https://giphy.com/gifs/VEo00zXv3o2M7xQrCU">via GIPHY</a></p></p>`,
	);
	const img = blocks.find((b) => b._type === "image");
	assert.equal(img.asset.url, "https://media.giphy.com/media/VEo00zXv3o2M7xQrCU/giphy.gif");
	assert.match(text(blocks), /via GIPHY/);
	assert.equal(legacy(blocks).length, 0);
});

test("youtube iframe becomes a native embed block", () => {
	const { blocks } = convertHtml(
		`<p>Take it away</p><iframe width="560" height="315" src="https://www.youtube.com/embed/17lkdqoLt44" frameborder="0" allowfullscreen></iframe>`,
	);
	assert.deepEqual(blocks[1], {
		_type: "embed",
		_key: blocks[1]._key,
		url: "https://www.youtube.com/watch?v=17lkdqoLt44",
		provider: "youtube",
	});
});

test("strawpoll container keeps iframe and loader script together", () => {
	const { blocks } = convertHtml(
		`<div class="strawpoll-embed" id="strawpoll_e2n"><iframe src="https://strawpoll.com/embed/e2n">Loading...</iframe><script async src="https://cdn.strawpoll.com/dist/widgets.js" charset="utf-8"></script></div>`,
	);
	assert.equal(blocks.length, 1);
	assert.match(blocks[0].html, /strawpoll\.com\/embed\/e2n.*cdn\.strawpoll\.com/s);
});

test("poll-maker snippet split across <p>s by markdown is merged into one block", () => {
	const { blocks } = convertHtml(
		`<p>Intro.</p>
<div id="qp_all1" style="width:100%"><style>#content{padding:5%}</style><div id="qp_main1"><script>window.x=1</script></div>
<p>stray</p>
<div style="text-align:center">Created with <a id="qp_foot1" href="https://www.survey-maker.com/p1">SiteListener</a></div></div><script src="//scripts.poll-maker.com/3012/scpolls.js" language="javascript"></script>
<p>Don't forget to vote.</p>`,
	);
	assert.deepEqual(types(blocks), ["block", "htmlBlock", "block"]);
	const [html] = legacy(blocks);
	assert.match(html, /qp_all1.*qp_foot1.*scpolls\.js/s);
	assert.equal(text(blocks), "Intro.\nDon't forget to vote.");
});

test("poll-maker inline loader keeps its data-poll anchor", () => {
	const { blocks } = convertHtml(
		`<p><script>(function(){/*loader*/})()</script><a href='https://www.supersurvey.com/-ES-' data-poll='5189839x' style='width:100%'>SuperSurvey</a></p>`,
	);
	assert.equal(blocks.length, 1);
	assert.match(blocks[0].html, /data-poll="5189839x"/);
});

test("imgur blockquote + script stay together", () => {
	const { blocks } = convertHtml(
		`<p><blockquote class="imgur-embed-pub" lang="en" data-id="a/kbs"><a href="//imgur.com/a/kbs"></a></blockquote><script async src="//s.imgur.com/min/embed.js" charset="utf-8"></script></p>`,
	);
	const html = legacy(blocks).join("");
	assert.match(html, /imgur-embed-pub.*s\.imgur\.com\/min\/embed\.js/s);
	assert.equal(legacy(blocks).length, 1);
});

test("Ghost dates are UTC", () => {
	assert.equal(ghostDate("2017-04-19 16:00:00"), "2017-04-19T16:00:00.000Z");
	assert.equal(ghostDate(1492617600000), "2017-04-19T16:00:00.000Z");
	assert.equal(ghostDate(null), null);
});
