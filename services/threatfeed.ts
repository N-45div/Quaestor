/**
 * The shared threat feed — the thing that makes Quaestor a hub rather than a
 * per-agent guardrail.
 *
 * A tenant's agent that gets attacked through a venue reports it here. Every
 * other tenant's permit price for that venue moves within seconds. Reports are
 * counted per distinct human (World ID nullifier / AgentBook humanId), never
 * per key, so one attacker with a thousand agents is still one reporter.
 *
 * This module is the interface plus an in-memory implementation. The durable
 * implementation writes each report to an append-only Hedera Consensus Service
 * topic and rebuilds this view from the mirror node, so a report cannot be
 * un-said and the "tenant B was immune 2.8 s after tenant A was attacked"
 * claim is backed by network-assigned consensus timestamps.
 */

export interface ThreatReport {
  /** Lower-cased venue identifier (contract address, account id, or URL host). */
  venue: string;
  /** Stable id of the verified human behind the reporting agent. "" = unverified. */
  humanId: string;
  /** Which tenant's agent observed it. */
  tenantId: string;
  /** Short machine-readable reason, e.g. "prompt-injection", "sandwich", "honeypot". */
  pattern: string;
  /** Wall-clock at the reporter; the durable feed adds a consensus timestamp. */
  observedAt: string;
  /** Set once the durable feed has committed it. */
  consensusTimestamp?: string;
  sequenceNumber?: number;
}

export interface ThreatFeed {
  /** Record a report. Add-only: there is no delete. */
  report(r: Omit<ThreatReport, "observedAt"> & { observedAt?: string }): Promise<ThreatReport>;
  /** Distinct verified humans who reported this venue inside the window. */
  distinctReporters(venue: string, windowMs: number): Promise<number>;
  /** Reports for a venue, newest first. */
  lookup(venue: string, windowMs: number): Promise<ThreatReport[]>;
  /** The feed head: how many reports exist and when the last one landed. */
  head(): Promise<{ count: number; lastAt: string | null; venues: number }>;
}

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function normalizeVenue(venue: string): string {
  return venue.trim().toLowerCase();
}

/** In-memory feed. Loses state on restart; fine for a single process, wrong for a hub. */
export class MemoryThreatFeed implements ThreatFeed {
  private readonly reports: ThreatReport[] = [];

  async report(r: Omit<ThreatReport, "observedAt"> & { observedAt?: string }): Promise<ThreatReport> {
    const rec: ThreatReport = {
      ...r,
      venue: normalizeVenue(r.venue),
      observedAt: r.observedAt ?? new Date().toISOString(),
    };
    this.reports.push(rec);
    return rec;
  }

  async distinctReporters(venue: string, windowMs: number): Promise<number> {
    const humans = new Set<string>();
    for (const r of await this.lookup(venue, windowMs)) {
      if (r.humanId) humans.add(r.humanId);
    }
    return humans.size;
  }

  async lookup(venue: string, windowMs: number): Promise<ThreatReport[]> {
    const v = normalizeVenue(venue);
    const since = Date.now() - windowMs;
    return this.reports
      .filter((r) => r.venue === v && Date.parse(r.observedAt) >= since)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  }

  async head() {
    const last = this.reports[this.reports.length - 1];
    return {
      count: this.reports.length,
      lastAt: last ? last.observedAt : null,
      venues: new Set(this.reports.map((r) => r.venue)).size,
    };
  }
}
