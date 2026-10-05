/**
 * Quaestor Operator: the agent that runs a project's paid outreach.
 *
 *   application -> Claude screens it against the brief, the band, the budget and the person's
 *                  record here -> an offer, a refusal, a waitlist place or a question for the owner
 *   acceptance  -> the payee is added and the deal escrowed on-chain; a deal over the operator's
 *                  limits waits for the owner, who approves it from their own wallet
 *   claim       -> the facts are checked, Claude judges the work, and the governor pays it here
 *                  or on the payee's own chain, along the route the payee signed
 *   every week  -> Claude briefs the owner on what the money bought, and what to change
 *
 * Every decision is recorded with its reasoning, and its hash rides on-chain with the action it
 * caused, so anyone can re-hash the record behind any payment. The Operator never writes to
 * anyone first: people come to the project's page, and every message goes to someone who applied.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { commitDecision } from "../sdk/evm-stocks";
import type { Applicant, Claim, Deal, Milestone, Project, Store, Task } from "./db";
import { DecisionUnavailable, clampScreen, type Brief, type Decider, type ProjectContext, type TaskContext } from "./decide";
import { fetchEvidence, hardChecks, proofHashOf, type Evidence } from "./verify";
import { GovernorClient, Refused, forwardFee } from "./chain";

export const toUsd = (units: bigint) => Number(units) / 1e6;
export const fromUsd = (usd: number) => BigInt(Math.round(usd * 1e6));

const DAY = 86_400_000;
export const OFFER_DAYS = 7; // an offer not accepted within a week lapses
export const GRACE_DAYS = 3; // time after a deadline to deliver late and be judged, before escrow lapses
export const BRIEF_DAYS = 7;

export interface AgentDeps {
  store: Store;
  decider: Decider;
  governorFor(project: Project): GovernorClient | null;
  evidence?: (url: string) => Promise<Evidence>;
  iris?: (project: Project) => string | undefined; // Circle's attestation API on the project's chain, for fee quotes
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Notice {
  kind: "offer" | "rejected" | "waitlisted" | "escalated" | "deal_open" | "deal_pending" | "paid" | "claim_rejected" | "claim_escalated" | "lapsed" | "brief" | "error";
  subject: string;
  detail: string;
  tx?: string;
}

/**
 * The short code a delivery must carry. Without it, anyone could apply under a known writer's
 * handle and claim that writer's next post; with it, only content made for this deal qualifies.
 */
export function claimCode(dealId: string): string {
  return `qop-${dealId.slice(2, 8)}`;
}

function projectContext(p: Project): ProjectContext {
  return { name: p.name, brief: p.brief, links: p.links };
}

function taskContext(t: Task, slotsLeft: number): TaskContext {
  return { kind: t.kind, title: t.title, done_when: t.done_when, rate_min_usd: toUsd(t.rate_min), rate_max_usd: toUsd(t.rate_max), slots_left: slotsLeft };
}

/** The canonical terms a deal escrows against: their hash is the deal's termsHash on-chain. */
export function termsOf(p: Project, t: Task, a: Applicant, dealId: string, amount: bigint, milestones: Milestone[], deadline: Date): string {
  return JSON.stringify({
    project: p.id,
    deal: dealId,
    task: { id: t.id, title: t.title, done_when: t.done_when },
    payee: { handle: a.handle, wallet: a.wallet },
    amount: amount.toString(),
    milestones,
    deadline: deadline.toISOString(),
    claim_code: claimCode(dealId),
  });
}

/** When the escrow lapses on-chain: the deadline plus a grace period to deliver late and be judged. */
export function lapseOf(deal: Pick<Deal, "deadline">): Date {
  return new Date(deal.deadline.getTime() + GRACE_DAYS * DAY);
}

export class Operator {
  private readonly evidence: (url: string) => Promise<Evidence>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: AgentDeps) {
    this.evidence = deps.evidence ?? ((url) => fetchEvidence(url));
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  private async decided(project: Project, kind: string, subject: string, body: Record<string, unknown>): Promise<string> {
    const { text, decisionHash } = commitDecision({ kind, project: project.id, subject, at: this.now().toISOString(), ...body });
    await this.deps.store.record({ hash: decisionHash, project_id: project.id, kind, subject, record: text });
    return decisionHash;
  }

  private async escalate(project: Project, kind: string, subject: string, text: string): Promise<void> {
    await this.deps.store.headsUp({ id: `${kind}:${subject}`, project_id: project.id, kind, subject, text });
  }

  // ---------------------------------------------------------------- intake

  /** A new application from the project's page; one per wallet per task. */
  async apply(projectId: string, input: { taskId: string; handle: string; wallet: string; email?: string; pitch: string; samples: string[]; askedRateUsd?: number }): Promise<{ id: string; token: string } | { error: string }> {
    const { store } = this.deps;
    const task = await store.task(input.taskId);
    if (!task || task.project_id !== projectId || !task.open) return { error: "that task is not open" };
    if (!ethers.isAddress(input.wallet)) return { error: "the wallet is not an address" };
    const handle = input.handle.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(handle)) return { error: "the handle is not valid" };
    const mine = (await store.applicants(projectId)).find((x) => x.task_id === task.id && x.wallet === input.wallet.toLowerCase());
    if (mine) return { error: "you have already applied for this task" };
    const samples = input.samples.map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, 5);
    const id = randomUUID();
    const token = randomBytes(18).toString("base64url");
    await store.addApplicant({
      id, project_id: projectId, task_id: task.id, handle, wallet: input.wallet, token,
      email: input.email?.trim() || null, pitch: input.pitch.slice(0, 2000), samples,
      asked_rate: input.askedRateUsd && input.askedRateUsd > 0 ? fromUsd(input.askedRateUsd) : null,
    });
    return { id, token };
  }

  // ---------------------------------------------------------------- screening

  /** Screen every new application in a project. */
  async screenNew(project: Project): Promise<Notice[]> {
    const out: Notice[] = [];
    for (const a of await this.deps.store.applicants(project.id, "new")) out.push(await this.screen(project, a));
    return out;
  }

  async screen(project: Project, a: Applicant): Promise<Notice> {
    const { store, decider } = this.deps;
    const task = await store.task(a.task_id);
    if (!task || !task.open) {
      await store.setApplicant(a.id, "rejected");
      return { kind: "rejected", subject: a.id, detail: "the task is closed" };
    }
    const taken = (await store.dealsForTask(task.id)).length;
    const gov = this.deps.governorFor(project);
    const limits = gov ? await gov.limits() : null;
    const record = await store.reputation(project.id, a.wallet);
    const samples = await Promise.all(a.samples.slice(0, 3).map((u) => this.evidence(u)));
    const offered = await store.deals(project.id, "offered");

    const taskCtx = taskContext(task, Math.max(0, task.slots - taken));
    let screen;
    try {
      screen = await decider.screen({
        project: projectContext(project),
        task: taskCtx,
        applicant: { handle: a.handle, pitch: a.pitch, samples: a.samples, asked_rate_usd: a.asked_rate === null ? null : toUsd(a.asked_rate) },
        samples: samples.map((s) => ({ url: s.canonical, author: s.author, text: s.text?.slice(0, 1500), ok: s.ok, error: s.error })),
        track_record: { delivered: record.delivered, late: record.late, rejected: record.rejected, paid_usd: toUsd(record.paid), quality: record.quality },
        budget: {
          // What open offers would take is not free, even before they are escrowed.
          free_usd: limits ? Math.max(0, toUsd(limits.freeBalance) - offered.reduce((s, d) => s + toUsd(d.amount), 0)) : 0,
          paid_this_period_usd: limits ? toUsd(limits.paidInEpoch) : 0,
          period_cap_usd: limits ? toUsd(limits.epochCap) : 0,
          open_offers: offered.length,
        },
      });
      screen = clampScreen(screen, taskCtx); // the owner's band holds whichever decider answered
    } catch (err) {
      if (!(err instanceof DecisionUnavailable)) throw err;
      await store.setApplicant(a.id, "escalated");
      await this.escalate(project, "screen", a.id, `Quick check: I couldn't decide on @${a.handle}'s application (${err.message}). Will you take a look?`);
      return { kind: "escalated", subject: a.id, detail: err.message };
    }

    const decisionHash = await this.decided(project, "screen", a.id, { applicant: a.handle, wallet: a.wallet, task: task.id, ...screen });
    if (screen.decision === "reject") {
      await store.setApplicant(a.id, "rejected", screen.fit_score);
      return { kind: "rejected", subject: a.id, detail: screen.reasoning };
    }
    if (screen.decision === "waitlist") {
      await store.setApplicant(a.id, "waitlisted", screen.fit_score);
      return { kind: "waitlisted", subject: a.id, detail: screen.reasoning };
    }
    if (screen.decision === "ask_owner") {
      await store.setApplicant(a.id, "escalated", screen.fit_score);
      await this.escalate(project, "screen", a.id, `Quick check on @${a.handle}: ${screen.owner_question || screen.reasoning}`);
      return { kind: "escalated", subject: a.id, detail: screen.owner_question };
    }

    // An offer: milestones in base units, the last one taking any rounding.
    const amount = fromUsd(screen.rate_usd);
    let assigned = 0n;
    const milestones: Milestone[] = screen.milestones.map((m, i) => {
      const part = i === screen.milestones.length - 1 ? amount - assigned : (amount * BigInt(Math.round(m.share * 10_000))) / 10_000n;
      assigned += part;
      return { title: m.title, amount: part.toString(), criteria: m.criteria };
    });
    const deadline = new Date(this.now().getTime() + screen.deadline_days * DAY);
    const id = ethers.keccak256(ethers.toUtf8Bytes(`${project.id}:${a.id}:${decisionHash}`));
    const terms = termsOf(project, task, a, id, amount, milestones, deadline);
    await store.saveDeal({
      id, project_id: project.id, applicant_id: a.id, payee: a.wallet, amount, milestones, terms,
      terms_hash: ethers.keccak256(ethers.toUtf8Bytes(terms)), deadline, status: "offered", access_token: a.token, chain_tx: null,
      created_at: this.now(),
    });
    await store.setApplicant(a.id, "offered", screen.fit_score);
    this.log(`[operator] offered @${a.handle} $${screen.rate_usd} for ${task.id}`);
    return { kind: "offer", subject: id, detail: `$${screen.rate_usd} in ${milestones.length} milestone(s), due ${deadline.toISOString().slice(0, 10)}` };
  }

  // ---------------------------------------------------------------- the payee's answer

  /** The payee accepted, from their private link: add them, escrow the deal, and set the route they signed. */
  async accept(token: string, route?: { domain: number; recipient: string; deadline: number; signature: string }): Promise<Notice> {
    const { store } = this.deps;
    const a = await store.applicantByToken(token);
    const deal = a && (await store.dealForApplicant(a.id));
    if (!a || !deal || deal.status !== "offered") return { kind: "error", subject: token.slice(0, 6), detail: "there is no open offer on this link" };
    const project = (await store.project(deal.project_id))!;
    if (this.now().getTime() > deal.created_at.getTime() + OFFER_DAYS * DAY) {
      await this.lapseOffer(deal);
      return { kind: "lapsed", subject: deal.id, detail: "this offer lapsed" };
    }
    const gov = this.deps.governorFor(project);
    if (!gov) return { kind: "error", subject: deal.id, detail: "the project has no budget on-chain yet" };
    const screenHash = (await store.lastDecision(project.id, "screen", a.id))?.hash ?? ethers.ZeroHash;
    try {
      const p = await gov.payee(deal.payee);
      if (!p.allowed) await gov.addPayee(deal.payee, screenHash);
      if (route) await gov.setRoute(deal.payee, route.domain, route.recipient, route.deadline, route.signature);
      const decisionHash = await this.decided(project, "open_deal", deal.id, { payee: deal.payee, amount: deal.amount.toString(), terms_hash: deal.terms_hash, screen: screenHash });
      const tx = await gov.openDeal(deal.id, deal.payee, deal.amount, Math.floor(lapseOf(deal).getTime() / 1000), deal.terms_hash, decisionHash);
      const pending = (await gov.deal(deal.id)).state === "pending";
      await store.setDeal(deal.id, pending ? "pending_owner" : "open", tx);
      await store.setApplicant(a.id, "accepted");
      if (pending) {
        await this.escalate(project, "approve_deal", deal.id, `Quick check: approve a $${toUsd(deal.amount)} deal with @${a.handle}? It's over what I can agree alone.`);
        return { kind: "deal_pending", subject: deal.id, detail: "waiting for the owner's approval", tx };
      }
      return { kind: "deal_open", subject: deal.id, detail: `$${toUsd(deal.amount)} escrowed`, tx };
    } catch (err) {
      if (err instanceof Refused) {
        await this.escalate(project, "refused", deal.id, `Quick check: the budget contract refused @${a.handle}'s deal (${err.code}). Raise a limit, or should I withdraw the offer?`);
        return { kind: "escalated", subject: deal.id, detail: err.code };
      }
      throw err;
    }
  }

  async decline(token: string): Promise<Notice> {
    const a = await this.deps.store.applicantByToken(token);
    const deal = a && (await this.deps.store.dealForApplicant(a.id));
    if (!a || !deal || deal.status !== "offered") return { kind: "error", subject: token.slice(0, 6), detail: "there is no open offer on this link" };
    await this.deps.store.setDeal(deal.id, "declined");
    await this.deps.store.setApplicant(a.id, "declined");
    return { kind: "lapsed", subject: deal.id, detail: "declined" };
  }

  // ---------------------------------------------------------------- claims

  /** A delivery, from the payee's private link. The store refuses a link claimed before. */
  async claim(token: string, milestone: number, url: string): Promise<{ id: string } | { error: string }> {
    const { store } = this.deps;
    const a = await store.applicantByToken(token);
    const deal = a && (await store.dealForApplicant(a.id));
    if (!deal || deal.status !== "open") return { error: "this deal is not open" };
    if (!deal.milestones[milestone]) return { error: "no such milestone" };
    const earlier = await store.claims(deal.id);
    if (earlier.some((c) => c.milestone === milestone && (c.status === "paid" || c.status === "new"))) return { error: "this milestone is already claimed" };
    let proofHash: string;
    try {
      proofHash = proofHashOf(url);
    } catch {
      return { error: "that is not a web link" };
    }
    const id = randomUUID();
    const added = await store.addClaim({ id, deal_id: deal.id, milestone, proof_url: url, proof_hash: proofHash });
    return added ? { id } : { error: "that link has already been claimed" };
  }

  /** Judge every new claim in a project, and pay the ones that earn it. */
  async judgeClaims(project: Project): Promise<Notice[]> {
    const out: Notice[] = [];
    for (const c of await this.deps.store.openClaims(project.id)) out.push(await this.judge(project, c.id));
    return out;
  }

  async judge(project: Project, claimId: string): Promise<Notice> {
    const { store, decider } = this.deps;
    const claim = (await store.openClaims(project.id)).find((c) => c.id === claimId);
    if (!claim) return { kind: "error", subject: claimId, detail: "no such open claim" };
    const deal = (await store.deal(claim.deal_id))!;
    const applicant = (await store.applicant(deal.applicant_id))!;
    const task = (await store.task(applicant.task_id))!;
    const milestone = deal.milestones[claim.milestone];
    const paidBefore = (await store.claims(deal.id)).some((c) => c.milestone === claim.milestone && c.status === "paid");
    if (!milestone || deal.status !== "open" || paidBefore) {
      const reason = paidBefore ? "this milestone was already paid" : "the deal is not open for this milestone";
      await store.settleClaim(claim.id, "rejected", { reason });
      return { kind: "claim_rejected", subject: claim.id, detail: reason };
    }
    const evidence = await this.evidence(claim.proof_url);
    const problems = hardChecks(evidence, { handle: applicant.handle, taskKind: task.kind, openedAt: deal.created_at, mustMention: [claimCode(deal.id)] });
    if (problems.length) {
      // The facts settle it, whatever any model would make of the content: no payment, and no
      // model call. The link is free to claim again once it is fixed (a PR merged, the code added).
      await this.decided(project, "verify", claim.id, { deal: deal.id, milestone: claim.milestone, proof: evidence.canonical, checked: problems, decision: "reject" });
      await store.settleClaim(claim.id, "rejected", { decision: "reject", issues: problems });
      if (evidence.ok) await store.bumpReputation(project.id, deal.payee, { rejected: 1 });
      return { kind: "claim_rejected", subject: claim.id, detail: problems.join("; ") };
    }

    let verdict;
    try {
      verdict = await decider.verify({
        project: projectContext(project),
        task: taskContext(task, 0),
        deal: { payee_handle: applicant.handle, terms: deal.terms, milestone: { title: milestone.title, amount_usd: toUsd(BigInt(milestone.amount)), criteria: milestone.criteria } },
        evidence: { url: evidence.canonical, kind: evidence.kind, author: evidence.author, title: evidence.title, text: evidence.text, published_at: evidence.publishedAt, merged: evidence.merged },
        hard_check_problems: problems,
      });
    } catch (err) {
      if (!(err instanceof DecisionUnavailable)) throw err;
      await store.settleClaim(claim.id, "needs_owner", { error: err.message });
      await this.escalate(project, "claim", claim.id, `Quick check: I couldn't judge @${applicant.handle}'s delivery ${claim.proof_url} (${err.message}). Will you?`);
      return { kind: "claim_escalated", subject: claim.id, detail: err.message };
    }
    const decisionHash = await this.decided(project, "verify", claim.id, { deal: deal.id, milestone: claim.milestone, proof: evidence.canonical, checked: problems, ...verdict });

    if (verdict.decision === "reject") {
      await store.settleClaim(claim.id, "rejected", verdict);
      await store.bumpReputation(project.id, deal.payee, { rejected: 1 });
      return { kind: "claim_rejected", subject: claim.id, detail: verdict.reasoning };
    }
    if (verdict.decision === "ask_owner") {
      await store.settleClaim(claim.id, "needs_owner", verdict);
      await this.escalate(project, "claim", claim.id, `Quick check on @${applicant.handle}'s delivery: ${verdict.owner_question || verdict.reasoning}`);
      return { kind: "claim_escalated", subject: claim.id, detail: verdict.owner_question };
    }

    const amount = (BigInt(milestone.amount) * BigInt(Math.round(verdict.pay_fraction * 10_000))) / 10_000n;
    return this.payOut(project, claim, deal, applicant.handle, amount, verdict, decisionHash);
  }

  /** Release a judged amount: on the payee's own chain when they signed a route there. */
  private async payOut(project: Project, claim: Claim, deal: Deal, handle: string, amount: bigint, verdict: Record<string, unknown> & { quality?: number }, decisionHash: string): Promise<Notice> {
    const { store } = this.deps;
    const gov = this.deps.governorFor(project);
    if (!gov) return { kind: "error", subject: claim.id, detail: "the project has no budget on-chain" };
    try {
      const route = await gov.route(deal.payee);
      const iris = this.deps.iris?.(project);
      const crossChain = !!route && !!iris && (await gov.limits()).crossChain;
      const proofHash = proofHashOf(claim.proof_url);
      const tx = crossChain
        ? await gov.releaseCrossChain(deal.id, amount, await forwardFee(iris!, route!.domain, amount), proofHash, decisionHash)
        : await gov.release(deal.id, amount, proofHash, decisionHash);
      await store.settleClaim(claim.id, "paid", verdict, amount, tx);
      if ((await gov.deal(deal.id)).state === "closed") await store.setDeal(deal.id, "closed");
      const late = this.now().getTime() > deal.deadline.getTime();
      await store.bumpReputation(project.id, deal.payee, { delivered: 1, late: late ? 1 : 0, paid: amount, quality: verdict.quality ?? 3 });
      await store.closeHeadsUp(`claim:${claim.id}`, "done");
      await store.closeHeadsUp(`refused:${claim.id}`, "done");
      this.log(`[operator] paid @${handle} $${toUsd(amount)}${crossChain ? " cross-chain" : ""}: ${tx}`);
      return { kind: "paid", subject: claim.id, detail: `$${toUsd(amount)} paid${crossChain ? " on the payee's chain" : ""}`, tx };
    } catch (err) {
      if (err instanceof Refused) {
        await store.settleClaim(claim.id, "needs_owner", { ...verdict, refused: err.code });
        await this.escalate(project, "refused", claim.id, `Quick check: @${handle}'s delivery was judged worth $${toUsd(amount)}, and the budget contract refused (${err.code}). Raise a limit, or pay it yourself?`);
        return { kind: "claim_escalated", subject: claim.id, detail: err.code };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- the owner's answers

  /** The owner settles an application the Operator asked about: screen it again, or turn it down. */
  async ownerApplicant(project: Project, owner: string, applicantId: string, action: "rescreen" | "reject"): Promise<Notice> {
    const { store } = this.deps;
    const a = await store.applicant(applicantId);
    if (!a || a.project_id !== project.id) return { kind: "error", subject: applicantId, detail: "no such applicant" };
    if (!["escalated", "waitlisted", "rejected"].includes(a.status)) return { kind: "error", subject: applicantId, detail: `the application is ${a.status}` };
    await this.decided(project, "owner_screen", a.id, { by: owner.toLowerCase(), action });
    await store.setApplicant(a.id, action === "rescreen" ? "new" : "rejected");
    await store.closeHeadsUp(`screen:${a.id}`, "done");
    return action === "rescreen" ? this.screen(project, (await store.applicant(a.id))!) : { kind: "rejected", subject: a.id, detail: "the owner turned it down" };
  }

  /** The owner judges a delivery the Operator held back: a fraction of the milestone, or nothing. */
  async ownerJudge(project: Project, owner: string, claimId: string, payFraction: number): Promise<Notice> {
    const { store } = this.deps;
    const claim = await store.claim(claimId);
    const deal = claim && (await store.deal(claim.deal_id));
    if (!claim || !deal || deal.project_id !== project.id) return { kind: "error", subject: claimId, detail: "no such claim" };
    if (claim.status !== "needs_owner") return { kind: "error", subject: claimId, detail: `the claim is ${claim.status}` };
    const milestone = deal.milestones[claim.milestone];
    const fraction = Math.min(1, Math.max(0, Number.isFinite(payFraction) ? payFraction : 0));
    const verdict = { decision: fraction > 0 ? "pay" : "reject", pay_fraction: fraction, by: owner.toLowerCase() };
    const decisionHash = await this.decided(project, "owner_verify", claim.id, { deal: deal.id, milestone: claim.milestone, proof: claim.proof_url, ...verdict });
    if (fraction === 0 || !milestone) {
      await store.settleClaim(claim.id, "rejected", verdict);
      await store.closeHeadsUp(`claim:${claim.id}`, "done");
      await store.closeHeadsUp(`refused:${claim.id}`, "done");
      return { kind: "claim_rejected", subject: claim.id, detail: "the owner turned it down" };
    }
    const handle = (await store.applicant(deal.applicant_id))?.handle ?? deal.payee;
    const amount = (BigInt(milestone.amount) * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    return this.payOut(project, claim, deal, handle, amount, verdict, decisionHash);
  }

  // ---------------------------------------------------------------- upkeep

  private async lapseOffer(deal: Deal): Promise<void> {
    await this.deps.store.setDeal(deal.id, "expired");
    await this.deps.store.setApplicant(deal.applicant_id, "declined");
  }

  /** A deal the owner approved on-chain is open from then on; one they cancelled is gone. */
  async syncPending(project: Project): Promise<void> {
    const gov = this.deps.governorFor(project);
    if (!gov) return;
    for (const d of await this.deps.store.deals(project.id, "pending_owner")) {
      const s = (await gov.deal(d.id)).state;
      if (s === "open") {
        await this.deps.store.setDeal(d.id, "open");
        await this.deps.store.closeHeadsUp(`approve_deal:${d.id}`, "done");
      } else if (s === "cancelled") await this.deps.store.setDeal(d.id, "cancelled");
    }
  }

  /** Offers nobody accepted lapse; escrow past its deadline and grace goes back to the budget. */
  async lapse(project: Project): Promise<Notice[]> {
    const { store } = this.deps;
    const out: Notice[] = [];
    const now = this.now().getTime();
    for (const d of await store.deals(project.id, "offered")) {
      if (now > d.created_at.getTime() + OFFER_DAYS * DAY) {
        await this.lapseOffer(d);
        out.push({ kind: "lapsed", subject: d.id, detail: "the offer was not accepted in time" });
      }
    }
    const gov = this.deps.governorFor(project);
    if (!gov) return out;
    for (const status of ["open", "pending_owner"] as const) {
      for (const d of await store.deals(project.id, status)) {
        if (now <= lapseOf(d).getTime()) continue;
        const onChain = (await gov.deal(d.id)).state;
        let tx: string | undefined;
        if (onChain === "open" || onChain === "pending") {
          try {
            tx = await gov.expire(d.id);
          } catch (err) {
            if (err instanceof Refused && err.code === "DealNotExpired") continue; // the chain's clock is behind ours
            throw err;
          }
        }
        await store.setDeal(d.id, onChain === "closed" ? "closed" : "expired");
        out.push({ kind: "lapsed", subject: d.id, detail: "the deadline passed; unspent escrow is free again", tx });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the owner's brief

  async briefDue(project: Project): Promise<boolean> {
    const last = await this.deps.store.lastDecision(project.id, "brief");
    if (last) return this.now().getTime() - new Date(last.created_at).getTime() >= BRIEF_DAYS * DAY;
    return (await this.deps.store.activity(project.id, new Date(0))).applications > 0;
  }

  /** What the money bought since the last brief, and what Claude recommends the owner change. */
  async brief(project: Project): Promise<Brief | null> {
    const { store, decider } = this.deps;
    const last = await store.lastDecision(project.id, "brief");
    const since = last ? new Date(last.created_at) : new Date(0); // the first brief covers everything so far
    const act = await store.activity(project.id, since);
    const handles = new Map((await store.applicants(project.id)).map((a) => [a.wallet, a.handle]));
    const recent = (await store.decisions(project.id, 40))
      .filter((d) => d.kind === "screen" || d.kind === "verify")
      .map((d) => ({ kind: d.kind, subject: d.subject, reasoning: String((JSON.parse(d.record) as { reasoning?: string }).reasoning ?? "") }));
    const gov = this.deps.governorFor(project);
    const limits = gov ? await gov.limits() : null;
    const period = last ? `${since.toISOString().slice(0, 10)} to ${this.now().toISOString().slice(0, 10)}` : `the start to ${this.now().toISOString().slice(0, 10)}`;
    let brief: Brief;
    try {
      brief = await decider.brief({
        project: projectContext(project),
        period,
        stats: {
          applications: act.applications, offers: act.offers, deals_opened: act.deals, deliveries: act.claims,
          deliveries_paid: act.paid_claims, deliveries_rejected: act.rejected_claims, paid_usd: toUsd(act.paid),
          budget_free_usd: limits ? toUsd(limits.freeBalance) : 0, budget_escrowed_usd: limits ? toUsd(limits.committed) : 0,
          open_questions: (await store.headsUps(project.id)).length,
        },
        recent_decisions: recent,
        payees: (await store.reputations(project.id)).map((r) => ({
          handle: handles.get(r.payee) ?? r.payee, delivered: r.delivered, late: r.late, rejected: r.rejected, paid_usd: toUsd(r.paid), quality: r.quality,
        })),
      });
    } catch (err) {
      if (err instanceof DecisionUnavailable) return null;
      throw err;
    }
    const hash = await this.decided(project, "brief", period, { ...brief });
    await store.headsUp({ id: `brief:${hash}`, project_id: project.id, kind: "brief", subject: period, text: `${brief.headline}\n\n${brief.summary}` });
    return brief;
  }

  // ---------------------------------------------------------------- the loop

  /** One pass over a project: screen, sync approvals, judge and pay, lapse, brief. */
  async run(p: Project): Promise<Notice[]> {
    const out: Notice[] = [];
    try {
      out.push(...(await this.screenNew(p)));
      await this.syncPending(p);
      out.push(...(await this.judgeClaims(p)));
      out.push(...(await this.lapse(p)));
      if (await this.briefDue(p)) {
        const b = await this.brief(p);
        if (b) out.push({ kind: "brief", subject: p.id, detail: b.headline });
      }
    } catch (err) {
      const message = (err as Error).message.slice(0, 200);
      this.log(`[operator] ${p.id}: ${message}`);
      out.push({ kind: "error", subject: p.id, detail: message });
    }
    return out;
  }

  /** One pass over every project. */
  async tick(): Promise<Notice[]> {
    const out: Notice[] = [];
    for (const p of await this.deps.store.projects()) out.push(...(await this.run(p)));
    return out;
  }
}
