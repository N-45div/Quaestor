/**
 * Quaestor Operator's records: projects and their paid tasks, the people who apply, the deals
 * the operator agrees and escrows on-chain, the claims made against them, every decision with
 * its reasoning, payees' track records, and the heads-ups waiting for an owner.
 *
 * Amounts are USDC base units (6 decimals) in bigint columns. Anything with `query(text, params)`
 * returning `{ rows }` works: a pg Pool in the hub, PGlite in tests.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const SCHEMA = `
create table if not exists op_project (
  id text primary key,
  name text not null,
  owner_address text not null,
  network text not null,
  governor text,
  brief text not null,
  links jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create table if not exists op_task (
  id text primary key,
  project_id text not null references op_project(id),
  kind text not null,
  title text not null,
  done_when text not null,
  rate_min bigint not null,
  rate_max bigint not null,
  slots int not null default 10,
  open boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists op_applicant (
  id text primary key,
  project_id text not null references op_project(id),
  task_id text not null references op_task(id),
  handle text not null,
  wallet text not null,
  email text,
  pitch text not null,
  samples jsonb not null default '[]',
  asked_rate bigint,
  status text not null default 'new',
  score int,
  created_at timestamptz not null default now()
);
create index if not exists op_applicant_status on op_applicant (project_id, status);
create table if not exists op_deal (
  id text primary key,
  project_id text not null references op_project(id),
  applicant_id text not null references op_applicant(id),
  payee text not null,
  amount bigint not null,
  milestones jsonb not null,
  terms text not null,
  terms_hash text not null,
  deadline timestamptz not null,
  status text not null,
  access_token text not null unique,
  chain_tx text,
  created_at timestamptz not null default now()
);
create index if not exists op_deal_status on op_deal (project_id, status);
create table if not exists op_claim (
  id text primary key,
  deal_id text not null references op_deal(id),
  milestone int not null,
  proof_url text not null,
  proof_hash text not null unique,
  status text not null default 'new',
  amount bigint,
  verdict jsonb,
  release_tx text,
  created_at timestamptz not null default now()
);
create table if not exists op_decision (
  hash text primary key,
  project_id text not null references op_project(id),
  kind text not null,
  subject text not null,
  record text not null,
  created_at timestamptz not null default now()
);
create index if not exists op_decision_project on op_decision (project_id, created_at desc);
create table if not exists op_reputation (
  project_id text not null references op_project(id),
  payee text not null,
  delivered int not null default 0,
  late int not null default 0,
  rejected int not null default 0,
  paid bigint not null default 0,
  quality_sum int not null default 0,
  primary key (project_id, payee)
);
create table if not exists op_headsup (
  id text primary key,
  project_id text not null references op_project(id),
  kind text not null,
  subject text not null,
  text text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
`;

export async function migrate(sql: Sql): Promise<void> {
  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await sql.query(statement);
}

// ------------------------------------------------------------------ types

export interface Project {
  id: string;
  name: string;
  owner_address: string;
  network: string;
  governor: string | null;
  brief: string;
  links: string[];
}

export interface Task {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  done_when: string;
  rate_min: bigint;
  rate_max: bigint;
  slots: number;
  open: boolean;
}

export type ApplicantStatus = "new" | "rejected" | "offered" | "accepted" | "declined" | "escalated" | "waitlisted";

export interface Applicant {
  id: string;
  project_id: string;
  task_id: string;
  handle: string;
  wallet: string;
  email: string | null;
  pitch: string;
  samples: string[];
  asked_rate: bigint | null;
  status: ApplicantStatus;
  score: number | null;
  created_at: Date;
}

export interface Milestone {
  title: string;
  amount: string; // base units, as text in JSON
  criteria: string;
}

export type DealStatus = "offered" | "pending_owner" | "open" | "closed" | "cancelled" | "expired" | "declined";

export interface Deal {
  id: string;
  project_id: string;
  applicant_id: string;
  payee: string;
  amount: bigint;
  milestones: Milestone[];
  terms: string;
  terms_hash: string;
  deadline: Date;
  status: DealStatus;
  access_token: string;
  chain_tx: string | null;
  created_at: Date;
}

export type ClaimStatus = "new" | "paid" | "rejected" | "needs_owner";

export interface Claim {
  id: string;
  deal_id: string;
  milestone: number;
  proof_url: string;
  proof_hash: string;
  status: ClaimStatus;
  amount: bigint | null;
  verdict: Record<string, unknown> | null;
  release_tx: string | null;
  created_at: Date;
}

export interface Decision {
  hash: string;
  project_id: string;
  kind: string;
  subject: string;
  record: string;
  created_at: Date;
}

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(v as string | number | bigint));

function asTask(r: Record<string, unknown>): Task {
  return { ...(r as unknown as Task), rate_min: big(r.rate_min), rate_max: big(r.rate_max) };
}
function asApplicant(r: Record<string, unknown>): Applicant {
  return { ...(r as unknown as Applicant), asked_rate: r.asked_rate === null ? null : big(r.asked_rate) };
}
function asDeal(r: Record<string, unknown>): Deal {
  return { ...(r as unknown as Deal), amount: big(r.amount), deadline: new Date(r.deadline as string) };
}
function asClaim(r: Record<string, unknown>): Claim {
  return { ...(r as unknown as Claim), amount: r.amount === null ? null : big(r.amount) };
}

// ------------------------------------------------------------------ the store

export class Store {
  constructor(readonly sql: Sql) {}

  async project(id: string): Promise<Project | null> {
    const { rows } = await this.sql.query<Project>("select * from op_project where id = $1", [id]);
    return rows[0] ?? null;
  }

  async projects(): Promise<Project[]> {
    return (await this.sql.query<Project>("select * from op_project order by created_at")).rows;
  }

  async saveProject(p: Project): Promise<void> {
    await this.sql.query(
      `insert into op_project (id, name, owner_address, network, governor, brief, links) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set name = excluded.name, governor = excluded.governor, brief = excluded.brief, links = excluded.links`,
      [p.id, p.name, p.owner_address.toLowerCase(), p.network, p.governor, p.brief, JSON.stringify(p.links)],
    );
  }

  async saveTask(t: Task): Promise<void> {
    await this.sql.query(
      `insert into op_task (id, project_id, kind, title, done_when, rate_min, rate_max, slots, open) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set title = excluded.title, done_when = excluded.done_when, rate_min = excluded.rate_min,
         rate_max = excluded.rate_max, slots = excluded.slots, open = excluded.open`,
      [t.id, t.project_id, t.kind, t.title, t.done_when, t.rate_min.toString(), t.rate_max.toString(), t.slots, t.open],
    );
  }

  async tasks(projectId: string): Promise<Task[]> {
    return (await this.sql.query("select * from op_task where project_id = $1 order by created_at", [projectId])).rows.map(asTask);
  }

  async task(id: string): Promise<Task | null> {
    const { rows } = await this.sql.query("select * from op_task where id = $1", [id]);
    return rows[0] ? asTask(rows[0]) : null;
  }

  async addApplicant(a: Omit<Applicant, "status" | "score" | "created_at">): Promise<void> {
    await this.sql.query(
      `insert into op_applicant (id, project_id, task_id, handle, wallet, email, pitch, samples, asked_rate) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.project_id, a.task_id, a.handle, a.wallet.toLowerCase(), a.email, a.pitch, JSON.stringify(a.samples), a.asked_rate?.toString() ?? null],
    );
  }

  async applicants(projectId: string, status?: ApplicantStatus): Promise<Applicant[]> {
    const { rows } = status
      ? await this.sql.query("select * from op_applicant where project_id = $1 and status = $2 order by created_at", [projectId, status])
      : await this.sql.query("select * from op_applicant where project_id = $1 order by created_at", [projectId]);
    return rows.map(asApplicant);
  }

  async applicant(id: string): Promise<Applicant | null> {
    const { rows } = await this.sql.query("select * from op_applicant where id = $1", [id]);
    return rows[0] ? asApplicant(rows[0]) : null;
  }

  async setApplicant(id: string, status: ApplicantStatus, score?: number): Promise<void> {
    await this.sql.query("update op_applicant set status = $2, score = coalesce($3, score) where id = $1", [id, status, score ?? null]);
  }

  async saveDeal(d: Omit<Deal, "created_at">): Promise<void> {
    await this.sql.query(
      `insert into op_deal (id, project_id, applicant_id, payee, amount, milestones, terms, terms_hash, deadline, status, access_token, chain_tx)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do update set status = excluded.status, chain_tx = coalesce(excluded.chain_tx, op_deal.chain_tx)`,
      [d.id, d.project_id, d.applicant_id, d.payee.toLowerCase(), d.amount.toString(), JSON.stringify(d.milestones), d.terms, d.terms_hash,
        d.deadline.toISOString(), d.status, d.access_token, d.chain_tx],
    );
  }

  async setDeal(id: string, status: DealStatus, chainTx?: string): Promise<void> {
    await this.sql.query("update op_deal set status = $2, chain_tx = coalesce($3, chain_tx) where id = $1", [id, status, chainTx ?? null]);
  }

  async deal(id: string): Promise<Deal | null> {
    const { rows } = await this.sql.query("select * from op_deal where id = $1", [id]);
    return rows[0] ? asDeal(rows[0]) : null;
  }

  async dealByToken(token: string): Promise<Deal | null> {
    const { rows } = await this.sql.query("select * from op_deal where access_token = $1", [token]);
    return rows[0] ? asDeal(rows[0]) : null;
  }

  async deals(projectId: string, status?: DealStatus): Promise<Deal[]> {
    const { rows } = status
      ? await this.sql.query("select * from op_deal where project_id = $1 and status = $2 order by created_at", [projectId, status])
      : await this.sql.query("select * from op_deal where project_id = $1 order by created_at", [projectId]);
    return rows.map(asDeal);
  }

  async dealsForTask(taskId: string): Promise<Deal[]> {
    const { rows } = await this.sql.query(
      "select d.* from op_deal d join op_applicant a on a.id = d.applicant_id where a.task_id = $1 and d.status not in ('declined','cancelled','expired')",
      [taskId],
    );
    return rows.map(asDeal);
  }

  /** A claim, refused by the store itself if its proof was claimed before (unique proof_hash). */
  async addClaim(c: Omit<Claim, "status" | "amount" | "verdict" | "release_tx" | "created_at">): Promise<boolean> {
    const { rows } = await this.sql.query(
      `insert into op_claim (id, deal_id, milestone, proof_url, proof_hash) values ($1,$2,$3,$4,$5) on conflict (proof_hash) do nothing returning id`,
      [c.id, c.deal_id, c.milestone, c.proof_url, c.proof_hash],
    );
    return rows.length === 1;
  }

  async claims(dealId: string): Promise<Claim[]> {
    return (await this.sql.query("select * from op_claim where deal_id = $1 order by created_at", [dealId])).rows.map(asClaim);
  }

  async openClaims(projectId: string): Promise<Claim[]> {
    const { rows } = await this.sql.query(
      "select c.* from op_claim c join op_deal d on d.id = c.deal_id where d.project_id = $1 and c.status = 'new' order by c.created_at",
      [projectId],
    );
    return rows.map(asClaim);
  }

  async settleClaim(id: string, status: ClaimStatus, verdict: Record<string, unknown>, amount?: bigint, releaseTx?: string): Promise<void> {
    await this.sql.query("update op_claim set status = $2, verdict = $3, amount = $4, release_tx = $5 where id = $1", [
      id, status, JSON.stringify(verdict), amount?.toString() ?? null, releaseTx ?? null,
    ]);
  }

  async record(d: Omit<Decision, "created_at">): Promise<void> {
    await this.sql.query("insert into op_decision (hash, project_id, kind, subject, record) values ($1,$2,$3,$4,$5) on conflict (hash) do nothing", [
      d.hash, d.project_id, d.kind, d.subject, d.record,
    ]);
  }

  async decisions(projectId: string, limit = 100): Promise<Decision[]> {
    return (await this.sql.query<Decision>("select * from op_decision where project_id = $1 order by created_at desc limit $2", [projectId, limit])).rows;
  }

  async decision(hash: string): Promise<Decision | null> {
    const { rows } = await this.sql.query<Decision>("select * from op_decision where hash = $1", [hash]);
    return rows[0] ?? null;
  }

  async reputation(projectId: string, payee: string): Promise<{ delivered: number; late: number; rejected: number; paid: bigint; quality: number | null }> {
    const { rows } = await this.sql.query("select * from op_reputation where project_id = $1 and payee = $2", [projectId, payee.toLowerCase()]);
    const r = rows[0];
    if (!r) return { delivered: 0, late: 0, rejected: 0, paid: 0n, quality: null };
    const delivered = Number(r.delivered);
    return { delivered, late: Number(r.late), rejected: Number(r.rejected), paid: big(r.paid), quality: delivered ? Number(r.quality_sum) / delivered : null };
  }

  async bumpReputation(projectId: string, payee: string, change: { delivered?: number; late?: number; rejected?: number; paid?: bigint; quality?: number }): Promise<void> {
    await this.sql.query(
      `insert into op_reputation (project_id, payee, delivered, late, rejected, paid, quality_sum) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (project_id, payee) do update set delivered = op_reputation.delivered + excluded.delivered,
         late = op_reputation.late + excluded.late, rejected = op_reputation.rejected + excluded.rejected,
         paid = op_reputation.paid + excluded.paid, quality_sum = op_reputation.quality_sum + excluded.quality_sum`,
      [projectId, payee.toLowerCase(), change.delivered ?? 0, change.late ?? 0, change.rejected ?? 0, (change.paid ?? 0n).toString(), change.quality ?? 0],
    );
  }

  async headsUp(h: { id: string; project_id: string; kind: string; subject: string; text: string }): Promise<void> {
    await this.sql.query("insert into op_headsup (id, project_id, kind, subject, text) values ($1,$2,$3,$4,$5) on conflict (id) do nothing", [
      h.id, h.project_id, h.kind, h.subject, h.text,
    ]);
  }

  async headsUps(projectId: string, status = "open"): Promise<{ id: string; kind: string; subject: string; text: string; created_at: Date }[]> {
    return (await this.sql.query<{ id: string; kind: string; subject: string; text: string; created_at: Date }>(
      "select id, kind, subject, text, created_at from op_headsup where project_id = $1 and status = $2 order by created_at desc", [projectId, status],
    )).rows;
  }

  async closeHeadsUp(id: string, status: "done" | "dismissed"): Promise<void> {
    await this.sql.query("update op_headsup set status = $2 where id = $1", [id, status]);
  }
}
