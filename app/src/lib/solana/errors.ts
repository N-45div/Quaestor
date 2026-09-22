/**
 * What a failed Solana transaction was refused for, in words. A refusal
 * from the program carries its Anchor error name in the logs; the runtime's
 * own refusals carry a message; a wallet the owner closed says so.
 */
const PLAIN: Record<string, string> = {
  OwnerRequired: "This wallet is not the governor's owner.",
  OperatorRequired: "This key is not the governor's agent key.",
  Suspended: "The governor is suspended.",
  InvalidPolicy: "The caps are not valid: the per-trade cap must be above zero and not above the epoch cap.",
  InvalidAmount: "The amount must be above zero.",
  InvalidMinimumOutput: "A trade must set a floor above zero.",
  PerTradeCapExceeded: "Larger than the per-trade cap.",
  EpochCapExceeded: "This epoch's budget is used up.",
  InsufficientVault: "The vault holds less than this.",
  UnapprovedInstrument: "The owner has not allowed this token.",
  UnapprovedProgram: "The owner has not allowed this venue.",
  MinimumOutputNotMet: "Less than the floor arrived; the whole trade was undone.",
  RouteOverspent: "The venue took more than was authorised; the whole trade was undone.",
};

export function explainSolanaError(error: unknown): string {
  const e = error as { message?: string; logs?: string[]; transactionLogs?: string[]; getLogs?: () => string[] };
  const logs = e.logs ?? e.transactionLogs ?? [];
  const text = [e.message ?? String(error), ...logs].join("\n");
  const code = /Error Code: (\w+)/.exec(text)?.[1];
  if (code) return PLAIN[code] ? `${PLAIN[code]} (${code})` : `The program refused it: ${code}.`;
  if (/already in use/i.test(text)) return "This wallet already has a governor; each wallet can own one.";
  // The token program's words: the account paying out holds less than asked.
  if (/Error: insufficient funds/i.test(text)) return "The token account paying this holds less than the amount.";
  if (/insufficient (lamports|funds)|no record of a prior credit/i.test(text)) return "The wallet does not hold enough SOL or test USDC for this.";
  if (/user rejected|rejected the request|declined/i.test(text)) return "The wallet declined to sign. Nothing was sent.";
  return (e.message ?? String(error)).split("\n")[0].slice(0, 200);
}

/** A test-USDC amount typed by a person, in base units, or null when it is not a plain decimal. */
export function parseUsdc(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}
