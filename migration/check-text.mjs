/**
 * Content-loss check: compares the words in each Ghost post's HTML with the
 * words in its converted Portable Text. Run after `convert`:
 *   node migration/check-text.mjs <ghost.db> migration/out/posts.ndjson
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseFragment } from "parse5";
const [dbPath, ndjson] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const html = new Map(db.prepare("select id, html from posts").all().map(r => [r.id, r.html ?? ""]));
const textOf = (h) => { const out=[]; const w=(n)=>{ if(n.nodeName==="#text") out.push(n.value); if(n.tagName==="script"||n.tagName==="style") return; for(const c of n.childNodes??[]) w(c);}; w(parseFragment(h)); return out.join(" "); };
const words = (s) => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []);
let worst=[]; let total=0, lostTotal=0;
for (const line of readFileSync(ndjson,"utf8").split("\n")) { if(!line) continue; const p=JSON.parse(line);
  const src = words(textOf(html.get(p.ghostId)));
  const ptText = p.data.content.map(b => b._type==="block" ? (b.children??[]).map(c=>c.text??"").join(" ") : b._type==="htmlBlock" ? textOf(b.html) : "").join(" ");
  const dst = new Map(); for (const w of words(ptText)) dst.set(w,(dst.get(w)??0)+1);
  let lost=0; for (const w of src) { const n=dst.get(w)??0; if(n>0) dst.set(w,n-1); else lost++; }
  total+=src.length; lostTotal+=lost;
  if (lost>0) worst.push([lost, src.length, p.slug, p.ghostId]);
}
worst.sort((a,b)=>b[0]-a[0]);
console.log("words:", total, "lost:", lostTotal, "posts with any loss:", worst.length);
console.log(worst.slice(0,15).map(r=>r.join("  ")).join("\n"));
