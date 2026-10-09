# Quaestor Operator

A growth agent on Arc. A project funds a USDC budget and lists the work it will pay for: a post on
X, a video, an article, a merged pull request. People apply. The agent decides who to work with and
what to offer inside the owner's rate bands, escrows each deal on-chain, checks that what was
delivered is real, the applicant's own and marked as paid, and pays for it, on Arc or on the
payee's own chain.

It pays for work that real people made for real readers. It never pays for follows, likes or
reposts, and it never writes to anyone first: people come to it.

Open it in the app: [quaestor-app.onrender.com/#/app/operator](https://quaestor-app.onrender.com/#/app/operator).

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
   a pull request is merged, it carries the deal's code, and a post, article or video says it is
   paid (`#ad`, `#sponsored`, "paid partnership"). Any failure refuses payment without a model
   call.
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

## The model

The hub uses Claude when `ANTHROPIC_API_KEY` is set and Kimi otherwise
([`decide.ts`](decide.ts)). Both get the same rules, questions and answer schemas, and both are
held to the same checks: the owner's band is enforced in code, a failed fact check refuses
payment whatever the model says, and everything an applicant wrote or linked is marked as data,
never instructions. Kimi answers in JSON mode, its answer is checked against the schema, and an
answer that does not match goes back once with what was wrong.

## Honest limits

- It runs on Arc testnet, so the payouts are test USDC.
- An article's author cannot be read reliably from a web page, so for articles the deal's code is
  what ties the work to the applicant.
- The disclosure check reads the text: it confirms the post says it is paid, not that the platform
  labelled it.
- Arc's privacy features are not live yet, so every payout is public. Here that is the point: anyone
  can audit why money moved.

## Run it

The Operator mounts in the stocks hub (`services/stocks-main.ts`) when `OP_NETWORKS` is set;
[`services/operator.ts`](../services/operator.ts) lists every variable. Tests:

```
npx hardhat test test/operator-*.test.ts test/quaestor-payouts.test.ts
```
