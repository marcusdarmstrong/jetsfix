/**
 * Read posts out of a Ghost 0.11 SQLite database (schema version 009).
 * Uses Node's built-in node:sqlite — no native addons.
 */
import { DatabaseSync } from "node:sqlite";

/** Ghost stores UTC datetimes as "YYYY-MM-DD HH:MM:SS" text (or epoch ms). */
export function ghostDate(v) {
	if (v === null || v === undefined || v === "") return null;
	if (typeof v === "number") return new Date(v).toISOString();
	const s = String(v).trim();
	if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString();
	const iso = s.includes("T") ? s : s.replace(" ", "T");
	const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
	if (Number.isNaN(d.getTime())) throw new Error(`Unparseable Ghost date: ${v}`);
	return d.toISOString();
}

export function readGhost(dbPath) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const version = db
			.prepare("select value from settings where key = 'databaseVersion'")
			.get()?.value;
		if (version !== "009") {
			console.warn(`warning: expected Ghost databaseVersion 009 (0.11.x), got ${version}`);
		}
		const settings = Object.fromEntries(
			db
				.prepare("select key, value from settings")
				.all()
				.map((r) => [r.key, r.value]),
		);
		const users = db.prepare("select id, name, slug, email from users").all();
		const tags = db.prepare("select id, name, slug from tags").all();
		const postTags = db.prepare("select post_id, tag_id from posts_tags order by sort_order").all();
		const posts = db
			.prepare(
				`select id, uuid, title, slug, html, image, featured, page, status, visibility,
				        meta_title, meta_description, author_id,
				        created_at, updated_at, published_at
				   from posts order by id`,
			)
			.all();
		return { version, settings, users, tags, postTags, posts };
	} finally {
		db.close();
	}
}
