/**
 * Quaestor Operator on the hub: each project's public page and application form, each
 * applicant's private link, the owner's dashboard and answers, and the loop that runs it all.
 *
 *   GET  /v1/operator                                   networks, the operator's address on each, projects
 *   GET  /v1/operator/projects/:id                      a project's page: brief, open tasks, budget, what it paid for
 *   POST /v1/operator/projects/:id/apply                {taskId, handle, wallet, email?, pitch, samples[], askedRateUsd?}
 *   GET  /v1/operator/decisions/:hash                   the record behind a payment; keccak256 of its text is the hash on-chain
 *   GET  /v1/operator/me/:token                         an applicant's own view: status, offer, deal, claims
 *   GET  /v1/operator/me/:token/route?domain=6&recipient=0x…   typed data to sign, to be paid on another chain
 *   POST /v1/operator/me/:token/accept                  {route?: {domain, recipient, deadline, signature}}
 *   POST /v1/operator/me/:token/decline
 *   POST /v1/operator/me/:token/claim                   {milestone, url}
 *
 * The owner signs ownerMessage(project, expires) with the governor's owner wallet, and sends
 * X-Owner-Address, X-Owner-Expires (unix seconds) and X-Owner-Signature with each request:
 *
 *   POST /v1/operator/projects                          register a project whose governor names this operator
 *   GET  /v1/operator/projects/:id/owner                heads-ups, applicants, deals, claims, decisions, payees, limits
 *   POST /v1/operator/projects/:id/tasks                add or change a task
 *   POST /v1/operator/projects/:id/applicants/:aid      {action: rescreen | reject}
 *   POST /v1/operator/projects/:id/claims/:cid          {payFraction}
 *   POST /v1/operator/projects/:id/headsups/:hid        {status: done | dismissed}
 *   POST /v1/operator/projects/:id/run                  run the loop for this project now
 *
 *   OP_NETWORKS=arc-testnet,mezo-testnet which rows of operator/networks.ts to serve
 *   OP_KEY_ARC_TESTNET=0x…               the operator's key there (never logged), or instead
 *   OP_DYNAMIC_WALLET_MEZO_TESTNET={…}   a Dynamic MPC wallet as the operator (two of two: this hub's share and Dynamic's), with
 *   DYNAMIC_ENVIRONMENT_ID, DYNAMIC_AUTH_TOKEN, DYNAMIC_WALLET_PASSWORD  (runs/dynamic-operator-wallet.cjs makes it), or
 *   OP_CIRCLE_WALLET_ARC_TESTNET=<id>    a Circle developer-controlled wallet as the operator, with
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET  (scripts/circle-operator-wallet.ts makes all three)
 *   OP_RPC_ARC_TESTNET=https://…         optional RPC override
 *   OPERATOR_DATABASE_URL=postgres://…   the records; without it, an in-memory database lost on restart
 *   ANTHROPIC_API_KEY=…                  Claude decides; or else
 *   MOONSHOT_API_KEY=…, KIMI_MODEL=…     Kimi decides; with neither, applications queue and nothing is decided
 *   OP_TICK_MS=60000                     how often the loop runs
 *   OP_PROJECTS_FILE=a.json,b.json       projects to register at boot, such as the house projects
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import * as fs from "node:fs";
import { ethers } from "ethers";
import { Store, migrate, type Project, type Sql, type Task } from "../operator/db";
import { Operator, OFFER_DAYS, claimCode, lapseOf, toUsd, fromUsd, type Notice } from "../operator/agent";
import { ClaudeDecider, DecisionUnavailable, KIMI_MODEL, KimiDecider, type Decider } from "../operator/decide";
import { CCTP_DOMAINS, GovernorClient, KeySender, type Sender } from "../operator/chain";
import { CircleClient, CircleSender } from "../operator/circle";
import { dynamicEvmSignerFromEnv, type DynamicEvmSigner } from "../sdk/dynamic-evm-signer";
import { KimiChat, OperatorChat, type Draft, type OpenedCampaign } from "../operator/chat";
import { campaignPlan, openGovernorFor } from "../operator/campaign";
import { OP_NETWORKS, explorerAddress, explorerTx, type OpNetwork } from "../operator/networks";
import type { Evidence } from "../operator/verify";
import { CreatorBook, PLATFORMS, TASK_KINDS, applyFromProfile, creatorInput, normalHandle, type Creator, type CreatorHandle, type CreatorInput, type Platform, type TrackRecord } from "../operator/creators";
import { rateLimit } from "./hardening";
import { safeMessage } from "../stocks/redact";

export interface OperatorLane {
  network: OpNetwork;
  provider: ethers.Provider;
  sender: Sender;
}

export interface OperatorContext {
  store: Store;
  operator: Operator;
  lanes: Map<string, OperatorLane>;
  /** False when no model is configured: applications queue, and nothing is decided. */
  deciding: boolean;
  /** The model that decides, when one does. */
  model?: string;
  /** Creator profiles across projects; made from the store's database when left out. */
  creators?: CreatorBook;
  /** The conversation for businesses and creators, when a model that calls tools is configured. */
  chat?: OperatorChat;
}

export interface OperatorEnv {
  lanes: { network: OpNetwork; rpcUrl: string; key?: string; circleWallet?: string; dynamic?: DynamicEvmSigner }[];
  circle?: { apiKey: string; entitySecret: string };
  databaseUrl?: string;
  model: { provider: "claude" } | { provider: "kimi"; apiKey: string; name: string } | null;
  tickMs: number;
  projectsFile?: string;
}

const envKey = (key: string) => key.toUpperCase().replace(/-/g, "_");

export function operatorFromEnv(env: NodeJS.ProcessEnv = process.env): OperatorEnv | null {
  const keys = (env.OP_NETWORKS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const lanes: OperatorEnv["lanes"] = [];
  for (const key of keys) {
    const network = OP_NETWORKS[key];
    const k = envKey(key);
    const opKey = env[`OP_KEY_${k}`] ?? "";
    const circleWallet = env[`OP_CIRCLE_WALLET_${k}`] ?? "";
    if (!network || !network.factory) {
      console.error(`[operator] "${key}" is not a network with a payouts factory; known: ${Object.keys(OP_NETWORKS).join(", ")}`);
      continue;
    }
    const rpcUrl = env[`OP_RPC_${k}`] ?? network.rpcUrl;
    // An MPC wallet or a key held by Circle is preferred: then no whole operator key lives on this hub. A Dynamic wallet
    // named but set up wrong throws here, rather than quietly falling back to a key.
    const dynamic = dynamicEvmSignerFromEnv(`OP_DYNAMIC_WALLET_${k}`, env);
    if (dynamic) lanes.push({ network, rpcUrl, dynamic });
    else if (circleWallet && env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET) lanes.push({ network, rpcUrl, circleWallet });
    else if (/^0x[0-9a-fA-F]{64}$/.test(opKey)) lanes.push({ network, rpcUrl, key: opKey });
    else console.error(`[operator] none of OP_DYNAMIC_WALLET_${k}, OP_CIRCLE_WALLET_${k} (with CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET) or OP_KEY_${k} is set; ${network.name} not served`);
  }
  if (!lanes.length) return null;
  return {
    lanes,
    circle: env.CIRCLE_API_KEY && env.CIRCLE_ENTITY_SECRET ? { apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET } : undefined,
    databaseUrl: env.OPERATOR_DATABASE_URL || undefined,
    model: env.ANTHROPIC_API_KEY ? { provider: "claude" }
      : env.MOONSHOT_API_KEY ? { provider: "kimi", apiKey: env.MOONSHOT_API_KEY, name: env.KIMI_MODEL || KIMI_MODEL }
      : null,
    tickMs: Math.max(15_000, Number(env.OP_TICK_MS ?? 60_000)),
    projectsFile: env.OP_PROJECTS_FILE || undefined,
  };
}

/** No model configured: every decision becomes a question for the owner. */
class NoDecider implements Decider {
  private fail(): never {
    throw new DecisionUnavailable("no model is configured on this hub");
  }
  screen = async () => this.fail();
  verify = async () => this.fail();
  brief = async () => this.fail();
}

export async function operatorContextFromEnv(cfg: OperatorEnv): Promise<OperatorContext> {
  let sql: Sql;
  if (cfg.databaseUrl) {
    const { Pool } = await import("pg");
    sql = new Pool({ connectionString: cfg.databaseUrl, max: 5 }) as unknown as Sql;
  } else {
    console.warn("[operator] OPERATOR_DATABASE_URL is not set: records live in memory and go with a restart");
    const { PGlite } = await import("@electric-sql/pglite");
    sql = new PGlite() as unknown as Sql;
  }
  await migrate(sql);
  const store = new Store(sql);
  const lanes = new Map<string, OperatorLane>();
  const circle = cfg.circle ? new CircleClient(cfg.circle) : null;
  for (const l of cfg.lanes) {
    const provider = new ethers.JsonRpcProvider(l.rpcUrl, l.network.chainId, { staticNetwork: true, batchMaxCount: 1 });
    let sender: Sender;
    if (l.dynamic) {
      const signer = l.dynamic.connect(provider);
      await signer.warm(); // a bad token or share shows at boot, not at the first payment
      sender = new KeySender(signer);
    } else if (l.circleWallet && circle) sender = await CircleSender.open(circle, l.circleWallet, l.network.circleChain, provider);
    else sender = new KeySender(new ethers.Wallet(l.key!, provider));
    lanes.set(l.network.key, { network: l.network, provider, sender });
    console.log(`[operator] ${l.network.name}: operator ${sender.address}${l.dynamic ? " (a Dynamic MPC wallet)" : l.circleWallet ? " (a Circle wallet)" : ""}`);
  }
  // One file per house budget (Arc, Mezo); a project on a network this hub does not serve is left out.
  for (const file of (cfg.projectsFile ?? "").split(",").map((f) => f.trim()).filter(Boolean)) {
    const seed = (JSON.parse(fs.readFileSync(file, "utf8")) as SeedProject[]).filter((p) => lanes.has(p.network));
    await seedProjects(store, seed);
  }
  const decider: Decider = cfg.model?.provider === "claude" ? new ClaudeDecider()
    : cfg.model?.provider === "kimi" ? new KimiDecider(cfg.model.apiKey, cfg.model.name)
    : new NoDecider();
  if (decider.model) console.log(`[operator] decisions by ${decider.model}`);
  const operator = operatorFor(store, decider, lanes);
  const creators = new CreatorBook(sql);
  // The chat talks through Kimi's tool calls; it needs Kimi on this hub.
  const chat = cfg.model?.provider === "kimi"
    ? new OperatorChat({
      sql, store, book: creators, model: new KimiChat(cfg.model.apiKey, cfg.model.name),
      networks: [...lanes.values()].map((l) => ({ key: l.network.key, name: l.network.name, token: l.network.tokenSymbol })),
      apply: (pid, input) => operator.apply(pid, input), mezo: lanes.get("mezo-testnet")?.provider,
      campaigns: { open: (draft, owner) => openCampaign(store, lanes, draft, owner), budget: (pid) => budgetOf(store, lanes, pid) },
      deals: { accept: (t) => operator.accept(t), decline: (t) => operator.decline(t), claim: (t, m, u) => operator.claim(t, m, u) },
    })
    : undefined;
  if (chat) console.log("[operator] chat on, for businesses and creators");
  return { store, lanes, deciding: !!decider.model, model: decider.model, operator, creators, chat };
}

/** A project id from its name, made unique among the hub's projects. */
async function freeProjectId(store: Store, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "") || "campaign";
  for (let i = 0; i < 8; i++) {
    const id = i === 0 && base.length >= 3 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!(await store.project(id))) return id;
  }
  throw new Error("could not find a free id for the campaign");
}

/**
 * Open a drafted campaign for a business that connects no wallet: the lane's operator key opens the governor with the
 * business's address as owner, and the project is registered with its tasks closed until the budget arrives.
 */
export async function openCampaign(store: Store, lanes: Map<string, OperatorLane>, draft: Draft, owner: string): Promise<OpenedCampaign> {
  const lane = lanes.get(draft.network);
  if (!lane) throw new Error(`${draft.network} is not served by this hub`);
  if (owner.toLowerCase() === lane.sender.address.toLowerCase()) throw new Error("the owner must be the business's own address, not the operator's");
  const plan = campaignPlan(draft.tasks);
  const { governor, tx } = await openGovernorFor(lane, owner, plan);
  const id = await freeProjectId(store, draft.name);
  await store.saveProject({ id, name: draft.name, owner_address: owner, network: lane.network.key, governor, brief: draft.brief, links: [] });
  const taskIds: string[] = [];
  for (const [i, t] of draft.tasks.entries()) {
    const task = taskFrom(id, { ...t, id: draft.tasks.findIndex((x) => x.title === t.title) === i ? t.title : `${t.title} ${i + 1}`, open: false });
    await store.saveTask(task);
    taskIds.push(task.id);
  }
  console.log(`[operator] campaign ${id} opened for ${owner} at ${governor} (${lane.network.name}, tx ${tx})`);
  return {
    project_id: id, name: draft.name, network: lane.network.key, network_name: lane.network.name, token: lane.network.tokenSymbol,
    governor, governor_url: explorerAddress(lane.network, governor), owner: ethers.getAddress(owner), operator: lane.sender.address,
    tx, tx_url: explorerTx(lane.network, tx), task_ids: taskIds,
    limits: { budget_usd: plan.budgetUsd, per_deal_usd: plan.perDealUsd, per_week_usd: plan.periodUsd },
  };
}

/** What a project's governor holds, in dollars: free to spend, and escrowed in open deals. */
export async function budgetOf(store: Store, lanes: Map<string, OperatorLane>, projectId: string): Promise<{ free_usd: number; escrowed_usd: number } | null> {
  const p = await store.project(projectId);
  const lane = p && lanes.get(p.network);
  if (!p?.governor || !lane) return null;
  const l = await new GovernorClient(p.governor, lane.provider, lane.sender, lane.network.tokenDecimals).limits();
  return { free_usd: toUsd(l.freeBalance), escrowed_usd: toUsd(l.committed) };
}

export function operatorFor(store: Store, decider: Decider, lanes: Map<string, OperatorLane>, extra: { evidence?: (url: string) => Promise<Evidence>; now?: () => Date } = {}): Operator {
  const clients = new Map<string, GovernorClient>();
  return new Operator({
    store,
    decider,
    governorFor: (p) => {
      const lane = lanes.get(p.network);
      if (!lane || !p.governor) return null;
      const key = `${p.network}:${p.governor}`;
      if (!clients.has(key)) clients.set(key, new GovernorClient(p.governor, lane.provider, lane.sender, lane.network.tokenDecimals));
      return clients.get(key)!;
    },
    iris: (p) => lanes.get(p.network)?.network.iris,
    log: (line) => console.log(line),
    ...extra,
  });
}

interface SeedProject extends Omit<Project, "links"> {
  links?: string[];
  tasks: (Omit<Task, "project_id" | "rate_min" | "rate_max" | "open"> & { rate_min_usd: number; rate_max_usd: number; open?: boolean })[];
}

async function seedProjects(store: Store, projects: SeedProject[]): Promise<void> {
  for (const p of projects) {
    await store.saveProject({ id: p.id, name: p.name, owner_address: p.owner_address, network: p.network, governor: p.governor, brief: p.brief, links: p.links ?? [] });
    for (const t of p.tasks) {
      await store.saveTask({ id: t.id, project_id: p.id, kind: t.kind, title: t.title, done_when: t.done_when, rate_min: fromUsd(t.rate_min_usd), rate_max: fromUsd(t.rate_max_usd), slots: t.slots, open: t.open ?? true });
    }
  }
}

// ------------------------------------------------------------------ owner access

export function ownerMessage(projectId: string, expires: number): string {
  return `Quaestor Operator owner access\nproject: ${projectId}\nexpires: ${new Date(expires * 1000).toISOString()}`;
}

const ERC1271_ABI = ["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"];

/** A signature by an EOA, or by a contract wallet that vouches for it (ERC-1271). */
async function signedBy(provider: ethers.Provider, address: string, message: string, signature: string): Promise<boolean> {
  try {
    if (ethers.verifyMessage(message, signature).toLowerCase() === address.toLowerCase()) return true;
  } catch {
    // not an EOA signature; a contract wallet may still vouch for it
  }
  if ((await provider.getCode(address)) === "0x") return false;
  try {
    const magic = await new ethers.Contract(address, ERC1271_ABI, provider).isValidSignature(ethers.hashMessage(message), signature);
    return magic === "0x1626ba7e";
  } catch {
    return false;
  }
}

const GOVERNOR_OWNER_ABI = ["function owner() view returns (address)", "function operator() view returns (address)", "function routeNonces(address) view returns (uint256)"];

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** The signer, when the request carries a live signature by the governor's owner. */
async function ownerOf(ctx: OperatorContext, req: Request, projectId: string, governor: string, lane: OperatorLane): Promise<string> {
  const address = String(req.header("x-owner-address") ?? "");
  const expires = Number(req.header("x-owner-expires") ?? 0);
  const signature = String(req.header("x-owner-signature") ?? "");
  const now = Math.floor(Date.now() / 1000);
  if (!ethers.isAddress(address) || !signature) throw new HttpError(401, "OWNER_SIGNATURE_REQUIRED", "sign ownerMessage(project, expires) with the governor's owner wallet");
  if (!(expires > now && expires <= now + 7 * 86_400)) throw new HttpError(401, "OWNER_SIGNATURE_EXPIRED", "the signature has expired, or lasts longer than a week");
  if (!(await signedBy(lane.provider, address, ownerMessage(projectId, expires), signature))) throw new HttpError(401, "BAD_OWNER_SIGNATURE", "the signature does not match the address");
  const owner = String(await new ethers.Contract(governor, GOVERNOR_OWNER_ABI, lane.provider).owner());
  if (owner.toLowerCase() !== address.toLowerCase()) throw new HttpError(403, "NOT_THE_OWNER", "only the governor's owner may do this");
  return owner;
}

// ------------------------------------------------------------------ shapes


function publicTask(t: Task, taken: number) {
  return { id: t.id, kind: t.kind, title: t.title, done_when: t.done_when, rate_min_usd: toUsd(t.rate_min), rate_max_usd: toUsd(t.rate_max), slots: t.slots, slots_left: Math.max(0, t.slots - taken), open: t.open };
}

function limitsUsd(l: Awaited<ReturnType<GovernorClient["limits"]>>) {
  return {
    free_usd: toUsd(l.freeBalance), escrowed_usd: toUsd(l.committed), paid_this_period_usd: toUsd(l.paidInEpoch), period_cap_usd: toUsd(l.epochCap),
    per_deal_cap_usd: toUsd(l.perDealCap), new_payee_cap_usd: toUsd(l.newPayeeCap), new_payees_per_period: l.newPayeesPerEpoch,
    period_days: l.epochLength / 86_400, suspended: l.suspended, cross_chain: l.crossChain, max_forward_fee_bps: l.maxForwardFeeBps,
  };
}

const PUBLIC_DECISIONS = new Set(["open_deal", "verify", "owner_verify"]);
const chainName = (domain: number) => Object.values(CCTP_DOMAINS).find((c) => c.domain === domain)?.name ?? `domain ${domain}`;

// ------------------------------------------------------------------ routes

export function mountOperator(app: Express, context: OperatorContext | Promise<OperatorContext>, opts: { tickMs?: number } = {}): void {
  const ready = Promise.resolve(context);
  ready.catch((err) => console.error(`[operator] did not start: ${safeMessage(err, 200)}`));
  const r = express.Router();
  r.use(express.json({ limit: "32kb" }));

  type Handler = (ctx: OperatorContext, req: Request, res: Response) => Promise<void>;
  const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
    ready.then((ctx) => fn(ctx, req, res)).catch((err) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      next(err);
    });
  };
  const bad = (code: string, message: string) => new HttpError(400, code, message);
  const projectOr404 = async (ctx: OperatorContext, id: string) => {
    const p = await ctx.store.project(id);
    if (!p) throw new HttpError(404, "NO_SUCH_PROJECT", "no such project");
    return p;
  };
  const laneOf = (ctx: OperatorContext, p: Project) => {
    const lane = ctx.lanes.get(p.network);
    if (!lane) throw new HttpError(503, "NETWORK_NOT_SERVED", `${p.network} is not served by this hub`);
    return lane;
  };
  const governorOf = (ctx: OperatorContext, p: Project) => {
    const lane = laneOf(ctx, p);
    if (!p.governor) throw new HttpError(409, "NO_GOVERNOR", "the project has no budget on-chain yet");
    return new GovernorClient(p.governor, lane.provider, lane.sender, lane.network.tokenDecimals);
  };
  const notice = (res: Response, n: Notice) => {
    res.status(n.kind === "error" ? 409 : 200).json(n.kind === "error" ? { error: { code: "REFUSED", message: n.detail } } : n);
  };

  // ---------------------------------------------------------------- public

  r.get("/", h(async (ctx, _req, res) => {
    const projects = await ctx.store.projects();
    res.json({
      service: "quaestor-operator",
      what: "A growth agent that pays real people per checked, disclosed post, video, article or pull request, from a USDC budget on Arc or a MUSD budget on Mezo.",
      deciding: ctx.deciding,
      model: ctx.model ?? null,
      networks: [...ctx.lanes.values()].map((l) => ({
        key: l.network.key, name: l.network.name, chain_id: l.network.chainId, rpc_url: l.network.rpcUrl, operator: l.sender.address, factory: l.network.factory,
        usdc: l.network.usdc, token_symbol: l.network.tokenSymbol, token_decimals: l.network.tokenDecimals, gas_symbol: l.network.gasSymbol, gas_grant: l.network.gasGrant,
        token_messenger: l.network.tokenMessenger, explorer: l.network.explorer, testnet: l.network.testnet,
      })),
      projects: projects.map((p) => ({ id: p.id, name: p.name, network: p.network, governor: p.governor })),
    });
  }));

  r.get("/projects/:id", h(async (ctx, req, res) => {
    const p = await projectOr404(ctx, req.params.id);
    const lane = ctx.lanes.get(p.network);
    const tasks = await ctx.store.tasks(p.id);
    const taken = await Promise.all(tasks.map(async (t) => (await ctx.store.dealsForTask(t.id)).length));
    const limits = lane && p.governor ? limitsUsd(await governorOf(ctx, p).limits()) : null;
    const payments = await ctx.store.payments(p.id, 30);
    const totals = await ctx.store.activity(p.id, new Date(0));
    res.json({
      project: { id: p.id, name: p.name, brief: p.brief, links: p.links, network: p.network, governor: p.governor, governor_url: lane && p.governor ? explorerAddress(lane.network, p.governor) : null },
      tasks: tasks.map((t, i) => publicTask(t, taken[i])).filter((t) => t.open),
      budget: limits,
      totals: { applications: totals.applications, deals: totals.deals, paid_deliveries: totals.paid_claims, paid_usd: toUsd(totals.paid) },
      payments: payments.map((x) => ({
        handle: x.handle, proof_url: x.proof_url, amount_usd: toUsd(x.amount), tx: x.release_tx, tx_url: lane ? explorerTx(lane.network, x.release_tx) : null, decision: x.decision, at: x.at,
      })),
    });
  }));

  r.post("/projects/:id/apply", h(async (ctx, req, res) => {
    const p = await projectOr404(ctx, req.params.id);
    const b = req.body ?? {};
    if (typeof b.taskId !== "string" || typeof b.handle !== "string" || typeof b.wallet !== "string" || typeof b.pitch !== "string") {
      throw bad("INVALID_APPLICATION", "taskId, handle, wallet and pitch are required");
    }
    if (b.pitch.trim().length < 20) throw bad("INVALID_APPLICATION", "say a little more about why you, and what you would make");
    const out = await ctx.operator.apply(p.id, {
      taskId: b.taskId, handle: b.handle, wallet: b.wallet, email: typeof b.email === "string" ? b.email : undefined, pitch: b.pitch,
      samples: Array.isArray(b.samples) ? b.samples.filter((s: unknown): s is string => typeof s === "string") : [],
      askedRateUsd: typeof b.askedRateUsd === "number" ? b.askedRateUsd : undefined,
    });
    if ("error" in out) throw bad("INVALID_APPLICATION", out.error);
    res.status(201).json({ id: out.id, token: out.token, note: "Keep this token: it is your private link to your application, offer and payments." });
  }));

  // ---------------------------------------------------------------- the creator book

  const book = (ctx: OperatorContext) => (ctx.creators ??= new CreatorBook(ctx.store.sql));
  const applyDeps = (ctx: OperatorContext) => ({
    book: book(ctx), task: (id: string) => ctx.store.task(id), network: async (pid: string) => (await ctx.store.project(pid))?.network ?? null,
    apply: (pid: string, input: Parameters<Operator["apply"]>[1]) => ctx.operator.apply(pid, input),
  });
  const creatorOr404 = async (ctx: OperatorContext, token: string) => {
    const c = await book(ctx).byToken(token);
    if (!c) throw new HttpError(404, "NO_SUCH_CREATOR", "no such creator link");
    return c;
  };
  const recordView = (ctx: OperatorContext, r: TrackRecord) => ({
    deliveries: r.deliveries, paid_usd: toUsd(r.paid),
    by_network: Object.fromEntries(Object.entries(r.by_network).map(([k, v]) => [k, { deliveries: v.deliveries, paid_usd: toUsd(v.paid) }])),
    recent: r.recent.map((x) => {
      const lane = ctx.lanes.get(x.network);
      return { project: x.project, network: x.network, proof_url: x.proof_url, amount_usd: toUsd(x.amount), tx: x.tx, tx_url: lane ? explorerTx(lane.network, x.tx) : null, at: x.at };
    }),
  });
  const profileView = (c: Creator) => ({
    id: c.id, name: c.name, bio: c.bio, niches: c.niches, kinds: c.kinds, samples: c.samples, wallet: c.wallet, networks: c.networks,
    rate_min_usd: c.rate_min === null ? null : toUsd(c.rate_min), rate_max_usd: c.rate_max === null ? null : toUsd(c.rate_max),
  });
  const handleView = (x: CreatorHandle, own: boolean) => ({ platform: x.platform, handle: x.handle, proven: !!x.verified_at, proof_url: x.proof_url, ...(own && !x.verified_at ? { code: x.code } : {}) });
  const PROVE_HOW: Record<Platform, string> = {
    x: "Post the code from this account on X, then send the post's link.",
    youtube: "Put the code in the title of a video on this channel (unlisted is fine), then send the video's link.",
    github: "Make a public gist from this account containing the code, then send the gist's link.",
  };
  const privateView = async (ctx: OperatorContext, c: Creator) => ({
    ...profileView(c), email: c.email, listed: c.listed,
    handles: (await book(ctx).handles(c.id)).map((x) => ({ ...handleView(x, true), ...(x.verified_at ? {} : { how: PROVE_HOW[x.platform] }) })),
    invites: await Promise.all((await book(ctx).invites(c.id)).map(async (i) => {
      const t = await ctx.store.task(i.task_id);
      return { task_id: i.task_id, project_id: i.project_id, title: t?.title ?? i.task_id, kind: t?.kind ?? null, rate_min_usd: t ? toUsd(t.rate_min) : null, rate_max_usd: t ? toUsd(t.rate_max) : null, note: i.note, status: i.status, at: i.created_at };
    })),
    record: recordView(ctx, await book(ctx).record(c.wallet)),
  });

  r.post("/creators", h(async (ctx, req, res) => {
    const b = req.body ?? {};
    const input = creatorInput(b, [...ctx.lanes.keys()], true);
    if ("error" in input) throw bad("INVALID_PROFILE", input.error);
    const made = await book(ctx).create(input as CreatorInput & { name: string; wallet: string }, typeof b.handles === "object" && b.handles ? b.handles : {});
    if ("error" in made) throw bad("INVALID_PROFILE", made.error);
    res.status(201).json({ ...(await privateView(ctx, made.creator)), token: made.creator.token, note: "Keep this token: it is your private link to your profile, matches and payments." });
  }));

  r.get("/creators/me/:token", h(async (ctx, req, res) => {
    res.json(await privateView(ctx, await creatorOr404(ctx, req.params.token)));
  }));

  r.post("/creators/me/:token", h(async (ctx, req, res) => {
    const c = await creatorOr404(ctx, req.params.token);
    const input = creatorInput(req.body ?? {}, [...ctx.lanes.keys()], false);
    if ("error" in input) throw bad("INVALID_PROFILE", input.error);
    res.json(await privateView(ctx, await book(ctx).update(c.id, input)));
  }));

  r.post("/creators/me/:token/handles", h(async (ctx, req, res) => {
    const c = await creatorOr404(ctx, req.params.token);
    const platform = String(req.body?.platform ?? "") as Platform;
    if (!PLATFORMS.includes(platform)) throw bad("INVALID_HANDLE", `platform is one of ${PLATFORMS.join(", ")}`);
    const handle = normalHandle(platform, String(req.body?.handle ?? ""));
    if (!handle) throw bad("INVALID_HANDLE", `that is not a ${platform} handle`);
    const x = await book(ctx).setHandle(c.id, platform, handle);
    res.json({ ...handleView(x, true), how: PROVE_HOW[platform] });
  }));

  r.post("/creators/me/:token/verify", h(async (ctx, req, res) => {
    const c = await creatorOr404(ctx, req.params.token);
    const platform = String(req.body?.platform ?? "") as Platform;
    if (!PLATFORMS.includes(platform) || typeof req.body?.url !== "string") throw bad("INVALID_PROOF", "platform and url are required");
    const out = await book(ctx).verify(c.id, platform, req.body.url);
    if (!out.ok) throw new HttpError(422, "NOT_PROVEN", out.error);
    res.json(handleView(out.handle, true));
  }));

  r.post("/creators/me/:token/apply", h(async (ctx, req, res) => {
    const c = await creatorOr404(ctx, req.params.token);
    const b = req.body ?? {};
    const out = await applyFromProfile(applyDeps(ctx), c, typeof b.taskId === "string" ? b.taskId : "", {
      pitch: typeof b.pitch === "string" ? b.pitch : undefined, askedRateUsd: typeof b.askedRateUsd === "number" ? b.askedRateUsd : undefined,
    });
    if ("error" in out) throw bad(out.code, out.error);
    res.status(201).json(out);
  }));

  r.post("/creators/me/:token/invites/:taskId/decline", h(async (ctx, req, res) => {
    const c = await creatorOr404(ctx, req.params.token);
    await book(ctx).answerInvite(req.params.taskId, c.id, "declined");
    res.json({ declined: req.params.taskId });
  }));

  r.get("/creators", h(async (ctx, req, res) => {
    const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
    const list = await book(ctx).directory({ niche: q("niche"), kind: q("kind"), network: q("network") });
    res.json({ creators: list.map((c) => ({ ...profileView(c), handles: c.proven.map((x) => handleView(x, false)) })) });
  }));

  r.get("/creators/:id", h(async (ctx, req, res) => {
    const c = await book(ctx).byId(req.params.id);
    const proven = c ? (await book(ctx).handles(c.id)).filter((x) => x.verified_at) : [];
    if (!c || !c.listed || !proven.length) throw new HttpError(404, "NO_SUCH_CREATOR", "no such creator");
    res.json({ ...profileView(c), handles: proven.map((x) => handleView(x, false)), record: recordView(ctx, await book(ctx).record(c.wallet)) });
  }));

  // ---------------------------------------------------------------- the chat

  r.post("/chat", h(async (ctx, req, res) => {
    if (!ctx.chat) throw new HttpError(503, "NO_CHAT", "the chat needs a model that calls tools on this hub");
    const b = req.body ?? {};
    if (typeof b.message !== "string" || !b.message.trim()) throw bad("INVALID_MESSAGE", "message is required");
    try {
      res.json(await ctx.chat.say({
        message: b.message, token: typeof b.session === "string" ? b.session : undefined, role: b.role === "creator" ? "creator" : "business",
        creatorToken: typeof b.creator_token === "string" ? b.creator_token : undefined,
      }));
    } catch (err) {
      throw new HttpError(502, "MODEL_UNAVAILABLE", `the model did not answer: ${safeMessage(err, 160)}`);
    }
  }));

  r.get("/chat/:token", h(async (ctx, req, res) => {
    const t = ctx.chat ? await ctx.chat.transcript(req.params.token) : null;
    if (!t) throw new HttpError(404, "NO_SUCH_CHAT", "no such conversation");
    res.json(t);
  }));

  r.get("/decisions/:hash", h(async (ctx, req, res) => {
    const d = await ctx.store.decision(req.params.hash);
    if (!d || !PUBLIC_DECISIONS.has(d.kind)) throw new HttpError(404, "NO_SUCH_DECISION", "no public decision with that hash");
    res.json({ hash: d.hash, kind: d.kind, subject: d.subject, at: d.created_at, record: d.record, check: "keccak256(utf8(record)) equals hash", parsed: JSON.parse(d.record) });
  }));

  // ---------------------------------------------------------------- the applicant's link

  const mine = async (ctx: OperatorContext, token: string) => {
    const a = await ctx.store.applicantByToken(token);
    if (!a) throw new HttpError(404, "NO_SUCH_LINK", "no application on this link");
    const p = (await ctx.store.project(a.project_id))!;
    return { a, p, deal: await ctx.store.dealForApplicant(a.id) };
  };

  r.get("/me/:token", h(async (ctx, req, res) => {
    const { a, p, deal } = await mine(ctx, req.params.token);
    const lane = ctx.lanes.get(p.network);
    const task = await ctx.store.task(a.task_id);
    const screen = await ctx.store.lastDecision(p.id, "screen", a.id);
    const reasoning = screen ? String((JSON.parse(screen.record) as { reasoning?: string }).reasoning ?? "") : null;
    const claims = deal ? await ctx.store.claims(deal.id) : [];
    const route = deal && lane && p.governor ? await governorOf(ctx, p).route(deal.payee) : null;
    res.json({
      project: { id: p.id, name: p.name, network: p.network, governor: p.governor },
      application: { id: a.id, task: task && publicTask(task, 0), handle: a.handle, wallet: a.wallet, status: a.status, applied_at: a.created_at, reasoning },
      deal: deal && {
        id: deal.id, status: deal.status, amount_usd: toUsd(deal.amount), deadline: deal.deadline, lapses_at: lapseOf(deal),
        offer_expires_at: deal.status === "offered" ? new Date(deal.created_at.getTime() + OFFER_DAYS * 86_400_000) : null,
        claim_code: claimCode(deal.id), terms: deal.terms, terms_hash: deal.terms_hash,
        milestones: deal.milestones.map((m, i) => ({ index: i, title: m.title, amount_usd: toUsd(BigInt(m.amount)), criteria: m.criteria })),
        tx: deal.chain_tx, tx_url: lane && deal.chain_tx ? explorerTx(lane.network, deal.chain_tx) : null,
      },
      claims: claims.map((c) => ({
        id: c.id, milestone: c.milestone, url: c.proof_url, status: c.status, amount_usd: c.amount === null ? null : toUsd(c.amount),
        reasoning: (c.verdict as { reasoning?: string; issues?: string[] } | null)?.reasoning ?? (c.verdict as { issues?: string[] } | null)?.issues?.join("; ") ?? null,
        tx: c.release_tx, tx_url: lane && c.release_tx ? explorerTx(lane.network, c.release_tx) : null,
      })),
      route: route && { domain: route.domain, chain: chainName(route.domain), recipient: ethers.dataSlice(route.recipient, 12) },
    });
  }));

  r.get("/me/:token/route", h(async (ctx, req, res) => {
    const { a, p } = await mine(ctx, req.params.token);
    const lane = laneOf(ctx, p);
    const domain = Number(req.query.domain);
    const recipient = String(req.query.recipient ?? "");
    if (!Object.values(CCTP_DOMAINS).some((c) => c.domain === domain) || domain === 26) throw bad("INVALID_ROUTE", "domain must be a CCTP chain other than Arc");
    if (!ethers.isAddress(recipient)) throw bad("INVALID_ROUTE", "recipient must be an address");
    if (!p.governor) throw new HttpError(409, "NO_GOVERNOR", "the project has no budget on-chain yet");
    const nonce = await new ethers.Contract(p.governor, GOVERNOR_OWNER_ABI, lane.provider).routeNonces(a.wallet);
    // The contract checks the deadline against its own clock, so it is set from the chain's.
    const chainNow = (await lane.provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000);
    res.json({
      domain: { name: "QuaestorPayouts", version: "1", chainId: lane.network.chainId, verifyingContract: p.governor },
      types: { Route: [{ name: "payee", type: "address" }, { name: "domain", type: "uint32" }, { name: "recipient", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Route",
      message: { payee: ethers.getAddress(a.wallet), domain, recipient: ethers.zeroPadValue(recipient, 32), nonce: nonce.toString(), deadline: chainNow + 3600 },
      chain: chainName(domain),
    });
  }));

  r.post("/me/:token/accept", h(async (ctx, req, res) => {
    const route = req.body?.route;
    let parsed: { domain: number; recipient: string; deadline: number; signature: string } | undefined;
    if (route) {
      if (typeof route.signature !== "string" || !Number.isInteger(route.domain) || !Number.isInteger(route.deadline) || typeof route.recipient !== "string") {
        throw bad("INVALID_ROUTE", "route needs domain, recipient, deadline and signature");
      }
      const recipient = ethers.isAddress(route.recipient) ? ethers.zeroPadValue(route.recipient, 32) : route.recipient;
      if (!ethers.isHexString(recipient, 32)) throw bad("INVALID_ROUTE", "recipient must be an address or 32 bytes");
      parsed = { domain: route.domain, recipient, deadline: route.deadline, signature: route.signature };
    }
    notice(res, await ctx.operator.accept(req.params.token, parsed));
  }));

  r.post("/me/:token/decline", h(async (ctx, req, res) => notice(res, await ctx.operator.decline(req.params.token))));

  r.post("/me/:token/claim", h(async (ctx, req, res) => {
    const milestone = Number(req.body?.milestone ?? 0);
    const url = req.body?.url;
    if (!Number.isInteger(milestone) || typeof url !== "string") throw bad("INVALID_CLAIM", "milestone and url are required");
    const out = await ctx.operator.claim(req.params.token, milestone, url.trim());
    if ("error" in out) throw bad("INVALID_CLAIM", out.error);
    res.status(201).json({ id: out.id, note: "The operator judges new deliveries within a few minutes." });
  }));

  // ---------------------------------------------------------------- the owner

  const owned = async (ctx: OperatorContext, req: Request) => {
    const p = await projectOr404(ctx, req.params.id);
    if (!p.governor) throw new HttpError(409, "NO_GOVERNOR", "the project has no budget on-chain yet");
    const owner = await ownerOf(ctx, req, p.id, p.governor, laneOf(ctx, p));
    return { p, owner };
  };

  r.post("/projects", h(async (ctx, req, res) => {
    const b = req.body ?? {};
    const id = String(b.id ?? "");
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(id)) throw bad("INVALID_PROJECT", "id: 3-40 lower-case letters, digits and dashes");
    if (typeof b.name !== "string" || !b.name.trim() || typeof b.brief !== "string" || b.brief.trim().length < 40) {
      throw bad("INVALID_PROJECT", "a name, and a brief of at least a few sentences: what the project is and who it wants to reach");
    }
    const lane = ctx.lanes.get(String(b.network));
    if (!lane) throw bad("INVALID_PROJECT", `network must be one of: ${[...ctx.lanes.keys()].join(", ")}`);
    if (typeof b.governor !== "string" || !ethers.isAddress(b.governor)) throw bad("INVALID_PROJECT", "governor must be an address");
    const governor = ethers.getAddress(b.governor);
    const existing = await ctx.store.project(id);
    if (existing && existing.governor?.toLowerCase() !== governor.toLowerCase()) throw new HttpError(409, "PROJECT_EXISTS", "that id belongs to another budget");
    const g = new ethers.Contract(governor, GOVERNOR_OWNER_ABI, lane.provider);
    const operator = await g.operator().catch(() => null);
    if (!operator || String(operator).toLowerCase() !== lane.sender.address.toLowerCase()) {
      throw bad("WRONG_OPERATOR", `the governor's operator must be this hub's, ${lane.sender.address}`);
    }
    const owner = await ownerOf(ctx, req, id, governor, lane);
    await ctx.store.saveProject({ id, name: b.name.trim().slice(0, 80), owner_address: owner, network: lane.network.key, governor, brief: b.brief.trim().slice(0, 4000), links: Array.isArray(b.links) ? b.links.filter((l: unknown) => typeof l === "string").slice(0, 10) : [] });
    for (const t of Array.isArray(b.tasks) ? b.tasks.slice(0, 20) : []) await ctx.store.saveTask(taskFrom(id, t));
    res.status(existing ? 200 : 201).json({ id, page: `/v1/operator/projects/${id}` });
  }));

  r.get("/projects/:id/owner", h(async (ctx, req, res) => {
    const { p } = await owned(ctx, req);
    const [headsUps, applicants, deals, claims, decisions, payees, limits] = await Promise.all([
      ctx.store.headsUps(p.id), ctx.store.applicants(p.id), ctx.store.deals(p.id), ctx.store.projectClaims(p.id),
      ctx.store.decisions(p.id, 100), ctx.store.reputations(p.id), governorOf(ctx, p).limits(),
    ]);
    const handles = new Map(applicants.map((a) => [a.wallet, a.handle]));
    res.json({
      project: p,
      deciding: ctx.deciding,
      model: ctx.model ?? null,
      budget: limitsUsd(limits),
      heads_ups: headsUps,
      applicants: applicants.map((a) => ({ id: a.id, task: a.task_id, handle: a.handle, wallet: a.wallet, email: a.email, pitch: a.pitch, samples: a.samples, asked_rate_usd: a.asked_rate === null ? null : toUsd(a.asked_rate), status: a.status, score: a.score, at: a.created_at })),
      deals: deals.map((d) => ({ id: d.id, handle: handles.get(d.payee) ?? null, payee: d.payee, amount_usd: toUsd(d.amount), status: d.status, deadline: d.deadline, milestones: d.milestones.length, tx: d.chain_tx, at: d.created_at })),
      claims: claims.map((c) => ({ id: c.id, deal: c.deal_id, handle: c.handle, milestone: c.milestone, url: c.proof_url, status: c.status, amount_usd: c.amount === null ? null : toUsd(c.amount), verdict: c.verdict, tx: c.release_tx, at: c.created_at })),
      decisions: decisions.map((d) => ({ hash: d.hash, kind: d.kind, subject: d.subject, at: d.created_at, record: JSON.parse(d.record) })),
      payees: payees.map((x) => ({ payee: x.payee, handle: handles.get(x.payee) ?? null, delivered: x.delivered, late: x.late, rejected: x.rejected, quality: x.quality, paid_usd: toUsd(x.paid) })),
    });
  }));

  r.post("/projects/:id/tasks", h(async (ctx, req, res) => {
    const { p } = await owned(ctx, req);
    const t = taskFrom(p.id, req.body ?? {});
    await ctx.store.saveTask(t);
    res.json(publicTask(t, (await ctx.store.dealsForTask(t.id)).length));
  }));

  r.post("/projects/:id/applicants/:aid", h(async (ctx, req, res) => {
    const { p, owner } = await owned(ctx, req);
    const action = req.body?.action;
    if (action !== "rescreen" && action !== "reject") throw bad("INVALID_ACTION", "action is rescreen or reject");
    notice(res, await ctx.operator.ownerApplicant(p, owner, req.params.aid, action));
  }));

  r.post("/projects/:id/claims/:cid", h(async (ctx, req, res) => {
    const { p, owner } = await owned(ctx, req);
    const fraction = Number(req.body?.payFraction);
    if (!(fraction >= 0 && fraction <= 1)) throw bad("INVALID_ACTION", "payFraction is between 0 and 1");
    notice(res, await ctx.operator.ownerJudge(p, owner, req.params.cid, fraction));
  }));

  r.post("/projects/:id/headsups/:hid", h(async (ctx, req, res) => {
    await owned(ctx, req);
    const status = req.body?.status;
    if (status !== "done" && status !== "dismissed") throw bad("INVALID_ACTION", "status is done or dismissed");
    await ctx.store.closeHeadsUp(req.params.hid, status);
    res.json({ id: req.params.hid, status });
  }));

  // The owner's side of matching: proven creators who fit each open task, and an invitation to apply.
  r.get("/projects/:id/matches", h(async (ctx, req, res) => {
    const { p } = await owned(ctx, req);
    const sent = await book(ctx).projectInvites(p.id);
    const tasks = (await ctx.store.tasks(p.id)).filter((t) => t.open);
    res.json({
      tasks: await Promise.all(tasks.map(async (t) => ({
        task_id: t.id, title: t.title, kind: t.kind,
        creators: (await book(ctx).candidates(t, p.network, 10)).map((c) => ({
          ...profileView(c), handles: c.proven.map((x) => handleView(x, false)), paid_deliveries: c.record.deliveries, paid_usd: toUsd(c.record.paid),
          invite: sent.find((s) => s.task_id === t.id && s.creator_id === c.id)?.status ?? null,
        })),
      }))),
    });
  }));

  r.post("/projects/:id/invite", h(async (ctx, req, res) => {
    const { p } = await owned(ctx, req);
    const b = req.body ?? {};
    const task = typeof b.task_id === "string" ? await ctx.store.task(b.task_id) : null;
    if (!task || task.project_id !== p.id || !task.open) throw bad("INVALID_INVITE", "task_id must be one of this project's open tasks");
    const c = typeof b.creator_id === "string" ? await book(ctx).byId(b.creator_id) : null;
    const fits = c ? (await book(ctx).candidates(task, p.network, 500)).some((x) => x.id === c.id) : false;
    if (!c || !fits) throw bad("INVALID_INVITE", "creator_id must be a proven creator who fits this task");
    const made = await book(ctx).invite({ project_id: p.id, task_id: task.id, creator_id: c.id, note: typeof b.note === "string" ? b.note : undefined });
    if (!made) throw new HttpError(409, "ALREADY_INVITED", "this creator is already invited to this task");
    res.status(201).json({ invited: c.id, task: task.id });
  }));

  r.post("/projects/:id/run", h(async (ctx, req, res) => {
    const { p } = await owned(ctx, req);
    res.json({ notices: await ctx.operator.run(p) });
  }));

  app.use("/v1/operator", rateLimit({ name: "operator", windowMs: 60_000, limit: 120 }));
  app.post("/v1/operator/projects/:id/apply", rateLimit({ name: "application", windowMs: 10 * 60_000, limit: 5 }));
  app.post("/v1/operator/creators", rateLimit({ name: "creator signup", windowMs: 10 * 60_000, limit: 5 }));
  app.post("/v1/operator/creators/me/:token/verify", rateLimit({ name: "handle proof", windowMs: 10 * 60_000, limit: 10 }));
  app.post("/v1/operator/creators/me/:token/apply", rateLimit({ name: "application", windowMs: 10 * 60_000, limit: 5 }));
  app.post("/v1/operator/chat", rateLimit({ name: "chat", windowMs: 10 * 60_000, limit: 40 }));
  app.post("/v1/operator/me/:token/claim", rateLimit({ name: "claim", windowMs: 10 * 60_000, limit: 10 }));
  app.post("/v1/operator/projects/:id/run", rateLimit({ name: "operator run", windowMs: 60_000, limit: 4 }));
  app.use("/v1/operator", r);

  // The loop: one pass at a time, every tick, while a model is configured.
  const tickMs = opts.tickMs ?? 0;
  if (tickMs > 0) {
    let running = false;
    void ready.then((ctx) => {
      if (!ctx.deciding) {
        console.warn("[operator] no model configured: applications queue until ANTHROPIC_API_KEY or MOONSHOT_API_KEY is set");
        return;
      }
      setInterval(() => {
        if (running) return;
        running = true;
        // Campaigns opened from the chat open their tasks once funded, before the pass that screens applicants.
        (ctx.chat ? ctx.chat.watchFunding().then((ids) => ids.forEach((id) => console.log(`[operator] campaign ${id} funded; its tasks are open`))) : Promise.resolve())
          .catch((err) => console.error(`[operator] funding check failed: ${safeMessage(err, 200)}`))
          .then(() => ctx.operator.tick())
          .then((notices) => notices.filter((n) => n.kind !== "error").forEach((n) => console.log(`[operator] ${n.kind} ${n.subject.slice(0, 18)}: ${n.detail.slice(0, 140)}`)))
          .catch((err) => console.error(`[operator] tick failed: ${safeMessage(err, 200)}`))
          .finally(() => { running = false; });
      }, tickMs).unref?.();
      console.log(`[operator] running every ${Math.round(tickMs / 1000)} s on ${[...ctx.lanes.keys()].join(", ")}`);
    }).catch(() => undefined);
  }
}

function taskFrom(projectId: string, t: Record<string, unknown>): Task {
  const kind = String(t.kind ?? "");
  if (!(TASK_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "INVALID_TASK", `kind is one of ${TASK_KINDS.join(", ")}`);
  const min = Number(t.rate_min_usd);
  const max = Number(t.rate_max_usd);
  if (!(min > 0 && max >= min && max <= 100_000)) throw new HttpError(400, "INVALID_TASK", "rate_min_usd and rate_max_usd: 0 < min <= max");
  const title = String(t.title ?? "").trim();
  const doneWhen = String(t.done_when ?? "").trim();
  if (!title || doneWhen.length < 10) throw new HttpError(400, "INVALID_TASK", "a title, and done_when: what the delivered link must show");
  const slug = String(t.id ?? title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const id = slug.startsWith(`${projectId}-`) ? slug : `${projectId}-${slug}`;
  const slots = Math.min(100, Math.max(1, Math.floor(Number(t.slots ?? 10))));
  return { id, project_id: projectId, kind, title: title.slice(0, 120), done_when: doneWhen.slice(0, 600), rate_min: fromUsd(min), rate_max: fromUsd(max), slots, open: t.open !== false };
}
