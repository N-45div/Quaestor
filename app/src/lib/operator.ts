import { parseAbi, type Address } from "viem";
import { stocksBase } from "./stocks";
import type { ChainRow } from "./evm/stocks";

/**
 * Quaestor Operator as the hub serves it (/v1/operator): a project's page, an applicant's private
 * link, and the owner's dashboard. The owner proves ownership by signing one message with the
 * governor's owner wallet; the signature lasts a day and stays in this tab.
 */

export interface OpNetworkRow {
  key: string;
  name: string;
  chain_id: number;
  rpc_url: string;
  operator: Address;
  factory: Address;
  /** The budget token: USDC on Arc, MUSD on Mezo (the field name is historical). */
  usdc: Address;
  token_symbol?: string;
  token_decimals?: number;
  gas_symbol?: string;
  /** Gas handed to the operator's key with a new budget, in the chain's native units. */
  gas_grant?: string;
  token_messenger: Address | null;
  explorer: string;
  testnet: boolean;
}

/** A network's budget token and gas, with Arc's as the default for hubs that predate the fields. */
export const tokenOf = (n: OpNetworkRow) => ({
  symbol: n.token_symbol ?? "USDC",
  decimals: n.token_decimals ?? 6,
  gasSymbol: n.gas_symbol ?? "USDC",
  gasGrant: n.gas_grant ?? "0.5",
});

export const chainRow = (n: OpNetworkRow): ChainRow => ({ chainId: n.chain_id, name: n.name, rpcUrl: n.rpc_url, explorer: n.explorer, testnet: n.testnet, gasSymbol: tokenOf(n).gasSymbol });

export interface OpIndex {
  deciding: boolean;
  model?: string | null;
  networks: OpNetworkRow[];
  projects: { id: string; name: string; network: string; governor: Address | null }[];
}

export interface OpTask {
  id: string;
  kind: string;
  title: string;
  done_when: string;
  rate_min_usd: number;
  rate_max_usd: number;
  slots: number;
  slots_left: number;
  open: boolean;
}

export interface OpBudget {
  free_usd: number;
  escrowed_usd: number;
  paid_this_period_usd: number;
  period_cap_usd: number;
  per_deal_cap_usd: number;
  new_payee_cap_usd: number;
  new_payees_per_period: number;
  period_days: number;
  suspended: boolean;
  cross_chain: boolean;
  max_forward_fee_bps: number;
}

export interface OpPayment { handle: string; proof_url: string; amount_usd: number; tx: string; tx_url: string | null; decision: string | null; at: string }

export interface OpProjectPage {
  project: { id: string; name: string; brief: string; links: string[]; network: string; governor: Address | null; governor_url: string | null };
  tasks: OpTask[];
  budget: OpBudget | null;
  totals: { applications: number; deals: number; paid_deliveries: number; paid_usd: number };
  payments: OpPayment[];
}

export interface OpClaim { id: string; milestone: number; url: string; status: "new" | "paid" | "rejected" | "needs_owner"; amount_usd: number | null; reasoning: string | null; tx: string | null; tx_url: string | null }

export interface OpMe {
  project: { id: string; name: string; network: string; governor: Address | null };
  application: { id: string; task: OpTask | null; handle: string; wallet: Address; status: string; applied_at: string; reasoning: string | null };
  deal: null | {
    id: string;
    status: "offered" | "pending_owner" | "open" | "closed" | "cancelled" | "expired" | "declined";
    amount_usd: number;
    deadline: string;
    lapses_at: string;
    offer_expires_at: string | null;
    claim_code: string;
    terms: string;
    terms_hash: string;
    milestones: { index: number; title: string; amount_usd: number; criteria: string }[];
    tx: string | null;
    tx_url: string | null;
  };
  claims: OpClaim[];
  route: { domain: number; chain: string; recipient: Address } | null;
}

export interface OpHeadsUp { id: string; kind: string; subject: string; text: string; created_at: string }

export interface OpOwnerView {
  project: { id: string; name: string; brief: string; links: string[]; network: string; governor: Address; owner_address: string };
  deciding: boolean;
  model?: string | null;
  budget: OpBudget;
  heads_ups: OpHeadsUp[];
  applicants: { id: string; task: string; handle: string; wallet: Address; email: string | null; pitch: string; samples: string[]; asked_rate_usd: number | null; status: string; score: number | null; at: string }[];
  deals: { id: string; handle: string | null; payee: Address; amount_usd: number; status: string; deadline: string; milestones: number; tx: string | null; at: string }[];
  claims: { id: string; deal: string; handle: string; milestone: number; url: string; status: string; amount_usd: number | null; verdict: Record<string, unknown> | null; tx: string | null; at: string }[];
  decisions: { hash: string; kind: string; subject: string; at: string; record: Record<string, unknown> }[];
  payees: { payee: Address; handle: string | null; delivered: number; late: number; rejected: number; quality: number | null; paid_usd: number }[];
}

export interface OpNotice { kind: string; subject: string; detail: string; tx?: string }

export interface OpDecision { hash: string; kind: string; subject: string; at: string; record: string; parsed: Record<string, unknown> }

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${stocksBase()}/v1/operator${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(75_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: { message?: string } }).error?.message ?? `The hub answered ${res.status}.`);
  return json as T;
}

export const fetchIndex = () => call<OpIndex>("GET", "");
export const fetchProject = (id: string) => call<OpProjectPage>("GET", `/projects/${encodeURIComponent(id)}`);
export const fetchMe = (token: string) => call<OpMe>("GET", `/me/${encodeURIComponent(token)}`);
export const fetchDecision = (hash: string) => call<OpDecision>("GET", `/decisions/${encodeURIComponent(hash)}`);

export const apply = (projectId: string, body: { taskId: string; handle: string; wallet: string; email?: string; pitch: string; samples: string[]; askedRateUsd?: number }) =>
  call<{ id: string; token: string }>("POST", `/projects/${encodeURIComponent(projectId)}/apply`, body);

export interface RouteTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: { Route: { name: string; type: string }[] };
  primaryType: "Route";
  message: { payee: Address; domain: number; recipient: `0x${string}`; nonce: string; deadline: number };
  chain: string;
}

export const routeTypedData = (token: string, domain: number, recipient: string) =>
  call<RouteTypedData>("GET", `/me/${encodeURIComponent(token)}/route?domain=${domain}&recipient=${recipient}`);
export const accept = (token: string, route?: { domain: number; recipient: string; deadline: number; signature: string }) =>
  call<OpNotice>("POST", `/me/${encodeURIComponent(token)}/accept`, route ? { route } : {});
export const decline = (token: string) => call<OpNotice>("POST", `/me/${encodeURIComponent(token)}/decline`, {});
export const claim = (token: string, milestone: number, url: string) => call<{ id: string }>("POST", `/me/${encodeURIComponent(token)}/claim`, { milestone, url });

// ------------------------------------------------------------------ the chat

export type ChatRole = "business" | "creator";

export interface ChatDraftTask { kind: string; title: string; done_when: string; rate_min_usd: number; rate_max_usd: number; slots: number }
export interface ChatDraft { name: string; brief: string; network: string; token: string; tasks: ChatDraftTask[] }

/** What the hub draws under a reply; each type has its own fields (see operator/chat.ts). */
export type ChatCard =
  | { type: "project_draft"; draft: ChatDraft; total_min_usd: number; total_max_usd: number }
  | { type: "creator_matches"; task_index: number; task: string; matches: { creator_id: string; name: string; niches: string[]; samples: string[]; handles: { platform: string; handle: string }[]; paid_deliveries: number; fit: number; reason: string }[] }
  | { type: "fund"; quote: { musd: number; btc_usd: number; borrow: { debt_musd: number; fee_musd: number; gas_deposit_musd: number; collateral_btc: number; liquidation_ratio: number; target_ratio: number; note: string | null }; swap: { btc_in: number; musd_out: number } | null } }
  | { type: "profile"; creator_token: string; profile: { id: string; name: string; wallet: string; networks: string[]; kinds: string[]; niches: string[]; rate_min_usd: number | null; rate_max_usd: number | null }; handles: { platform: string; handle: string; proven: boolean; code?: string }[] }
  | { type: "proof"; platform: string; proven: boolean; handle?: string; error?: string; proof_url?: string }
  | { type: "task_matches"; matches: { task_id: string; project_id: string; project?: string; kind: string; title: string; done_when: string; rate_usd: [number, number]; token: string; fit: number; reason: string }[] }
  | { type: "application"; project: string; task: string; handle: string; application_token: string }
  | { type: "status"; applications: { project: string; task: string; status: string; application_token: string }[]; invites?: { project: string; task: string; status: string; note: string | null }[]; paid_deliveries: number; paid_usd: number };

export interface ChatReply { token: string; role: ChatRole; reply: string; cards: ChatCard[]; creator_token?: string }
export interface ChatTranscript { role: ChatRole; log: { role: "user" | "assistant"; text: string; cards: ChatCard[]; at: string }[]; creator_token?: string }

export const sendChat = (body: { message: string; role: ChatRole; session?: string; creator_token?: string }) => call<ChatReply>("POST", "/chat", body);
export const fetchChat = (token: string) => call<ChatTranscript>("GET", `/chat/${encodeURIComponent(token)}`);

/** A draft handed from the chat to the budget form, which opens it with the owner's wallet. */
const DRAFT_KEY = "quaestor-operator-draft";
export function handDraft(d: ChatDraft): void {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* a private window: the form starts empty */ }
}
export function takeDraft(): ChatDraft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as ChatDraft | null;
    sessionStorage.removeItem(DRAFT_KEY);
    return d;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the owner

export function ownerMessage(projectId: string, expires: number): string {
  return `Quaestor Operator owner access\nproject: ${projectId}\nexpires: ${new Date(expires * 1000).toISOString()}`;
}

export interface OwnerSession { address: Address; expires: number; signature: string }

const sessionKey = (projectId: string) => `quaestor-operator-owner:${projectId}`;

export function savedSession(projectId: string): OwnerSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(sessionKey(projectId)) ?? "null") as OwnerSession | null;
    return s && s.expires > Date.now() / 1000 + 60 ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(projectId: string, s: OwnerSession | null): void {
  try {
    if (s) sessionStorage.setItem(sessionKey(projectId), JSON.stringify(s));
    else sessionStorage.removeItem(sessionKey(projectId));
  } catch {
    // a private window: the owner signs again next time
  }
}

const ownerHeaders = (s: OwnerSession) => ({ "x-owner-address": s.address, "x-owner-expires": String(s.expires), "x-owner-signature": s.signature });

export const registerProject = (s: OwnerSession, body: Record<string, unknown>) => call<{ id: string }>("POST", "/projects", body, ownerHeaders(s));
export const fetchOwner = (s: OwnerSession, id: string) => call<OpOwnerView>("GET", `/projects/${encodeURIComponent(id)}/owner`, undefined, ownerHeaders(s));
export const runNow = (s: OwnerSession, id: string) => call<{ notices: OpNotice[] }>("POST", `/projects/${encodeURIComponent(id)}/run`, {}, ownerHeaders(s));
export const answerApplicant = (s: OwnerSession, id: string, applicantId: string, action: "rescreen" | "reject") =>
  call<OpNotice>("POST", `/projects/${encodeURIComponent(id)}/applicants/${encodeURIComponent(applicantId)}`, { action }, ownerHeaders(s));
export const answerClaim = (s: OwnerSession, id: string, claimId: string, payFraction: number) =>
  call<OpNotice>("POST", `/projects/${encodeURIComponent(id)}/claims/${encodeURIComponent(claimId)}`, { payFraction }, ownerHeaders(s));
export const closeHeadsUp = (s: OwnerSession, id: string, headsUpId: string, status: "done" | "dismissed") =>
  call<{ id: string }>("POST", `/projects/${encodeURIComponent(id)}/headsups/${encodeURIComponent(headsUpId)}`, { status }, ownerHeaders(s));
export const saveTask = (s: OwnerSession, id: string, task: Record<string, unknown>) => call<OpTask>("POST", `/projects/${encodeURIComponent(id)}/tasks`, task, ownerHeaders(s));

export interface OpMatches {
  tasks: { task_id: string; title: string; kind: string; creators: { id: string; name: string; bio: string; niches: string[]; samples: string[]; rate_min_usd: number | null; rate_max_usd: number | null; handles: { platform: string; handle: string }[]; paid_deliveries: number; paid_usd: number; invite: string | null }[] }[];
}
export const fetchMatches = (s: OwnerSession, id: string) => call<OpMatches>("GET", `/projects/${encodeURIComponent(id)}/matches`, undefined, ownerHeaders(s));
export const inviteCreator = (s: OwnerSession, id: string, taskId: string, creatorId: string, note?: string) =>
  call<{ invited: string }>("POST", `/projects/${encodeURIComponent(id)}/invite`, { task_id: taskId, creator_id: creatorId, note }, ownerHeaders(s));

// ------------------------------------------------------------------ the contracts

export const PAYOUTS_FACTORY_ABI = parseAbi([
  "struct Setup { address operator; address token; uint64 epochLength; uint128 perDealCap; uint128 epochCap; uint128 newPayeeCap; uint32 newPayeesPerEpoch; address[] payees; uint128[] payeeCaps; address tokenMessenger; uint16 maxForwardFeeBps; uint256 deposit; }",
  "function createGovernor(Setup s) payable returns (address governor)",
  "event GovernorCreated(address indexed governor, address indexed owner, address indexed operator, address token, uint256 deposit)",
]);

export const PAYOUT_GOVERNOR_ABI = parseAbi([
  "function approveDeal(bytes32 dealId)",
  "function setSuspended(bool suspended)",
  "function withdraw(address to, uint256 amount)",
]);

/** Chains a payee can be paid on from Arc, through CCTP and Circle's Forwarding Service. */
export const PAYOUT_CHAINS = [
  { domain: 6, name: "Base" },
  { domain: 3, name: "Arbitrum" },
  { domain: 0, name: "Ethereum" },
  { domain: 2, name: "OP" },
  { domain: 7, name: "Polygon" },
];

export const TASK_KINDS: { kind: string; label: string }[] = [
  { kind: "x-post", label: "Post on X" },
  { kind: "thread", label: "Thread on X" },
  { kind: "pull-request", label: "Merged pull request" },
  { kind: "article", label: "Article" },
  { kind: "video", label: "YouTube video" },
];

export const kindLabel = (k: string) => TASK_KINDS.find((x) => x.kind === k)?.label ?? k;
export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
export const opHref = (path: string) => `#/app/operator${path}`;
