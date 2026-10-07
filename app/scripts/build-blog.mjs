// Quaestor's blog, rendered to static pages before the app builds: app/blog/<slug>.md -> public/blogs/<slug>/index.html,
// and an index at public/blogs/index.html. Static, so each post has its own title and link preview and needs no
// router or rewrite. The Markdown is the small subset the posts use: headings, paragraphs, lists, quotes, code,
// tables, links, bold, italics and inline code.
//
//   node scripts/build-blog.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(APP, "blog");
const OUT = join(APP, "public", "blogs");
const SITE = "https://quaestor-app.onrender.com";
const APP_LINK = "/#/app/evm/monad-testnet";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noreferrer"' : ""}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

function markdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{2,4} |```|> |- |\d+\. |\|)/.test(l) || l.trim() === "";
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{2,4}) (.*)$/);
    if (h) {
      const id = h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      out.push(`<h${h[1].length} id="${id}">${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith("> "); i++) body.push(lines[i].slice(2));
      out.push(`<blockquote><p>${inline(body.join(" "))}</p></blockquote>`);
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const [head, , ...body] = rows;
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const list = line.match(/^(- |\d+\. )/);
    if (list) {
      const ordered = list[1] !== "- ";
      const items = [];
      for (; i < lines.length && /^(- |\d+\. )/.test(lines[i]); i++) {
        let item = lines[i].replace(/^(- |\d+\. )/, "");
        while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) item += " " + lines[++i].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && !isBlockStart(lines[i]); i++) para.push(lines[i].trim());
    if (!para.length) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

function parse(file) {
  const raw = readFileSync(join(SRC, file), "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no front matter`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  for (const k of ["slug", "title", "date", "summary"]) if (!meta[k]) throw new Error(`${file}: no ${k}`);
  const words = m[2].split(/\s+/).length;
  return { ...meta, order: Number(meta.order ?? 99), minutes: Math.max(1, Math.round(words / 220)), html: markdown(m[2]) };
}

const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function page({ title, description, url, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="Quaestor" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:image" content="${SITE}/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#090a08" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/blogs/blog.css" />
</head>
<body>
<header class="bar"><div class="wrap bar-in">
  <a class="mark" href="/">QU<span>Æ</span>STOR</a>
  <nav><a href="/blogs/">Blog</a><a href="https://github.com/N-45div/Quaestor" target="_blank" rel="noreferrer">Source</a><a class="cta" href="${APP_LINK}">Open the app →</a></nav>
</div></header>
${body}
<footer class="foot"><div class="wrap foot-in">
  <a class="mark" href="/">QU<span>Æ</span>STOR</a><p>Spending limits an AI agent cannot talk its way past.</p>
  <div><a href="${APP_LINK}">App</a><a href="/blogs/">Blog</a><a href="https://github.com/N-45div/Quaestor" target="_blank" rel="noreferrer">Source</a></div>
</div></footer>
</body>
</html>
`;
}

const CSS = `:root{--bg:#090a08;--panel:#0f100d;--line:#262821;--soft-line:#1b1d17;--ink:#efeee6;--soft:#c3c4bb;--muted:#868a7f;--dim:#5f635a;--gold:#d8ad4b;--gold2:#ecc96f}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.75 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}.wrap{width:min(1120px,calc(100% - 48px));margin-inline:auto}
.bar{position:sticky;top:0;z-index:5;background:rgba(9,10,8,.82);backdrop-filter:blur(12px);border-bottom:1px solid var(--soft-line)}
.bar-in{height:64px;display:flex;align-items:center;justify-content:space-between}
.mark{font:600 19px/1 Fraunces,Georgia,serif;letter-spacing:.07em;text-decoration:none}.mark span{color:var(--gold)}
nav{display:flex;align-items:center;gap:24px}nav a{color:var(--muted);font-size:14px;text-decoration:none}nav a:hover{color:var(--ink)}
nav .cta{color:var(--gold2);border:1px solid #5a4b26;border-radius:999px;padding:8px 14px;font-weight:600}
.hero{padding:88px 0 36px;border-bottom:1px solid var(--soft-line)}
.kicker{color:var(--gold);font:500 12px "JetBrains Mono",monospace;letter-spacing:.16em;text-transform:uppercase}
.hero h1{margin:18px 0 0;font:500 clamp(40px,6vw,72px)/1.02 Fraunces,Georgia,serif;letter-spacing:-.04em;max-width:900px}
.hero p{max-width:680px;color:var(--soft);font-size:19px;margin:22px 0 0}
.posts{list-style:none;margin:0;padding:24px 0 96px}
.posts li{border-bottom:1px solid var(--soft-line)}
.posts a{display:grid;grid-template-columns:180px 1fr;gap:32px;padding:34px 0;text-decoration:none}
.posts a:hover h2{color:var(--gold2)}
.posts time{color:var(--dim);font:400 13px "JetBrains Mono",monospace;padding-top:8px}
.posts h2{margin:0;font:500 32px/1.15 Fraunces,Georgia,serif;letter-spacing:-.025em;transition:color .15s}
.posts p{margin:10px 0 0;color:var(--muted);font-size:16px;max-width:720px}
.post-head{padding:84px 0 40px;border-bottom:1px solid var(--soft-line)}
.post-head .meta{color:var(--dim);font:400 13px "JetBrains Mono",monospace;margin-top:22px}
.post-head h1{margin:18px 0 0;font:500 clamp(38px,5.6vw,68px)/1.04 Fraunces,Georgia,serif;letter-spacing:-.04em;max-width:920px}
.post-head .lead{max-width:720px;color:var(--soft);font-size:20px;line-height:1.6;margin:24px 0 0}
article{width:min(720px,calc(100% - 48px));margin:0 auto;padding:48px 0 40px}
article h2{margin:56px 0 0;font:500 32px/1.2 Fraunces,Georgia,serif;letter-spacing:-.025em}
article h3{margin:36px 0 0;font:500 23px/1.3 Fraunces,Georgia,serif}
article p,article ul,article ol,article blockquote,article pre,article .table{margin:20px 0 0}
article p,article li{color:var(--soft)}article li{margin:8px 0}article ul,article ol{padding-left:22px}
article strong{color:var(--ink);font-weight:600}
article a{color:var(--gold2);text-decoration:underline;text-decoration-color:rgba(236,201,111,.35);text-underline-offset:3px}
article code{font:400 .86em "JetBrains Mono",monospace;background:#17180f;border:1px solid var(--soft-line);border-radius:6px;padding:1px 6px;color:var(--ink)}
article pre{background:#0d0e0b;border:1px solid var(--line);border-radius:14px;padding:18px 20px;overflow-x:auto}
article pre code{background:none;border:0;padding:0;font-size:13.5px;line-height:1.7;color:#d6d4c8}
article blockquote{margin-left:0;padding:4px 0 4px 20px;border-left:2px solid var(--gold)}article blockquote p{margin:0;color:var(--ink);font:400 21px/1.5 Fraunces,Georgia,serif}
article .table{overflow-x:auto;border:1px solid var(--line);border-radius:14px}
article table{width:100%;border-collapse:collapse;font-size:14px}article th,article td{text-align:left;vertical-align:top;padding:12px 14px;border-bottom:1px solid var(--soft-line)}
article th{color:var(--dim);font:500 11px "JetBrains Mono",monospace;letter-spacing:.1em;text-transform:uppercase}article td{color:var(--soft)}article tr:last-child td{border-bottom:0}
.next{width:min(720px,calc(100% - 48px));margin:0 auto 96px;padding:28px;border:1px solid var(--line);border-radius:20px;background:var(--panel)}
.next h2{margin:0;font:500 26px/1.2 Fraunces,Georgia,serif}.next h2 em{color:var(--gold);font-style:italic;font-weight:400}
.next p{margin:10px 0 0;color:var(--muted);font-size:15px}.next a.btn{display:inline-block;margin-top:18px;background:var(--gold);color:#161106;text-decoration:none;font-weight:600;font-size:14px;border-radius:999px;padding:12px 20px}
.foot{border-top:1px solid var(--soft-line)}.foot-in{display:flex;align-items:center;gap:22px;padding:28px 0 40px}.foot p{margin:0;color:var(--dim);font-size:13px}
.foot div{margin-left:auto;display:flex;gap:18px}.foot div a{color:var(--muted);font-size:13px;text-decoration:none}
@media (max-width:720px){body{font-size:16px}nav a:not(.cta){display:none}.posts a{grid-template-columns:1fr;gap:6px}.posts time{padding:0}.posts h2{font-size:26px}
.hero,.post-head{padding-top:56px}.foot-in{flex-wrap:wrap}.foot div{margin-left:0}}
`;

const posts = readdirSync(SRC).filter((f) => f.endsWith(".md")).map(parse).sort((a, b) => a.order - b.order || b.date.localeCompare(a.date));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "blog.css"), CSS);

const next = `<aside class="next"><h2>Don&rsquo;t give your agent a wallet. <em>Give it an allowance.</em></h2><p>Send a hijacked agent&rsquo;s trade and watch the governor refuse it on Monad testnet. No wallet needed.</p><a class="btn" href="${APP_LINK}">Open the app →</a></aside>`;
for (const p of posts) {
  mkdirSync(join(OUT, p.slug), { recursive: true });
  writeFileSync(join(OUT, p.slug, "index.html"), page({
    title: `${p.title} · Quaestor`,
    description: p.summary,
    url: `${SITE}/blogs/${p.slug}/`,
    body: `<main><header class="post-head"><div class="wrap"><a class="kicker" href="/blogs/" style="text-decoration:none">← Quaestor blog</a><h1>${esc(p.title)}</h1><p class="lead">${esc(p.summary)}</p><div class="meta">${day(p.date)} · ${p.minutes} min read · Divij N</div></div></header>
<article>
${p.html}
</article>
${next}</main>`,
  }));
}
writeFileSync(join(OUT, "index.html"), page({
  title: "Blog · Quaestor",
  description: "How Quaestor gives AI trading agents an allowance instead of a wallet: the governor, the agent, and what runs on Monad.",
  url: `${SITE}/blogs/`,
  body: `<main><header class="hero"><div class="wrap"><span class="kicker">The Quaestor blog</span><h1>Notes on giving agents an allowance.</h1><p>How the governor works, how the house agent decides, and what runs on Monad, with a transaction for every claim.</p></div></header>
<div class="wrap"><ul class="posts">${posts.map((p) => `<li><a href="/blogs/${p.slug}/"><time datetime="${p.date}">${day(p.date)}</time><div><h2>${esc(p.title)}</h2><p>${esc(p.summary)}</p></div></a></li>`).join("")}</ul></div></main>`,
}));
console.log(`blog: ${posts.length} post(s) -> public/blogs (${posts.map((p) => p.slug).join(", ")})`);
