# jetsfix.com

JetsFix on [EmDash](https://github.com/emdash-cms/emdash) (Astro) running on
Cloudflare Workers, with content in D1 and media in R2. This repo is the
source of truth for the **site** — code, schema, config, and deploy
pipeline. **Posts live in D1**, written through the EmDash admin, and are
backed up nightly (see [Backups](#backups)).

Replaces the Ghost 0.11 / SQLite / nginx box on GCP (`104.196.124.191`).

| | Old | New |
|---|---|---|
| App | Ghost 0.11.x | EmDash 1.4 (Astro 7) |
| Runtime | node behind nginx, single GCP VM | Cloudflare Worker (Workers Paid) |
| Database | SQLite file on the VM | D1 (`jetsfix`), Time Travel + nightly dumps |
| Media | `content/images` on the VM | R2 (`jetsfix-media`) |
| TLS | none (HTTP only) | Cloudflare-managed, auto-renewing |
| Deploys | ssh | merge to `main` → GitHub Actions |

## Layout

```
astro.config.mjs        EmDash integration (D1 + R2 bindings)
wrangler.jsonc          Worker config: name, domain, bindings, cron
seed/seed.json          Schema: collections, fields, menus, widgets, redirects
src/pages/[slug].astro  Post page, served at Ghost's /:slug/ URLs
src/components/LegacyHtmlBlock.astro  Renders Ghost-era embeds verbatim
src/middleware.ts       http→https, apex→www, noindex for non-prod hosts
migration/              Ghost → EmDash importer, content-loss + URL checks
.github/workflows/      ci (PRs), deploy (main), backup (nightly)
```

## URL compatibility (hard requirement)

Ghost served `http://www.jetsfix.com/:slug/`. The new site keeps every path:

- Posts render at `/:slug/` directly (canonical, with the trailing slash).
  `/:slug` also works. Slugs are imported unchanged; the importer aborts a
  post if EmDash would alter its slug.
- `http://` → `https://` and `jetsfix.com` → `www.jetsfix.com` are 301s that
  keep the path (`src/middleware.ts`).
- Ghost-only URLs redirect (seed `redirects`): `/rss/` → `/rss.xml`,
  `/:slug/amp/` → `/:slug/`, `/author/*`, `/page/N/` and Ghost's empty
  default tag `/tag/getting-started/` → `/posts`.
- Links inside posts to `jetsfix.com` are rewritten to site-relative paths.

`migration/verify-urls.mjs` proves this before cutover (see below).

## Local development

```bash
npm install
npm run dev            # http://localhost:4321, admin at /_emdash/admin
npm test               # migration converter tests
```

To get real content locally, run the import against the dev server (no
token needed on localhost):

```bash
npm run migrate:convert -- --db ~/Downloads/ghost.db --out migration/out
npm run migrate:import  -- --url http://localhost:4321 --out migration/out
```

## One-time setup

All deploys and Cloudflare changes go through GitHub Actions; nothing is
deployed from a laptop.

1. **Cloudflare account** on Workers Paid ($5/mo). The Worker is ~5 MB
   gzipped — over the free plan's 3 MB cap.
2. **Domains.** `jetsfix-preview.com` must be an active zone in that account.
   For the real cutover, `jetsfix.com` must become one too (nameservers are
   at Namecheap today — see [Cutover](#cutover)).
3. **Cloudflare API token** (My Profile → API Tokens → Create Token → "Edit
   Cloudflare Workers" template), then add **Account · D1 · Edit** and, under
   Zone Resources, include `jetsfix-preview.com` (later `jetsfix.com`).
4. **GitHub repository settings:**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
     `EMDASH_ENCRYPTION_KEY` (from `npx emdash secrets generate`; keep a copy
     in your password manager — GitHub secrets can't be read back).
   - Variable: `SITE_URL` = `https://jetsfix-preview.com` (later
     `https://www.jetsfix.com`).
   - Environment `production` (optionally with required reviewers).
   - Protect `main`; require the CI check.
5. **First deploy:** push to `main` (or run the Deploy workflow). Wrangler
   creates the D1 database, R2 media bucket and KV namespace by name; the
   first Backup run creates the `jetsfix-backups` bucket. Give that bucket a
   lifecycle rule (e.g. expire after 365 days) in the dashboard.

## Preview launch (jetsfix-preview.com)

Ghost keeps serving jetsfix.com untouched while the editor tries EmDash.
The preview sends `X-Robots-Tag: noindex` and a blocking `robots.txt`, so it
can't compete with jetsfix.com in search.

1. Deploy (above). Visit `https://jetsfix-preview.com/_emdash/admin` and
   complete the setup wizard — **you** create the admin account (passkey).
2. Create an API token in the admin (Settings → API tokens, admin scope).
3. Import:
   ```bash
   scp gcp-box:/path/to/ghost/content/data/ghost.db /tmp/ghost.db   # fresh copy
   npm run migrate:convert -- --db /tmp/ghost.db --out migration/out
   npm run migrate:check-text -- /tmp/ghost.db migration/out/posts.ndjson   # expect "lost: 0"
   EMDASH_TOKEN=... npm run migrate:import -- --url https://jetsfix-preview.com --out migration/out
   ```
   Re-running `import` is safe: finished entries are skipped, half-finished
   ones (created but not yet published) are completed.
4. Verify every old URL resolves on the preview:
   ```bash
   npm run migrate:verify-urls -- --base https://jetsfix-preview.com \
     --urls migration/out/urls.txt --sitemap http://www.jetsfix.com/sitemap.xml
   ```
5. Invite the editor from the admin (Users). Passkeys are bound to the
   origin, so accounts made on the preview will need a new passkey on
   www.jetsfix.com after cutover.

The preview is a snapshot: posts published on Ghost after the import aren't
on it. That's fine for evaluation; cutover re-imports from scratch.

## Cutover

Plan for a quiet window (not a game day). Ghost stays up until DNS has
fully moved, so rollback is "point DNS back".

1. **Prepare the zone (days ahead, no traffic impact):** add `jetsfix.com`
   to Cloudflare, let it import the existing DNS records, confirm they match
   Namecheap (A records → `104.196.124.191`), then switch the nameservers at
   Namecheap to Cloudflare's. Traffic still goes to the GCP box.
2. **Freeze Ghost:** ask the editor to stop publishing; note any scheduled
   posts.
3. **Fresh database:** reset the D1 database (or point `wrangler.jsonc` at a
   new one, e.g. `jetsfix-prod`), deploy, run the setup wizard on the
   preview hostname, then import from a fresh `ghost.db` copy (Preview launch
   steps 2–4).
4. **Switch the Worker to production** (PR to `main`):
   - `routes`: `www.jetsfix.com` and `jetsfix.com`, both `custom_domain: true`
   - `vars.EMDASH_SITE_URL`: `https://www.jetsfix.com`
   - GitHub variable `SITE_URL`: `https://www.jetsfix.com`

   Attaching the custom domains replaces the old A records and issues the
   certificate (auto-renewing).
5. **Verify** against production: `verify-urls` with
   `--base https://www.jetsfix.com`, and spot-check `http://www.jetsfix.com/<slug>/`
   and `http://jetsfix.com/<slug>/` 301 to `https://www.jetsfix.com/<slug>/`.
6. **Search Console:** add the `https://www.jetsfix.com` property and submit
   `/sitemap.xml`.
7. Keep the GCP box (stopped) for a couple of weeks, then delete it.

## Backups

- **D1 Time Travel:** point-in-time restore for the last 30 days
  (`npx wrangler d1 time-travel restore jetsfix --timestamp=...`).
- **Nightly dump:** `.github/workflows/backup.yml` writes a gzipped SQL dump
  to `r2://jetsfix-backups/d1/`. Restore with
  `npx wrangler d1 execute <db> --remote --file=<dump.sql>`.
- Media in R2 is small (a logo and one featured image); post images are
  hotlinks to Giphy/Twitter/Imgur as they were on Ghost.

## What the importer does with Ghost content

Ghost 0.11 stored Markdown plus its rendered HTML. The importer converts the
**rendered HTML** (what readers saw) to EmDash's Portable Text with EmDash's
own converter, after pulling out embeds that converter would drop:

| Ghost content | Count | Becomes |
|---|---|---|
| Tweets | ~1,580 | verbatim embed block (+ widgets.js) |
| Giphy iframes | ~2,800 | plain GIF image |
| YouTube | 82 | native EmDash YouTube embed |
| StrawPoll / poll-maker / quiz / Imgur / Polldaddy | ~500 | verbatim embed block, script kept with its markup |
| MockDraftable and other iframes | ~320 | verbatim embed block |

`migration/check-text.mjs` compares the words in every Ghost post with the
converted result; the last run lost 0 of 2.3M words.

## Carried over from the Ghost theme

- **Disqus comments** (shortname `jetsfix`). The old theme keyed threads by
  the post's exact `http://www.jetsfix.com/<slug>/` URL, and
  `DisqusThread.astro` passes that same string, so existing threads show up
  unchanged. During the preview, comments posted on jetsfix-preview.com go
  into the real threads; if Disqus "Trusted Domains" is set, add the preview
  domain there.
- **favicon.ico.**

## Deliberately not carried over (yet)

- **Google AdSense.** On hold while Patreon is considered instead. To restore:
  publisher `ca-pub-2040733818040624`, responsive slot `7545322418`, placed
  three times per post (top of the article, after the body, after the
  article), the loader script in `<head>` on production hosts only, and
  `public/ads.txt` containing
  `google.com, pub-2040733818040624, DIRECT, f08c47fec0942fa0`.
  The live site still serves its ads.txt until cutover.
- **Google Analytics `UA-98650382-1`.** Universal Analytics stopped
  processing data in July 2023, so this tag records nothing. Cloudflare Web
  Analytics (free, cookie-less) can be switched on for the zone instead.

Not migrated: Ghost tags (there were none), subscribers (none), members,
SEO meta (none set). Publish dates, slugs, authors (as bylines), drafts and
scheduled posts are kept; each post also stores its Ghost ID in `ghost_id`.
