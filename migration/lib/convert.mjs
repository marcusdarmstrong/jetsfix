/**
 * Ghost 0.11 post HTML -> EmDash Portable Text.
 *
 * Prose goes through EmDash's own HTML converter
 * (@emdash-cms/gutenberg-to-portable-text). Third-party embeds are pulled out
 * first, because that converter (and EmDash's sanitizer) would otherwise drop
 * their <iframe>/<script> tags:
 *
 *   tweets (blockquote.twitter-tweet)  -> htmlBlock, rendered verbatim
 *   giphy iframes                      -> plain image block (the GIF itself)
 *   youtube iframes                    -> native EmDash embed block
 *   anything else with iframe/script   -> htmlBlock, rendered verbatim
 *
 * "Rendered verbatim" htmlBlocks start with `<div data-ghost-embed="…">`; see
 * src/components/LegacyHtmlBlock.astro.
 */
import { htmlToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { parseFragment, serialize, serializeOuter } from "parse5";

const SITE_HOSTS = new Set(["jetsfix.com", "www.jetsfix.com"]);
const GIPHY_EMBED = /^(?:https?:)?\/\/(?:www\.)?giphy\.com\/embed\/([A-Za-z0-9]+)/;
const YOUTUBE_EMBED =
	/^(?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/;
const TWITTER_WIDGETS = /platform\.(?:twitter|x)\.com\/widgets\.js/;
const TWITTER_WIDGETS_SCRIPT =
	'<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>';

// Wrapper elements we dissolve when they contain an embed, so the embed can
// become its own block and the surrounding text stays real Portable Text.
const DISSOLVABLE = new Set(["p", "span", "center", "section", "article", "font"]);

const isElement = (n) => n && typeof n.tagName === "string";
const attr = (n, name) => n.attrs?.find((a) => a.name === name)?.value;
const hasClass = (n, cls) => (attr(n, "class") ?? "").split(/\s+/).includes(cls);

function walk(node, fn) {
	fn(node);
	for (const c of node.childNodes ?? []) walk(c, fn);
	if (node.content) walk(node.content, fn); // <template>
}

function findAll(node, pred) {
	const out = [];
	walk(node, (n) => {
		if (isElement(n) && pred(n)) out.push(n);
	});
	return out;
}

const isTweet = (n) => n.tagName === "blockquote" && hasClass(n, "twitter-tweet");
const isEmbedish = (n) =>
	n.tagName === "iframe" ||
	n.tagName === "script" ||
	n.tagName === "object" ||
	n.tagName === "embed" ||
	isTweet(n) ||
	(n.tagName === "blockquote" &&
		(hasClass(n, "imgur-embed-pub") || hasClass(n, "instagram-media")));

const containsEmbed = (n) => isEmbedish(n) || findAll(n, isEmbedish).length > 0;

/** Rewrite links to jetsfix.com into site-relative paths (keeps URLs host-agnostic). */
function relativizeLinks(root, stats) {
	walk(root, (n) => {
		if (!isElement(n) || n.tagName !== "a") return;
		const href = n.attrs.find((a) => a.name === "href");
		if (!href) return;
		try {
			const u = new URL(href.value, "https://jetsfix.com");
			if (/^https?:$/.test(u.protocol) && SITE_HOSTS.has(u.hostname) && /^(https?:)?\/\//.test(href.value)) {
				href.value = `${u.pathname}${u.search}${u.hash}`;
				stats.relativizedLinks++;
			}
		} catch {
			/* leave malformed hrefs alone */
		}
	});
}

/** Drop <img> with no usable src (Ghost has a few `<img src "">`). */
function dropEmptyImages(root, stats) {
	walk(root, (n) => {
		if (!n.childNodes) return;
		n.childNodes = n.childNodes.filter((c) => {
			if (isElement(c) && c.tagName === "img") {
				const src = (attr(c, "src") ?? "").trim();
				if (!src || src === '""') {
					stats.droppedEmptyImages++;
					return false;
				}
			}
			return true;
		});
	});
}

let keyCounter = 0;
const key = () => `g${(++keyCounter).toString(36)}`;

function legacyHtml(kind, html) {
	return {
		_type: "htmlBlock",
		_key: key(),
		html: `<div data-ghost-embed="${kind}">${html}</div>`,
	};
}

/**
 * Convert one embed-bearing element to blocks. Returns null if the element is
 * a wrapper we should dissolve instead.
 */
function embedToBlocks(n, stats) {
	if (n.tagName === "iframe") {
		const src = attr(n, "src") ?? "";
		const giphy = src.match(GIPHY_EMBED);
		if (giphy) {
			stats.embeds.giphy++;
			return [
				{
					_type: "image",
					_key: key(),
					asset: {
						_type: "reference",
						_ref: `https://media.giphy.com/media/${giphy[1]}/giphy.gif`,
						url: `https://media.giphy.com/media/${giphy[1]}/giphy.gif`,
					},
					alt: "GIF via GIPHY",
				},
			];
		}
		const yt = src.match(YOUTUBE_EMBED);
		if (yt) {
			stats.embeds.youtube++;
			return [
				{
					_type: "embed",
					_key: key(),
					url: `https://www.youtube.com/watch?v=${yt[1]}`,
					provider: "youtube",
				},
			];
		}
		stats.embeds.iframe++;
		stats.iframeHosts[hostOf(src)] = (stats.iframeHosts[hostOf(src)] ?? 0) + 1;
		return [legacyHtml("iframe", serializeOuter(n))];
	}
	if (isTweet(n)) {
		stats.embeds.tweet++;
		return [legacyHtml("twitter", serializeOuter(n) + TWITTER_WIDGETS_SCRIPT)];
	}
	if (n.tagName === "script") {
		const src = attr(n, "src") ?? "";
		// Tweet blocks carry their own widgets.js; the copies Ghost posts had
		// after each tweet are redundant.
		if (TWITTER_WIDGETS.test(src)) {
			stats.embeds.droppedTwitterScript++;
			return [];
		}
		stats.embeds.script++;
		return [legacyHtml("script", serializeOuter(n))];
	}
	if (isEmbedish(n)) {
		stats.embeds.other++;
		return [legacyHtml(n.tagName, serializeOuter(n))];
	}
	// A container (div.strawpoll-embed, div.rif-giphy, …) holding an embed.
	if (!DISSOLVABLE.has(n.tagName)) {
		// Giphy wrapper divs: unwrap so the iframe becomes an image.
		const iframes = findAll(n, (c) => c.tagName === "iframe");
		const onlyGiphy =
			iframes.length > 0 &&
			iframes.every((f) => GIPHY_EMBED.test(attr(f, "src") ?? "")) &&
			findAll(n, (c) => c.tagName === "script").length === 0;
		if (onlyGiphy) return null;
		stats.embeds.container++;
		return [legacyHtml(n.tagName, serializeOuter(n))];
	}
	return null;
}

function hostOf(src) {
	try {
		return new URL(src, "https://jetsfix.com").hostname;
	} catch {
		return "(invalid)";
	}
}

/**
 * Convert Ghost HTML to Portable Text.
 * @returns {{ blocks: object[], stats: object }}
 */
export function convertHtml(html, stats = newStats()) {
	const root = parseFragment(html ?? "");
	relativizeLinks(root, stats);
	dropEmptyImages(root, stats);

	const blocks = [];
	let prose = "";
	const flush = () => {
		if (prose.trim()) {
			for (const b of htmlToPortableText(prose, { keyGenerator: key })) blocks.push(b);
		}
		prose = "";
	};

	// Top level: script-driven embeds (poll-maker, quizzes, imgur, …) find their
	// markup in the DOM, so a script and the elements it scans must stay raw
	// together. Ghost's markdown renderer often split one pasted snippet over
	// several <p>s, so merge from the snippet's opening element up to the
	// element holding its <script>.
	const top = root.childNodes;
	for (let i = 0; i < top.length; i++) {
		const n = top[i];
		if (!isElement(n)) {
			prose += serializeOuter(n);
			continue;
		}
		if (opensScriptedEmbed(n) || containsVendorScript(n)) {
			// Prefer ending at the snippet's external loader (<script src>);
			// inline helper scripts can appear earlier in the same snippet.
			let j = -1;
			if (opensScriptedEmbed(n)) {
				for (let k = i; k < top.length && k - i < 80; k++) {
					if (k > i && opensScriptedEmbed(top[k])) break;
					if (containsVendorScript(top[k], true)) {
						j = k;
						break;
					}
				}
			}
			if (j === -1) {
				j = i;
				while (j < top.length && j - i < 80 && !containsVendorScript(top[j])) j++;
			}
			if (j < top.length && containsVendorScript(top[j])) {
				flush();
				const raw = top.slice(i, j + 1).map((x) => serializeOuter(x)).join("");
				blocks.push(legacyHtml("scripted", raw));
				stats.embeds.scripted++;
				i = j;
				continue;
			}
		}
		visit([n]);
	}
	flush();

	return finish(blocks, stats);

	function visit(nodes) {
		for (const n of nodes) {
			if (!isElement(n) || !containsEmbed(n)) {
				// parse5 re-serializes with normalized attributes (`src="x"`
				// instead of Ghost's `src = "x"`), which the converter needs.
				prose += serializeOuter(n);
				continue;
			}
			const out = embedToBlocks(n, stats);
			if (out) {
				flush();
				blocks.push(...out);
			} else {
				// Dissolve the wrapper: emit its children in its place, keeping
				// the wrapper's own text in a same-tag element.
				const tag = n.tagName;
				const kids = n.childNodes;
				let run = [];
				const flushRun = () => {
					if (run.some((c) => isElement(c) || (c.value ?? "").trim())) {
						const shell = { ...n, childNodes: run };
						prose += DISSOLVABLE.has(tag) ? `<${tag}>${serialize(shell)}</${tag}>` : serialize(shell);
					}
					run = [];
				};
				for (const c of kids) {
					if (isElement(c) && containsEmbed(c)) {
						flushRun();
						visit([c]);
					} else run.push(c);
				}
				flushRun();
			}
		}
	}
}

/** A <script> other than Twitter's widgets.js (which tweet blocks re-add). */
function containsVendorScript(n, externalOnly = false) {
	if (!isElement(n)) return false;
	const isVendor = (s) =>
		s.tagName === "script" &&
		!TWITTER_WIDGETS.test(attr(s, "src") ?? "") &&
		(!externalOnly || !!attr(s, "src"));
	return isVendor(n) || findAll(n, isVendor).length > 0;
}

/** Markup that a following vendor script will scan the DOM for. */
function opensScriptedEmbed(n) {
	const opener = (e) =>
		e.tagName === "style" ||
		(attr(e, "id") ?? "").startsWith("qp_") ||
		attr(e, "data-poll") !== undefined ||
		attr(e, "data-quiz") !== undefined ||
		(e.tagName === "blockquote" &&
			(hasClass(e, "imgur-embed-pub") || hasClass(e, "instagram-media")));
	return opener(n) || findAll(n, opener).length > 0;
}

function finish(blocks, stats) {
	// Drop empty paragraphs left behind by dissolved wrappers.
	const cleaned = blocks.filter(
		(b) =>
			!(
				b._type === "block" &&
				!b.listItem &&
				(b.children ?? []).every((c) => c._type === "span" && !c.text?.trim())
			),
	);
	for (const b of cleaned) stats.blockTypes[b._type] = (stats.blockTypes[b._type] ?? 0) + 1;
	return { blocks: cleaned, stats };
}

export function newStats() {
	return {
		relativizedLinks: 0,
		droppedEmptyImages: 0,
		embeds: {
			tweet: 0,
			giphy: 0,
			youtube: 0,
			iframe: 0,
			script: 0,
			container: 0,
			scripted: 0,
			other: 0,
			droppedTwitterScript: 0,
		},
		iframeHosts: {},
		blockTypes: {},
	};
}
