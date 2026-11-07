#!/usr/bin/env node
/**
 * Ghost 0.11 (SQLite) -> EmDash migration.
 *
 *   node migration/ghost-to-emdash.mjs convert --db ghost.db [--out migration/out]
 *   node migration/ghost-to-emdash.mjs import  --url http://localhost:4321 [--out migration/out]
 *
 * `convert` is offline and deterministic: it writes posts.ndjson (one EmDash
 * create payload per Ghost post), bylines.json (Ghost authors), urls.txt
 * (every public URL on the old site, for verify-urls.mjs) and report.json
 * (embed/block statistics).
 *
 * `import` pushes posts.ndjson into a running EmDash site through its REST
 * API, keeping slugs, publish dates, bylines and draft/scheduled status.
 * It skips slugs that already exist, so an interrupted run can simply be
 * re-run. Entries whose Ghost status changed (e.g. a draft published since)
 * get their content resent with Ghost's publish date.
 *
 * --changed-since <ISO>  also resend content for posts Ghost modified after
 *                        that time (use the time of the previous Ghost
 *                        snapshot). Overwrites edits made to those posts in
 *                        EmDash since the import.
 *
 * Auth: EMDASH_TOKEN (an admin API token) for remote sites; localhost dev
 * servers use EmDash's dev bypass automatically.
 */
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { convertHtml, newStats } from "./lib/convert.mjs";
import { ghostDate, readGhost } from "./lib/ghost.mjs";

/** The old Ghost box: http only, canonical host www. */
const LEGACY_ORIGIN = "http://www.jetsfix.com";

const { positionals, values: args } = parseArgs({
	allowPositionals: true,
	options: {
		db: { type: "string" },
		out: { type: "string", default: "migration/out" },
		url: { type: "string" },
		token: { type: "string" },
		concurrency: { type: "string", default: "6" },
		limit: { type: "string" },
		only: { type: "string", multiple: true },
		"dry-run": { type: "boolean", default: false },
		"changed-since": { type: "string" },
	},
});

const command = positionals[0];
if (command === "convert") await convert();
else if (command === "import") await importPosts();
else {
	console.error("usage: ghost-to-emdash.mjs <convert|import> [options]  (see file header)");
	process.exit(2);
}

// ---------------------------------------------------------------------------

async function convert() {
	if (!args.db) throw new Error("--db <path to ghost.db> is required");
	const ghost = readGhost(args.db);
	const userSlug = new Map(ghost.users.map((u) => [u.id, u.slug]));
	const tagById = new Map(ghost.tags.map((t) => [t.id, t]));
	const tagsByPost = new Map();
	for (const pt of ghost.postTags) {
		const t = tagById.get(pt.tag_id);
		if (!t) continue;
		if (!tagsByPost.has(pt.post_id)) tagsByPost.set(pt.post_id, []);
		tagsByPost.get(pt.post_id).push(t.slug);
	}

	const stats = newStats();
	const problems = [];
	const lines = [];
	const urls = new Set(["/", "/rss/"]);
	const slugs = new Set();
	const statusCounts = {};

	for (const p of ghost.posts) {
		if (slugs.has(p.slug)) problems.push(`duplicate slug ${p.slug}`);
		slugs.add(p.slug);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)) problems.push(`unusual slug ${p.slug}`);

		const { blocks } = convertHtml(p.html ?? "", stats);
		if (blocks.length === 0 && (p.html ?? "").trim()) {
			problems.push(`post ${p.id} (${p.slug}) converted to zero blocks`);
		}

		const status =
			p.status === "published" ? "published" : p.status === "scheduled" ? "scheduled" : "draft";
		statusCounts[status] = (statusCounts[status] ?? 0) + 1;
		const publishedAt = ghostDate(p.published_at);
		if (status === "published") urls.add(`/${p.slug}/`);

		const data = {
			title: p.title,
			content: blocks,
			ghost_id: p.id,
		};
		if (p.image) {
			// Ghost stores uploads as relative /content/images/... paths. The
			// old box only speaks http on www; `import` copies these into R2.
			data.featured_image = {
				src: p.image.startsWith("/") ? `${LEGACY_ORIGIN}${p.image}` : p.image,
				alt: p.title,
			};
		}

		lines.push(
			JSON.stringify({
				ghostId: p.id,
				collection: p.page ? "pages" : "posts",
				slug: p.slug,
				status,
				publishedAt,
				createdAt: ghostDate(p.created_at),
				updatedAt: ghostDate(p.updated_at),
				byline: userSlug.get(p.author_id) ?? null,
				tags: tagsByPost.get(p.id) ?? [],
				seo:
					p.meta_title || p.meta_description
						? { title: p.meta_title ?? undefined, description: p.meta_description ?? undefined }
						: undefined,
				data,
			}),
		);
	}

	mkdirSync(args.out, { recursive: true });
	writeFileSync(join(args.out, "posts.ndjson"), lines.join("\n") + "\n");
	writeFileSync(join(args.out, "urls.txt"), [...urls].join("\n") + "\n");
	const bylines = ghost.users.map((u) => ({ slug: u.slug, displayName: u.name }));
	writeFileSync(join(args.out, "bylines.json"), JSON.stringify(bylines, null, 2) + "\n");
	const report = {
		ghostVersion: ghost.version,
		posts: ghost.posts.length,
		statusCounts,
		publicUrls: urls.size,
		...stats,
		problems,
	};
	writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report, null, 2));
	if (problems.length) process.exitCode = 1;
}

// ---------------------------------------------------------------------------

async function importPosts() {
	if (!args.url) throw new Error("--url <EmDash site origin> is required");
	const { EmDashClient } = await import("emdash/client");
	const token = args.token ?? process.env.EMDASH_TOKEN;
	const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(args.url);
	if (!token && !isLocal) throw new Error("set EMDASH_TOKEN (admin API token) for remote imports");
	const client = new EmDashClient({ baseUrl: args.url, token, devBypass: !token && isLocal });
	// The typed client has no byline helpers; its request() is TS-private only.
	const api = (method, path, body) => client.request(method, path, body);

	// Ghost authors -> EmDash bylines (created here: seed bylines only apply
	// alongside seed sample content). Map Ghost user slug -> byline id.
	const listBylines = async () => {
		const res = await api("GET", "/admin/bylines?limit=100");
		return Array.isArray(res) ? res : (res.items ?? []);
	};
	const bylineIds = new Map((await listBylines()).map((b) => [b.slug, b.id]));
	const wanted = JSON.parse(readFileSync(join(args.out, "bylines.json"), "utf8"));
	for (const b of wanted) {
		if (bylineIds.has(b.slug) || args["dry-run"]) continue;
		const created = await api("POST", "/admin/bylines", b);
		bylineIds.set(b.slug, created.id ?? created.item?.id ?? created.byline?.id);
		console.log(`created byline ${b.slug} (${b.displayName})`);
	}

	// slug -> { id, status } for everything already on the target, so a re-run
	// finishes half-done entries (created but not yet published) instead of
	// skipping or duplicating them.
	const existing = new Map();
	for (const collection of ["posts", "pages"]) {
		for await (const item of client.listAll(collection, { limit: 100 })) {
			existing.set(`${collection}/${item.slug}`, { id: item.id, status: item.status });
		}
	}
	console.log(`target already has ${existing.size} entries`);

	const changedSince = args["changed-since"] ? Date.parse(args["changed-since"]) : null;
	if (args["changed-since"] && Number.isNaN(changedSince)) {
		throw new Error(`--changed-since must be an ISO timestamp, got ${args["changed-since"]}`);
	}

	const todo = [];
	const rl = createInterface({ input: createReadStream(join(args.out, "posts.ndjson")) });
	for await (const line of rl) {
		if (!line.trim()) continue;
		const post = JSON.parse(line);
		if (args.only?.length && !args.only.includes(post.slug)) continue;
		const have = existing.get(`${post.collection}/${post.slug}`);
		// Edited in Ghost after the last import: resend its content.
		const changed = !!(have && changedSince && post.updatedAt && Date.parse(post.updatedAt) > changedSince);
		if (have && have.status === post.status && !changed) continue; // already done
		todo.push({ post, have, update: changed || (have && have.status !== post.status) });
	}
	if (args.limit) todo.splice(Number(args.limit));
	const updates = todo.filter((j) => j.update).length;
	console.log(
		`importing ${todo.length} entries (${todo.length - updates} new, ${updates} updated) with concurrency ${args.concurrency}`,
	);
	if (args["dry-run"]) return;

	const ctx = { client, api, bylineIds, mediaCache: new Map() };
	const failures = [];
	let done = 0;
	const started = Date.now();
	const worker = async () => {
		for (let job = todo.shift(); job; job = todo.shift()) {
			try {
				await withRetry(() => importOne(ctx, job));
			} catch (err) {
				failures.push({ slug: job.post.slug, ghostId: job.post.ghostId, error: String(err?.message ?? err) });
			}
			if (++done % 250 === 0) {
				const rate = done / ((Date.now() - started) / 1000);
				console.log(`  ${done} done (${rate.toFixed(1)}/s), ${failures.length} failed`);
			}
		}
	};
	await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

	writeFileSync(join(args.out, "import-failures.json"), JSON.stringify(failures, null, 2) + "\n");
	console.log(`finished: ${done - failures.length} imported, ${failures.length} failed`);
	if (failures.length) {
		console.log(`see ${join(args.out, "import-failures.json")}; re-run to retry`);
		process.exitCode = 1;
	}
}

async function withRetry(fn, attempts = 5) {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			const status = err?.status ?? err?.statusCode;
			const permanent = status && status >= 400 && status < 500 && status !== 408 && status !== 429;
			if (permanent || i >= attempts) throw err;
			await new Promise((r) => setTimeout(r, 500 * 2 ** i));
		}
	}
}

async function importOne(ctx, job) {
	const { client, api, bylineIds } = ctx;
	const { post } = job;

	const bylineId = post.byline ? bylineIds.get(post.byline) : undefined;
	const buildData = async () => {
		const data =
			post.collection === "posts" ? { ...post.data } : { title: post.data.title, content: post.data.content };
		if (data.featured_image) data.featured_image = await localizeImage(ctx, data.featured_image);
		return data;
	};

	// Step 1: create (or find the entry a previous/failed attempt created).
	let item = job.have;
	if (item && job.update) {
		// Existing entry whose Ghost copy changed (edited, or published since
		// the last import): resend content and Ghost's publish date.
		// Raw PUT: the typed client's update() drops bylines and publishedAt.
		const res = await api(
			"PUT",
			`/content/${encodeURIComponent(post.collection)}/${encodeURIComponent(item.id)}`,
			{
				data: await buildData(),
				...(bylineId ? { bylines: [{ bylineId }] } : {}),
				...(post.status === "published" && post.publishedAt ? { publishedAt: post.publishedAt } : {}),
				overrideLock: true,
			},
		);
		item = res.item ?? res;
		job.update = false; // retries resume from the lifecycle step
		job.updated = true;
		job.have = item;
	}
	if (!item) {
		const data = await buildData();
		const body = {
			data,
			slug: post.slug,
			...(post.createdAt ? { createdAt: post.createdAt } : {}),
			...(post.status === "published" && post.publishedAt ? { publishedAt: post.publishedAt } : {}),
			...(bylineId ? { bylines: [{ bylineId }] } : {}),
			...(post.seo ? { seo: post.seo } : {}),
			...(post.tags.length ? { taxonomies: { tag: post.tags } } : {}),
		};
		try {
			item = await client.create(post.collection, body);
		} catch (err) {
			// A create can commit and still report an error (timeouts); look it up.
			try {
				item = await client.get(post.collection, post.slug, { raw: true });
			} catch {
				throw err;
			}
		}
		job.have = item; // retries resume from here
	}
	if (item.slug && item.slug !== post.slug) {
		throw new Error(`slug changed: wanted ${post.slug}, got ${item.slug} (URL compat broken)`);
	}

	// Step 2: lifecycle. publish() keeps the publishedAt set at create/update.
	// An update we just made may sit in a pending draft revision, so republish
	// it. Never publish other pending drafts (edits made in the EmDash admin).
	if (post.status === "published" && (item.status !== "published" || job.updated)) {
		await client.publish(post.collection, item.id);
	} else if (post.status === "draft" && item.status === "published") {
		await client.unpublish(post.collection, item.id); // unpublished in Ghost
	} else if (post.status === "scheduled" && post.publishedAt && item.status !== "scheduled") {
		if (Date.parse(post.publishedAt) <= Date.now()) {
			await client.publish(post.collection, item.id); // its time already passed
		} else {
			await client.schedule(post.collection, item.id, { at: post.publishedAt });
		}
	}
}

/** Copy an image hosted on the old Ghost box into EmDash media (R2). */
async function localizeImage(ctx, image) {
	if (!image?.src?.startsWith(LEGACY_ORIGIN)) return image; // external hotlink: leave as-is
	if (!ctx.mediaCache.has(image.src)) {
		ctx.mediaCache.set(
			image.src,
			(async () => {
				const res = await fetch(image.src);
				if (!res.ok) throw new Error(`fetch ${image.src}: ${res.status}`);
				const bytes = new Uint8Array(await res.arrayBuffer());
				const filename = decodeURIComponent(new URL(image.src).pathname.split("/").pop());
				return ctx.client.mediaUpload(bytes, filename, {
					alt: image.alt,
					contentType: res.headers.get("content-type") ?? undefined,
				});
			})(),
		);
	}
	const media = await ctx.mediaCache.get(image.src);
	return { id: media.id, alt: image.alt, width: media.width, height: media.height };
}
