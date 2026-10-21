# Quaestor Operator

A growth agent that pays people only for work it has checked, from a budget its owner holds in a
contract: USDC on Arc, or MUSD on Mezo, which the owner can borrow against their BTC instead of
selling it. A project lists the work it will pay for: a post on X, a video, an article, a merged
pull request. The agent decides who to work with and what to offer inside the owner's rate bands,
escrows each deal on-chain, checks that what was delivered is real, the creator's own and marked
as paid, and pays for it.

Businesses and creators reach it in one conversation. A business says what it wants promoted and
gets a drafted project, the proven creators who fit each task, and a live quote for funding it
from BTC; a creator builds a profile once, proves their handles, and is shown the paid work that
fits them.

It pays for work that real people made for real readers. It never pays for follows, likes or
reposts, and it never messages anyone: a business can invite a creator who signed up, and the
invitation waits in that creator's profile.

Talk to it: [quaestor.dev/#/app/operator/chat](https://quaestor.dev/#/app/operator/chat) ·
projects: [quaestor.dev/#/app/operator](https://quaestor.dev/#/app/operator).

## Why

Projects already pay people to talk about them, and the usual ways are weak:

| Today | The problem | The Operator |
|---|---|---|
| Influencer deals in DMs | Paid upfront, with no proof of the work | Escrows first, pays after checking the delivered link |
| Quest platforms (follow, retweet) | Engagement is cheap to fake, so bots farm it | Pays for content from accounts with real past work |
| Bounty boards | A person reviews every submission | The agent screens applicants and checks deliveries |
| Undisclosed promotion | Breaks the FTC's endorsement rules and X's paid-partnership policy | A paid post that does not say so is not paid |

## How a deal runs

1. **Apply.** Someone picks a task on the project's page and sends a pitch, links to past work and
   a wallet. They get a private link to follow their application.
2. **Screen.** The model reads the pitch and the fetched samples against the project's brief, the
   task's rate band, the budget and the person's record here, and answers offer, reject, waitlist
   or ask the owner. An offer outside the band becomes a question for the owner, whatever the
   model wrote.
3. **Escrow.** When the applicant accepts, the governor locks the amount for that deal. A deal over
   the operator's limits waits for the owner to sign it.
4. **Deliver.** The applicant posts the work with the deal's code in it (such as `qop-a1b2c3`) and
   submits the link.
5. **Check, in code first.** Before any model sees it, the Operator fetches the link and checks the
   facts ([`verify.ts`](verify.ts)): the author is the applicant, it was published after the deal,
   a pull request is merged, it carries the deal's code, and a post, article or video says up front
   that it is paid (`#ad`, `#sponsored`, "paid partnership" in its title or opening lines). Any
   failure refuses payment without a model call; the model then judges whether that opening really
   tells readers the work is paid.
6. **Judge, then pay.** The model judges whether the content does what the task asked: pay, pay
   part, reject, or ask the owner. The governor releases the milestone to the payee on Arc, or
   burns it through CCTP for Circle's forwarder to mint on the chain the payee chose.
7. **Record.** Each decision's reasoning is published, and its hash goes on-chain with the action
   it caused, so anyone can re-hash the record and match it to the transaction.

The owner gets a heads-up for anything the agent would not decide alone, and a weekly brief.

## What the contract holds it to

[`QuaestorPayoutGovernor`](../contracts/QuaestorPayouts.sol) holds the budget. The agent is its
operator, and the owner sets:

- a cap per deal, a cap per week, a smaller cap for anyone not paid before, and how many new
  payees a week;
- that the operator can never be a payee, and that a proof link pays once (`proofHash`);
- that payouts are measured: the payee's balance must rise by what was released;
- that a cross-chain payee's route is the payee's own, signed by them (EIP-712, ERC-1271), and that
  the bridge fee stays under the owner's ceiling.

The owner can approve a deal over the limits, suspend the operator (as can a
guardian they name), or withdraw anything not in escrow, at any time. An unclaimed escrow goes back to the budget after its deadline.

## Circle on Arc

- **USDC** is the budget, the payouts and the gas.
- **Wallets**: the operator's key is a Circle developer-controlled wallet
  ([`circle.ts`](circle.ts)); the hub holds no operator key.
- **CCTP V2** with Circle's forwarding hook pays a payee on another chain
  (`releaseCrossChain`).
- **Contracts**: the payout governor factory, deployed on Arc testnet.

## On Arc testnet

| What | Address or transaction |
|---|---|
| Payouts factory | [`0xA8371e91…71e1`](https://explorer.testnet.arc.io/address/0xA8371e91c0c434920AF06adcF03967679Dd971e1) |
| Quaestor's own budget (the house project) | [`0xa5dF5F1e…369C`](https://explorer.testnet.arc.io/address/0xa5dF5F1edEfFeFb004DF35b6aB8aAB01aaA8369C), caps $5 per deal, $10 a week, $3 for anyone new |
| The operator: a Circle wallet | [`0x31b3368a…9067`](https://explorer.testnet.arc.io/address/0x31b3368ace10e80c7bc3863d78b9d5c126649067) |
| The budget handed to the Circle wallet | [`0xfa8035f8…63e7`](https://explorer.testnet.arc.io/tx/0xfa8035f8f3b2f6e3fa87e2bd658f5676deb061b59f32bd0b5e3967a8639a63e7) |

## On Mezo

- **MUSD** is the budget and the payouts; **BTC** is the gas. A budget's MUSD can be borrowed
  against BTC (a trove: the BTC stays the owner's, as collateral) or bought with BTC through
  Mezo's pools, and both can be done from the chat's funding card with the owner's wallet
  ([`app/src/lib/mezo.ts`](../app/src/lib/mezo.ts)): `swapExactTokensForTokens` on Mezo's router,
  `openTrove` with hints from `HintHelpers` and `SortedTroves`, or `withdrawMUSD` to borrow more on
  a trove already open. Every call is simulated before the wallet is asked.
- **Live quotes** come from Mezo's own contracts ([`mezo.ts`](mezo.ts)): BTC's price from the
  `PriceFeed`, the fee, the minimum loan (1,800 MUSD) and the gas deposit from `BorrowerOperations`,
  and the pool's price from the router. A budget too small to borrow for is quoted as a swap.
- **The same payout governor** runs on Mezo unchanged: the Operator keeps amounts in dollars to six
  places and converts at the contract's edge, since MUSD uses 18 decimals.

| What | Address or transaction |
|---|---|
| Payouts factory | [`0x2e91d035…2D10`](https://explorer.test.mezo.org/address/0x2e91d035D622d2ECa36B7836CBcf9651711B2D10) |
| Quaestor's own budget, 100 MUSD | [`0xBaEFcC4C…2466`](https://explorer.test.mezo.org/address/0xBaEFcC4C57eeE6769fA37C3205b07ea2D1a22466) |
| Its MUSD, borrowed against 0.035 BTC | [`openTrove`](https://explorer.test.mezo.org/tx/0x0858f99451a11e03d44c73991d8ad3cea29fc01c4b35b1950d8dd90eae9b0491) |
| The operator's key | [`0x90BdaA7d…32a7`](https://explorer.test.mezo.org/address/0x90BdaA7d388326De4799CbC1911dFFf675D132a7) |
| Production run: a deal escrowed in MUSD | [`0x4cd1ca7c…a5c4`](https://explorer.test.mezo.org/tx/0x4cd1ca7c807750e0a0e88f6a285b59b50ad6f2d935b0732942cb1e047411a5c4) |
| Production run: paid on proof, 0.30 MUSD | [`0x771f1588…17cc`](https://explorer.test.mezo.org/tx/0x771f15885c9e54aa79b80e037bd95aa5478df86a26856d32760bdf94d31817cc) |
| Funding from the browser: BTC swapped for MUSD | [`0xb047d1a9…bb52`](https://explorer.test.mezo.org/tx/0xb047d1a9ff5a48a266d00c390413c6ef3b0c5f1b55844fffc99ed4506971bb52) |

In the production run, Kimi offered $0.30 to an honest applicant and turned down one whose pitch
told it to ignore its rules; an article without `#ad` up front was refused in code with no
transaction; the disclosed one was judged and paid, and its decision record re-hashes to the hash
on-chain.

## Talk to it

[`chat.ts`](chat.ts) is one conversation over the same records as the forms. The model talks and
calls tools, and the tools are its only way to touch anything; none of them moves money.

- **A business** gets `draft_project` (a brief and up to four tasks, each with a rate band),
  `find_creators`, `show_creator_matches` and `fund_options`. A budget the business names is a
  ceiling checked in code, read from its own words. "Open this budget" hands the draft to the
  budget form, which the owner's wallet signs.
- **A creator** gets `save_profile`, `prove_handle`, `find_tasks`, `show_task_matches`,
  `apply_to_task` and `my_status`, acting only on that conversation's own profile.
- **Matching is code first.** A creator fits a task only if the kind of work is theirs, the
  platform it needs is a handle they have proven, and it pays at least their lowest rate
  ([`creators.ts`](creators.ts), `fitsTask`); where the bands meet is worked out in code and handed
  to the model as a fact. The model only ranks what is left and says why.
- **What the model never decides:** a proof code is issued by the creator book, and a code the model
  writes itself is replaced with the real one; an application's private link goes to the person's
  card, never into the model's context.

The chat runs on Kimi with thinking off, about three seconds a call; judging delivered work keeps
thinking on.

## The creator book

[`creators.ts`](creators.ts) keeps one profile per creator across every project: niches, the kinds
of work they do, sample links, a rate band, the wallet they are paid at and the networks they take
payment on. A handle counts only once it is proven by publishing a one-time code from it: a post on
X, a YouTube video's title, or a public GitHub gist, each read from the platform, never from the
creator, and no older than 14 days. Whoever proves a handle last owns it here. A creator's track
record is what the Operator actually paid their wallet, on any project and chain. Only creators who
signed up are listed.

## The model

The hub uses Claude when `ANTHROPIC_API_KEY` is set and Kimi otherwise
([`decide.ts`](decide.ts)). Both get the same rules, questions and answer schemas, and both are
held to the same checks: the owner's band is enforced in code, a failed fact check refuses
payment whatever the model says, and everything an applicant wrote or linked is marked as data,
never instructions. Kimi answers in JSON mode, its answer is checked against the schema, and an
answer that does not match goes back once with what was wrong.

## Honest limits

- It runs on Arc testnet and Mezo testnet, so the payouts are test USDC and test MUSD.
- Matching can only be as good as who has signed up: today that is a handful of profiles, and a
  task with no fit is open for anyone to apply.
- A trove has a 1,800 MUSD minimum, so small budgets are funded by swapping BTC, which sells it.
- An article's author cannot be read reliably from a web page, so for articles the deal's code is
  what ties the work to the applicant.
- The disclosure check reads the text: it confirms a disclosure sits in the title or opening lines,
  not that the platform labelled it. Our own production test found the first version accepted an
  article that only mentioned `#ad` deep in its body; the rule now wants it up front, and that case
  is a test.
- Arc's privacy features are not live yet, so every payout is public. Here that is the point: anyone
  can audit why money moved.

## Run it

The Operator mounts in the stocks hub (`services/stocks-main.ts`) when `OP_NETWORKS` is set;
[`services/operator.ts`](../services/operator.ts) lists every variable. Tests:

```
npx hardhat test test/operator-*.test.ts test/quaestor-payouts.test.ts
```
