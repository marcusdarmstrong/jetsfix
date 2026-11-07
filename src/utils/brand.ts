/**
 * JetsFix branding carried over from the Ghost (Casper) theme.
 *
 * Images stay where Ghost had them: the logo is ours (served from
 * public/logo.png), the header photo and author avatars are hotlinks, exactly
 * as on the old site.
 */

/** Ghost's /content/images/2017/04/icon.png, now public/logo.png. */
export const LOGO = { src: "/logo.png", width: 38, height: 41 };

/** Ghost's blog cover: the full-width photo behind the homepage title. */
export const HERO_IMAGE =
	"https://static.clubs.nfl.com/image/private/t_editorial_landscape_12_desktop/jets/c6kbhvviiituc1u5arx1";

/** Ghost user profile images, keyed by byline slug (= Ghost user slug). */
export const AUTHOR_AVATARS: Record<string, string> = {
	site: "https://pbs.twimg.com/profile_images/854380206903238656/bsbNxOf0_bigger.jpg",
	brian: "https://www.gravatar.com/avatar/5e36316489fccb4159ec8e15299b9814?s=250&d=mm&r=x",
};

export const TWITTER_HANDLE = "jetsfix";

/** The Ghost theme's footer line. */
export function footerCredit(year: number): string {
	return `JetsFix © ${year}, some images © the New York Jets ${year}`;
}

interface PtSpan {
	_type?: string;
	text?: string;
}
interface PtBlock {
	_type?: string;
	children?: PtSpan[];
}

/**
 * Ghost-style automatic excerpt: the first `words` words of the post's text.
 * Used when a post has no hand-written excerpt (none of the imported ones do).
 */
export function autoExcerpt(content: unknown, words = 33): string {
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content as PtBlock[]) {
		if (block?._type !== "block" || !Array.isArray(block.children)) continue;
		// Join a block's spans first: a link or bold run is its own span, and
		// "JetsFix.com" + "." must not become "JetsFix.com .".
		const text = block.children.map((s) => (typeof s?.text === "string" ? s.text : "")).join("");
		for (const w of text.split(/\s+/)) {
			if (!w) continue;
			out.push(w);
			if (out.length >= words) return `${out.join(" ")}…`;
		}
	}
	return out.join(" ");
}
