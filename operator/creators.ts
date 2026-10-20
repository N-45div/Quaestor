/**
 * The creator book: one profile per creator, across every project, instead of a fresh application
 * each time. A creator proves each handle by publishing a one-time code from it (a post on X, a
 * YouTube video's title, a public GitHub gist); only proven handles are matched or shown publicly.
 * Their track record is read from what the Operator actually paid them on-chain, by the wallet paid.
 *
 * Creators join on their own; nobody is listed who did not sign up.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { ethers } from "ethers";
import type { Sql } from "./db";
import { fetchEvidence, type Fetch } from "./verify";

export const TASK_KINDS = ["x-post", "thread", "pull-request", "video", "article"] as const;
export const PLATFORMS = ["x", "youtube", "github"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** How fresh a proof post must be: an old post that happens to contain the code proves nothing. */
export const PROOF_DAYS = 14;

/** Which proven handle a task needs; an article can be published anywhere. */
export const PLATFORM_FOR_KIND: Record<string, Platform | null> = { "x-post": "x", thread: "x", video: "youtube", "pull-request": "github", article: null };

export interface Creator {
  id: string;
  token: string; // the creator's private link
  name: string;
  bio: string;
  niches: string[];
  kinds: string[];
  samples: string[];
  rate_min: bigint | null; // dollars to six places, like every Operator amount
  rate_max: bigint | null;
  wallet: string;
  networks: string[];
  email: string | null;
  listed: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreatorHandle {
  creator_id: string;
  platform: Platform;
  handle: string;
  code: string;
  verified_at: Date | null;
  proof_url: string | null;
}

export type CreatorInput = Partial<Pick<Creator, "name" | "bio" | "niches" | "kinds" | "samples" | "rate_min" | "rate_max" | "wallet" | "networks" | "email" | "listed">>;

export interface TrackRecord {
  deliveries: number;
  paid: bigint;
  by_network: Record<string, { deliveries: number; paid: bigint }>;
  recent: { project: string; network: string; proof_url: string; amount: bigint; tx: string; at: Date }[];
}

const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));
const asCreator = (r: Record<string, unknown>): Creator => ({ ...(r as unknown as Creator), rate_min: big(r.rate_min), rate_max: big(r.rate_max) });
const fromUsd = (usd: number) => BigInt(Math.round(usd * 1e6));

/** A handle as the platform spells it, from "@name", "name" or a profile link; null if it cannot be one. */
export function normalHandle(platform: Platform, raw: string): string | null {
  let h = raw.trim();
  try {
    if (/^https?:\/\//i.test(h)) h = new URL(h).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return null;
  }
  h = h.replace(/^@/, "").toLowerCase();
  const ok = platform === "x" ? /^[a-z0-9_]{1,15}$/ : platform === "github" ? /^[a-z0-9](?:[a-z0-9-]{0,38})$/ : /^[a-z0-9._-]{3,30}$/;
  return ok.test(h) ? h : null;
}

const strings = (v: unknown, max: number, each: number) =>
  Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean))].slice(0, max).map((s) => s.slice(0, each)) : undefined;

/** A profile from a request body; anything left out is left as it is. An error names the field. */
export function creatorInput(b: Record<string, unknown>, networks: string[], creating: boolean): CreatorInput | { error: string } {
  const out: CreatorInput = {};
  if (b.name !== undefined || creating) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 2 || name.length > 60) return { error: "name: 2 to 60 characters" };
    out.name = name;
  }
  if (b.wallet !== undefined || creating) {
    if (typeof b.wallet !== "string" || !ethers.isAddress(b.wallet)) return { error: "wallet: the address you are paid at" };
    out.wallet = b.wallet.toLowerCase();
  }
  if (b.bio !== undefined) out.bio = String(b.bio).trim().slice(0, 600);
  if (b.niches !== undefined) out.niches = [...new Set((strings(b.niches, 8, 32) ?? []).map((n) => n.toLowerCase()))];
  if (b.kinds !== undefined) {
    const kinds = strings(b.kinds, 5, 20) ?? [];
    const unknown = kinds.find((k) => !(TASK_KINDS as readonly string[]).includes(k));
    if (unknown) return { error: `kinds: each one of ${TASK_KINDS.join(", ")}` };
    out.kinds = kinds;
  }
  if (b.samples !== undefined) {
    const samples = strings(b.samples, 6, 300) ?? [];
    if (samples.some((s) => !/^https:\/\/\S+$/.test(s))) return { error: "samples: links that start with https://" };
    out.samples = samples;
  }
  if (b.rate_min_usd !== undefined || b.rate_max_usd !== undefined) {
    const min = Number(b.rate_min_usd), max = Number(b.rate_max_usd);
    if (!(min > 0 && max >= min && max <= 100_000)) return { error: "rate_min_usd and rate_max_usd: 0 < min <= max" };
    out.rate_min = fromUsd(min);
    out.rate_max = fromUsd(max);
  }
  if (b.networks !== undefined) {
    const nets = strings(b.networks, 8, 40) ?? [];
    const unknown = nets.find((n) => !networks.includes(n));
    if (unknown) return { error: `networks: each one of ${networks.join(", ")}` };
    out.networks = nets;
  }
  if (b.email !== undefined) {
    const email = b.email === null ? "" : String(b.email).trim();
    if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) return { error: "email: an address, or leave it out" };
    out.email = email || null;
  }
  if (b.listed !== undefined) out.listed = b.listed !== false;
  return out;
}

const GIST = /^https:\/\/gist\.github\.com\/([A-Za-z0-9-]+)\/([0-9a-f]{20,40})\/?$/i;

export class CreatorBook {
  constructor(readonly sql: Sql, private readonly fetchFn: Fetch = fetch as unknown as Fetch, private readonly now: () => Date = () => new Date()) {}

  async create(input: CreatorInput & { name: string; wallet: string }, handles: Partial<Record<Platform, string>> = {}): Promise<{ creator: Creator; handles: CreatorHandle[] } | { error: string }> {
    const wanted: [Platform, string][] = [];
    for (const p of PLATFORMS) {
      if (handles[p] === undefined || handles[p] === "") continue;
      const h = normalHandle(p, String(handles[p]));
      if (!h) return { error: `${p}: that is not a ${p} handle` };
      wanted.push([p, h]);
    }
    const id = randomUUID();
    const token = randomBytes(18).toString("base64url");
    await this.sql.query(
      `insert into op_creator (id, token, name, bio, niches, kinds, samples, rate_min, rate_max, wallet, networks, email, listed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, token, input.name, input.bio ?? "", JSON.stringify(input.niches ?? []), JSON.stringify(input.kinds ?? []), JSON.stringify(input.samples ?? []),
        input.rate_min?.toString() ?? null, input.rate_max?.toString() ?? null, input.wallet, JSON.stringify(input.networks ?? []), input.email ?? null, input.listed ?? true],
    );
    for (const [p, h] of wanted) await this.setHandle(id, p, h);
    return { creator: (await this.byId(id))!, handles: await this.handles(id) };
  }

  async update(id: string, input: CreatorInput): Promise<Creator> {
    const cols: [string, unknown][] = [];
    const json = (v: unknown) => JSON.stringify(v);
    if (input.name !== undefined) cols.push(["name", input.name]);
    if (input.bio !== undefined) cols.push(["bio", input.bio]);
    if (input.niches !== undefined) cols.push(["niches", json(input.niches)]);
    if (input.kinds !== undefined) cols.push(["kinds", json(input.kinds)]);
    if (input.samples !== undefined) cols.push(["samples", json(input.samples)]);
    if (input.rate_min !== undefined) cols.push(["rate_min", input.rate_min?.toString() ?? null]);
    if (input.rate_max !== undefined) cols.push(["rate_max", input.rate_max?.toString() ?? null]);
    if (input.wallet !== undefined) cols.push(["wallet", input.wallet]);
    if (input.networks !== undefined) cols.push(["networks", json(input.networks)]);
    if (input.email !== undefined) cols.push(["email", input.email]);
    if (input.listed !== undefined) cols.push(["listed", input.listed]);
    if (cols.length) {
      const set = cols.map(([c], i) => `${c} = $${i + 2}`).join(", ");
      await this.sql.query(`update op_creator set ${set}, updated_at = now() where id = $1`, [id, ...cols.map(([, v]) => v)]);
    }
    return (await this.byId(id))!;
  }

  async byId(id: string): Promise<Creator | null> {
    const { rows } = await this.sql.query("select * from op_creator where id = $1", [id]);
    return rows[0] ? asCreator(rows[0]) : null;
  }

  async byToken(token: string): Promise<Creator | null> {
    const { rows } = await this.sql.query("select * from op_creator where token = $1", [token]);
    return rows[0] ? asCreator(rows[0]) : null;
  }

  async handles(creatorId: string): Promise<CreatorHandle[]> {
    return (await this.sql.query<CreatorHandle>("select * from op_creator_handle where creator_id = $1 order by platform", [creatorId])).rows;
  }

  /** Name a handle, or change it; either way it starts unproven, with a new code to publish. */
  async setHandle(creatorId: string, platform: Platform, handle: string): Promise<CreatorHandle> {
    const code = `qc-${randomBytes(3).toString("hex")}`;
    await this.sql.query(
      `insert into op_creator_handle (creator_id, platform, handle, code) values ($1,$2,$3,$4)
       on conflict (creator_id, platform) do update set handle = excluded.handle, code = excluded.code, verified_at = null, proof_url = null`,
      [creatorId, platform, handle, code],
    );
    return (await this.handles(creatorId)).find((h) => h.platform === platform)!;
  }

  /**
   * Prove a handle: the link must be the creator's own fresh post (or video, or gist) carrying their code. The
   * latest proof wins: whoever can publish from the account owns the handle here, so an earlier claim by
   * anyone else is withdrawn.
   */
  async verify(creatorId: string, platform: Platform, url: string): Promise<{ ok: true; handle: CreatorHandle } | { ok: false; error: string }> {
    const h = (await this.handles(creatorId)).find((x) => x.platform === platform);
    if (!h) return { ok: false, error: `name your ${platform} handle first` };
    const found = await this.proofOf(platform, url);
    if ("error" in found) return { ok: false, error: found.error };
    if (found.author !== h.handle) return { ok: false, error: `that was published by ${found.author ?? "someone else"}, not ${h.handle}` };
    if (!found.text.toLowerCase().includes(h.code)) return { ok: false, error: `it does not contain your code, ${h.code}` };
    if (found.at && found.at.getTime() < this.now().getTime() - PROOF_DAYS * 86_400_000) return { ok: false, error: `it is older than ${PROOF_DAYS} days; publish the code again` };
    await this.sql.query("update op_creator_handle set verified_at = null, proof_url = null where platform = $1 and handle = $2 and creator_id <> $3 and verified_at is not null", [platform, h.handle, creatorId]);
    await this.sql.query("update op_creator_handle set verified_at = now(), proof_url = $3 where creator_id = $1 and platform = $2", [creatorId, platform, url]);
    return { ok: true, handle: (await this.handles(creatorId)).find((x) => x.platform === platform)! };
  }

  /** Who published a proof link, what it says, and when; read from the platform, never from the creator. */
  private async proofOf(platform: Platform, url: string): Promise<{ author?: string; text: string; at?: Date } | { error: string }> {
    if (platform === "github") {
      const m = url.trim().match(GIST);
      if (!m) return { error: "for GitHub, link a public gist: https://gist.github.com/<you>/<id>" };
      // The gist page's own JSON (the one embeds use), not the REST API: it needs no key, and the API's keyless
      // limit is shared by every app on a hosting provider's addresses. Its owner is the login; div is the files, rendered.
      const res = await this.fetchFn(`https://gist.github.com/${m[1]}/${m[2]}.json`, { headers: { "user-agent": "quaestor-operator" } });
      if (!res.ok) return { error: res.status === 404 ? "that gist is missing, secret, or not under that account" : `GitHub says ${res.status}` };
      const g = (await res.json()) as { owner?: string; description?: string | null; created_at?: string; div?: string };
      const text = [g.description ?? "", (g.div ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")].join("\n");
      return { author: g.owner?.toLowerCase(), text, at: g.created_at ? new Date(g.created_at) : undefined };
    }
    const e = await fetchEvidence(url, this.fetchFn);
    const want = platform === "x" ? "x-post" : "video";
    if (!e.ok) return { error: e.error ?? "the link could not be read" };
    if (e.kind !== want) return { error: platform === "x" ? "for X, link the post itself: https://x.com/<you>/status/…" : "for YouTube, link the video: https://youtube.com/watch?v=…" };
    return { author: e.author, text: `${e.title ?? ""}\n${e.text ?? ""}`, at: e.publishedAt ? new Date(e.publishedAt) : undefined };
  }

  /** What the Operator has paid this wallet, on every project and chain, newest first. */
  async record(wallet: string): Promise<TrackRecord> {
    const { rows } = await this.sql.query<{ project: string; network: string; proof_url: string; amount: string; release_tx: string; created_at: string }>(
      `select p.name as project, p.network, c.proof_url, c.amount, c.release_tx, c.created_at
         from op_claim c join op_deal d on d.id = c.deal_id join op_project p on p.id = d.project_id
        where d.payee = $1 and c.status = 'paid' order by c.created_at desc limit 200`,
      [wallet.toLowerCase()],
    );
    const out: TrackRecord = { deliveries: 0, paid: 0n, by_network: {}, recent: [] };
    for (const r of rows) {
      const amount = BigInt(r.amount ?? 0);
      out.deliveries += 1;
      out.paid += amount;
      const n = (out.by_network[r.network] ??= { deliveries: 0, paid: 0n });
      n.deliveries += 1;
      n.paid += amount;
      if (out.recent.length < 10) out.recent.push({ project: r.project, network: r.network, proof_url: r.proof_url, amount, tx: r.release_tx, at: new Date(r.created_at) });
    }
    return out;
  }

  /** Listed creators with at least one proven handle: the ones a business can be shown. */
  async directory(filter: { niche?: string; kind?: string; network?: string } = {}): Promise<(Creator & { proven: CreatorHandle[] })[]> {
    const { rows } = await this.sql.query(
      `select c.* from op_creator c where c.listed and exists (select 1 from op_creator_handle h where h.creator_id = c.id and h.verified_at is not null)
       order by c.updated_at desc limit 500`,
    );
    const out: (Creator & { proven: CreatorHandle[] })[] = [];
    for (const c of rows.map(asCreator)) {
      if (filter.niche && !c.niches.includes(filter.niche.toLowerCase())) continue;
      if (filter.kind && !c.kinds.includes(filter.kind)) continue;
      if (filter.network && c.networks.length && !c.networks.includes(filter.network)) continue;
      out.push({ ...c, proven: (await this.handles(c.id)).filter((h) => h.verified_at) });
    }
    return out;
  }

  /** Mark an application as made from this profile, so matches and records can follow it. */
  async linkApplicant(applicantId: string, creatorId: string): Promise<void> {
    await this.sql.query("update op_applicant set creator_id = $2 where id = $1", [applicantId, creatorId]);
  }

  /** The applications made from this profile, newest first, with where each one got to. */
  async applications(creatorId: string): Promise<{ id: string; token: string; project_id: string; task_id: string; status: string; created_at: Date }[]> {
    return (await this.sql.query<{ id: string; token: string; project_id: string; task_id: string; status: string; created_at: Date }>(
      "select id, token, project_id, task_id, status, created_at from op_applicant where creator_id = $1 order by created_at desc limit 50", [creatorId],
    )).rows;
  }
}

type Apply = (projectId: string, input: { taskId: string; handle: string; wallet: string; email?: string; pitch: string; samples: string[]; askedRateUsd?: number }) => Promise<{ id: string; token: string } | { error: string }>;

/**
 * Apply to a task from a profile: the hub's route and the chat both come here, so the rules are one set. A task on a
 * platform needs that platform's handle, proven; an article can be signed with any proven handle. The pitch is the
 * creator's, or else built from their bio.
 */
export async function applyFromProfile(
  deps: { book: CreatorBook; task: (id: string) => Promise<{ id: string; project_id: string; kind: string; open: boolean } | null>; network: (projectId: string) => Promise<string | null>; apply: Apply },
  c: Creator, taskId: string, opts: { pitch?: string; askedRateUsd?: number } = {},
): Promise<{ id: string; token: string; project: string; task: string; handle: string } | { code: string; error: string }> {
  const task = await deps.task(taskId);
  if (!task || !task.open) return { code: "INVALID_APPLICATION", error: "that task is not open" };
  const network = await deps.network(task.project_id);
  if (network && c.networks.length && !c.networks.includes(network)) return { code: "INVALID_APPLICATION", error: `your profile does not take payment on ${network}` };
  const proven = (await deps.book.handles(c.id)).filter((x) => x.verified_at);
  const need = PLATFORM_FOR_KIND[task.kind];
  const handle = need ? proven.find((x) => x.platform === need)?.handle : (proven.find((x) => x.platform === "x") ?? proven[0])?.handle;
  if (!handle) return { code: "UNPROVEN_HANDLE", error: need ? `this task needs a proven ${need} handle` : "prove one of your handles first" };
  const given = opts.pitch?.trim() ?? "";
  const pitch = given.length >= 20 ? given : [c.bio, c.niches.length ? `I make work about ${c.niches.join(", ")}.` : ""].join(" ").trim();
  if (pitch.length < 20) return { code: "INVALID_APPLICATION", error: "add a pitch, or a bio to your profile" };
  const out = await deps.apply(task.project_id, { taskId: task.id, handle, wallet: c.wallet, email: c.email ?? undefined, pitch, samples: c.samples, askedRateUsd: opts.askedRateUsd });
  if ("error" in out) return { code: "INVALID_APPLICATION", error: out.error };
  await deps.book.linkApplicant(out.id, c.id);
  return { id: out.id, token: out.token, project: task.project_id, task: task.id, handle };
}
