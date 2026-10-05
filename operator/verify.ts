/**
 * What a claimed delivery actually is. Before the Operator's model judges a deliverable, this
 * fetches it and settles the facts a model should not be trusted with: whose it is, when it was
 * published, whether a pull request merged, and one canonical form of the link, so the same
 * post cannot be claimed twice under two spellings of its URL.
 *
 * Sources need no keys: X's public oEmbed, GitHub's REST API, YouTube's oEmbed, and the page.
 */
import { ethers } from "ethers";

export type ProofKind = "x-post" | "pull-request" | "video" | "page";

export interface Evidence {
  ok: boolean;
  kind: ProofKind;
  url: string;
  canonical: string;
  proofHash: string;
  author?: string; // a handle, lower-case, without "@"
  title?: string;
  text?: string;
  publishedAt?: string; // ISO date, where the source says
  merged?: boolean;
  error?: string;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const MAX_TEXT = 6000;

/** One spelling per thing: x.com and twitter.com, tracking queries and trailing slashes fold away. */
export function canonicalize(raw: string): { kind: ProofKind; canonical: string } {
  const u = new URL(raw.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not a web link");
  const host = u.hostname.toLowerCase().replace(/^www\.|^mobile\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if ((host === "x.com" || host === "twitter.com") && parts[1] === "status" && /^\d+$/.test(parts[2] ?? "")) {
    return { kind: "x-post", canonical: `https://x.com/${parts[0].toLowerCase()}/status/${parts[2]}` };
  }
  if (host === "github.com" && parts[2] === "pull" && /^\d+$/.test(parts[3] ?? "")) {
    return { kind: "pull-request", canonical: `https://github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}/pull/${parts[3]}` };
  }
  if (host === "youtube.com" && u.searchParams.get("v")) return { kind: "video", canonical: `https://youtube.com/watch?v=${u.searchParams.get("v")}` };
  if (host === "youtu.be" && parts[0]) return { kind: "video", canonical: `https://youtube.com/watch?v=${parts[0]}` };
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return { kind: "page", canonical: `https://${host}${path}` };
}

/** The proof hash a release commits to: keccak256 of the canonical link. */
export function proofHashOf(url: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalize(url).canonical));
}

const stripTags = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();

/** Fetch what a proof link points at, and the facts about it. Never throws: `ok` says. */
export async function fetchEvidence(url: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Evidence> {
  let kind: ProofKind;
  let canonical: string;
  try {
    ({ kind, canonical } = canonicalize(url));
  } catch (err) {
    return { ok: false, kind: "page", url, canonical: url, proofHash: ethers.ZeroHash, error: (err as Error).message };
  }
  const proofHash = ethers.keccak256(ethers.toUtf8Bytes(canonical));
  const base = { kind, url, canonical, proofHash };
  try {
    if (kind === "x-post") {
      const res = await fetchFn(`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(canonical)}`);
      if (!res.ok) return { ...base, ok: false, error: `X says ${res.status}: the post is missing, deleted or private` };
      const o = (await res.json()) as { author_url?: string; html?: string };
      const html = o.html ?? "";
      // oEmbed ends the quote with "— Name (@handle) <a …>Month d, yyyy</a>".
      const date = html.match(/<a [^>]*>([A-Z][a-z]+ \d{1,2}, \d{4})<\/a>\s*<\/blockquote>/)?.[1];
      const body = stripTags(html.split(/&mdash;|—/)[0] ?? html);
      return {
        ...base,
        ok: true,
        author: (o.author_url ?? "").split("/").filter(Boolean).pop()?.toLowerCase(),
        text: body.slice(0, MAX_TEXT),
        publishedAt: date ? new Date(`${date} UTC`).toISOString() : undefined,
      };
    }
    if (kind === "pull-request") {
      const [, , , owner, repo, , n] = canonical.split("/");
      const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}`, { headers: { accept: "application/vnd.github+json", "user-agent": "quaestor-operator" } });
      if (!res.ok) return { ...base, ok: false, error: `GitHub says ${res.status}` };
      const pr = (await res.json()) as { user?: { login?: string }; merged?: boolean; merged_at?: string | null; created_at?: string; title?: string; body?: string | null };
      return {
        ...base,
        ok: true,
        author: pr.user?.login?.toLowerCase(),
        title: pr.title,
        text: (pr.body ?? "").slice(0, MAX_TEXT),
        merged: Boolean(pr.merged),
        publishedAt: pr.merged_at ?? pr.created_at,
      };
    }
    if (kind === "video") {
      const res = await fetchFn(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`);
      if (!res.ok) return { ...base, ok: false, error: `YouTube says ${res.status}` };
      const o = (await res.json()) as { title?: string; author_url?: string; author_name?: string };
      return { ...base, ok: true, title: o.title, author: (o.author_url ?? "").split("/").filter(Boolean).pop()?.replace(/^@/, "").toLowerCase() ?? o.author_name };
    }
    const res = await fetchFn(canonical, { headers: { "user-agent": "Mozilla/5.0 (compatible; quaestor-operator)" } });
    if (!res.ok) return { ...base, ok: false, error: `the page answered ${res.status}` };
    const html = await res.text();
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const published = html.match(/(?:article:published_time|datePublished)["']?\s*(?:content=|:)\s*["']([^"']+)["']/i)?.[1];
    const author = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1];
    return { ...base, ok: true, title, author: author?.toLowerCase(), text: stripTags(html).slice(0, MAX_TEXT), publishedAt: published };
  } catch (err) {
    return { ...base, ok: false, error: `could not fetch it: ${(err as Error).message.slice(0, 120)}` };
  }
}

/** The facts that settle a claim before any model sees it; each failure is a reason to refuse. */
export function hardChecks(e: Evidence, expect: { handle: string; taskKind: string; openedAt: Date; mustMention?: string[] }): string[] {
  const problems: string[] = [];
  if (!e.ok) return [e.error ?? "the proof could not be fetched"];
  const wanted = expect.taskKind === "thread" ? "x-post" : expect.taskKind === "article" ? "page" : expect.taskKind;
  if (["x-post", "pull-request", "video", "page"].includes(wanted) && e.kind !== wanted) problems.push(`the task wants a ${wanted}, and this is a ${e.kind}`);
  const handle = expect.handle.replace(/^@/, "").toLowerCase();
  if (e.author && handle && e.kind !== "page" && e.author !== handle) problems.push(`it was published by ${e.author}, not ${handle}`);
  if (e.publishedAt && new Date(e.publishedAt).getTime() < expect.openedAt.getTime() - 86_400_000) problems.push(`it was published on ${e.publishedAt.slice(0, 10)}, before the deal`);
  if (e.kind === "pull-request" && !e.merged) problems.push("the pull request has not been merged");
  for (const m of expect.mustMention ?? []) {
    const hay = `${e.title ?? ""}\n${e.text ?? ""}`.toLowerCase();
    if (!hay.includes(m.toLowerCase())) problems.push(`it does not mention ${m}`);
  }
  return problems;
}
