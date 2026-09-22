//! Quaestor Stocks — an on-chain spend governor for agents trading tokenised
//! equities on Solana.
//!
//! The TypeScript layer in `stocks/` models this policy so agents can preview a
//! decision before paying for it. This program is where the policy is actually
//! enforced, and the difference matters: off-chain the governor can only check
//! what a router *promises*, and a promise is not a guarantee. Jupiter returns
//! an expected fill (`outAmount`) and a threshold it enforces
//! (`otherAmountThreshold`); a route is free to land anywhere between them, and
//! a malicious or buggy route can be built to spend more input than it quoted.
//!
//! So this program does not trust the quote at all. It brackets the swap CPI
//! with balance reads and checks **postconditions on real token accounts**:
//!
//!   * the vault gave up no more USDC than the owner authorised for this trade
//!   * the agent received at least the minimum output the intent committed to
//!
//! Both are measured after the fact, from the accounts themselves. A route that
//! cannot satisfy them reverts the whole transaction, so there is no state in
//! which the budget was debited for a fill that never honoured its floor.
//!
//! Authority is split three ways, as in the EVM governor this project began as:
//! the owner funds and sets policy, the operator may only spend inside it, and
//! neither can raise a cap from the trading path.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("7whSJDtnCjhjPiBeLWoyVYHemtG1BnyBVfuJuuNDtFEG");

pub const GOVERNOR_SEED: &[u8] = b"governor";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault";
pub const INSTRUMENT_SEED: &[u8] = b"instrument";
pub const INTENT_SEED: &[u8] = b"intent";
pub const ROUTER_SEED: &[u8] = b"router";
/// Authority over a *position*, one per instrument. It is never lent to a
/// router: a bought stock is credited, never spent, during a trade. It signs
/// only in `withdraw_position`, which the owner must sign.
pub const POSITION_SEED: &[u8] = b"position";

#[program]
pub mod quaestor_stocks {
    use super::*;

    pub fn initialize_governor(
        ctx: Context<InitializeGovernor>,
        operator: Pubkey,
        epoch_cap: u64,
        per_trade_cap: u64,
        epoch_length: i64,
    ) -> Result<()> {
        require!(epoch_length > 0, StockError::InvalidPolicy);
        require!(per_trade_cap > 0 && per_trade_cap <= epoch_cap, StockError::InvalidPolicy);

        let governor = &mut ctx.accounts.governor;
        governor.owner = ctx.accounts.owner.key();
        governor.operator = operator;
        governor.usdc_mint = ctx.accounts.usdc_mint.key();
        governor.vault = ctx.accounts.vault.key();
        governor.epoch_cap = epoch_cap;
        governor.per_trade_cap = per_trade_cap;
        governor.epoch_length = epoch_length;
        governor.current_epoch = Clock::get()?.unix_timestamp / epoch_length;
        governor.spent_in_epoch = 0;
        governor.suspended = false;
        governor.bump = ctx.bumps.governor;
        governor.vault_authority_bump = ctx.bumps.vault_authority;
        Ok(())
    }

    /// Caps are owner-only and can never be reached from the trading path.
    pub fn set_policy(
        ctx: Context<OwnerOnly>,
        epoch_cap: u64,
        per_trade_cap: u64,
    ) -> Result<()> {
        require!(per_trade_cap > 0 && per_trade_cap <= epoch_cap, StockError::InvalidPolicy);
        let governor = &mut ctx.accounts.governor;
        governor.epoch_cap = epoch_cap;
        governor.per_trade_cap = per_trade_cap;
        emit!(PolicyChanged { governor: governor.key(), epoch_cap, per_trade_cap });
        Ok(())
    }

    /// The operator may only be replaced by the owner, never rotated in-flight.
    pub fn set_operator(ctx: Context<OwnerOnly>, operator: Pubkey) -> Result<()> {
        ctx.accounts.governor.operator = operator;
        Ok(())
    }

    /// Allow this vault's signature to reach one more venue.
    ///
    /// A governor may hold several at once — Jupiter, Meteora, whatever routes
    /// the best fill next quarter — and the operator chooses between them per
    /// trade. Only the owner may add one, so an agent can pick a venue but can
    /// never widen the set it picks from.
    ///
    /// Allowing more than one costs nothing in safety, because safety was never
    /// a property of the venue: `execute_trade` measures the token accounts
    /// either side of the call, and those checks hold whichever program ran.
    /// The allowlist is least-authority, not the guarantee.
    pub fn approve_router(ctx: Context<ApproveRouter>, label: [u8; 16]) -> Result<()> {
        let approved = &mut ctx.accounts.approved_router;
        approved.governor = ctx.accounts.governor.key();
        approved.program = ctx.accounts.router_program.key();
        approved.label = label;
        approved.bump = ctx.bumps.approved_router;
        emit!(RouterApproved {
            governor: approved.governor,
            router_program: approved.program,
            label,
        });
        Ok(())
    }

    /// Closing the PDA withdraws the venue and returns its rent. Any trade
    /// already signed against it stops being executable.
    pub fn revoke_router(ctx: Context<RevokeRouter>) -> Result<()> {
        emit!(RouterRevoked {
            governor: ctx.accounts.governor.key(),
            router_program: ctx.accounts.approved_router.program,
        });
        Ok(())
    }

    pub fn set_suspended(ctx: Context<OwnerOnly>, suspended: bool) -> Result<()> {
        ctx.accounts.governor.suspended = suspended;
        Ok(())
    }

    /// Approving a mint creates a PDA. Its existence *is* the allowlist, so the
    /// trading path proves approval by deriving an address rather than by
    /// scanning a vector that would bound how many instruments can be approved.
    pub fn approve_instrument(ctx: Context<ApproveInstrument>) -> Result<()> {
        let approved = &mut ctx.accounts.approved_instrument;
        approved.governor = ctx.accounts.governor.key();
        approved.mint = ctx.accounts.instrument_mint.key();
        approved.bump = ctx.bumps.approved_instrument;
        emit!(InstrumentApproved {
            governor: approved.governor,
            mint: approved.mint,
        });
        Ok(())
    }

    /// Closing the PDA revokes the instrument and returns its rent.
    pub fn revoke_instrument(ctx: Context<RevokeInstrument>) -> Result<()> {
        emit!(InstrumentRevoked {
            governor: ctx.accounts.governor.key(),
            mint: ctx.accounts.approved_instrument.mint,
        });
        Ok(())
    }

    pub fn deposit_usdc(ctx: Context<DepositUsdc>, amount: u64) -> Result<()> {
        require!(amount > 0, StockError::InvalidAmount);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.depositor_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
        Ok(())
    }

    pub fn withdraw_usdc(ctx: Context<WithdrawUsdc>, amount: u64) -> Result<()> {
        require!(amount > 0, StockError::InvalidAmount);
        let governor_key = ctx.accounts.governor.key();
        let seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            governor_key.as_ref(),
            &[ctx.accounts.governor.vault_authority_bump],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
        Ok(())
    }

    /// Take bought tokens out of the governor: owner-only, and to wherever the
    /// owner chooses, as with `withdraw_usdc`.
    ///
    /// This is the one place a position authority signs. `execute_trade` never
    /// lends it, so a route still cannot spend a position; only the owner can
    /// move one, and only by signing this.
    ///
    /// The instrument does not have to be approved still. Revoking a mint stops
    /// the agent buying more of it; it must not strand what was already bought.
    pub fn withdraw_position(ctx: Context<WithdrawPosition>, amount: u64) -> Result<()> {
        require!(amount > 0, StockError::InvalidAmount);
        let governor_key = ctx.accounts.governor.key();
        let mint_key = ctx.accounts.instrument_mint.key();
        let seeds: &[&[u8]] = &[
            POSITION_SEED,
            governor_key.as_ref(),
            mint_key.as_ref(),
            &[ctx.bumps.position_authority],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.position.to_account_info(),
                    mint: ctx.accounts.instrument_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.position_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.instrument_mint.decimals,
        )?;
        emit!(PositionWithdrawn {
            governor: governor_key,
            mint: mint_key,
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }

    /// Spend from the vault through Jupiter, inside the owner's limits.
    ///
    /// `swap_data` and `remaining_accounts` are the instruction Jupiter's
    /// `/swap/v2/build` returns for CPI composition. They are passed through
    /// unread: this program deliberately does not try to parse a route. It
    /// instead measures both token accounts either side of the call, which is
    /// the only check that stays true no matter what the route does.
    pub fn execute_trade(
        ctx: Context<ExecuteTrade>,
        intent_id: [u8; 32],
        decision_hash: [u8; 32],
        decision_record_hash: [u8; 32],
        amount_in: u64,
        min_output: u64,
        swap_data: Vec<u8>,
    ) -> Result<()> {
        require!(!ctx.accounts.governor.suspended, StockError::Suspended);
        require!(amount_in > 0, StockError::InvalidAmount);
        require!(min_output > 0, StockError::InvalidMinimumOutput);
        require!(
            amount_in <= ctx.accounts.governor.per_trade_cap,
            StockError::PerTradeCapExceeded
        );

        // Roll the epoch before the cap check so a trade is always measured
        // against the window it actually lands in.
        let now = Clock::get()?.unix_timestamp;
        let epoch = now
            .checked_div(ctx.accounts.governor.epoch_length)
            .ok_or(StockError::InvalidPolicy)?;
        {
            let governor = &mut ctx.accounts.governor;
            if epoch != governor.current_epoch {
                governor.current_epoch = epoch;
                governor.spent_in_epoch = 0;
            }
        }
        let spent_after = ctx
            .accounts
            .governor
            .spent_in_epoch
            .checked_add(amount_in)
            .ok_or(StockError::MathOverflow)?;
        require!(
            spent_after <= ctx.accounts.governor.epoch_cap,
            StockError::EpochCapExceeded
        );

        let vault_before = ctx.accounts.vault.amount;
        let stock_before = ctx.accounts.stock_account.amount;
        require!(vault_before >= amount_in, StockError::InsufficientVault);

        // Build the Jupiter instruction from what the caller supplied. The
        // program id is pinned by the account constraint, so the vault's
        // signature can only ever reach Jupiter.
        //
        // The vault authority is promoted to a signer here and nowhere else.
        // It is a PDA, so it cannot have signed the outer transaction, and a
        // router that is handed it unsigned cannot move anything out of the
        // vault — the swap dies as a privilege escalation. Every other account
        // keeps the flags the outer transaction gave it: this program lends one
        // signature, the one whose seeds it passes to invoke_signed below, and
        // a route must not be able to borrow any other.
        let vault_authority_key = ctx.accounts.vault_authority.key();
        let mut metas: Vec<AccountMeta> = Vec::with_capacity(ctx.remaining_accounts.len());
        for account in ctx.remaining_accounts.iter() {
            let is_signer = account.is_signer || *account.key == vault_authority_key;
            metas.push(if account.is_writable {
                AccountMeta::new(*account.key, is_signer)
            } else {
                AccountMeta::new_readonly(*account.key, is_signer)
            });
        }
        let swap_ix = Instruction {
            program_id: ctx.accounts.router_program.key(),
            accounts: metas,
            data: swap_data,
        };

        let governor_key = ctx.accounts.governor.key();
        let signer_seeds: &[&[u8]] = &[
            VAULT_AUTHORITY_SEED,
            governor_key.as_ref(),
            &[ctx.accounts.governor.vault_authority_bump],
        ];
        invoke_signed(&swap_ix, ctx.remaining_accounts, &[signer_seeds])?;

        // Everything above this line was a request. Everything below is what
        // actually happened, read back from the accounts themselves.
        ctx.accounts.vault.reload()?;
        ctx.accounts.stock_account.reload()?;

        // The route held the vault's signature for the length of the call, and
        // a signature can do more than move tokens: it can approve a delegate
        // or hand the vault to a new owner, and leave every balance as it was.
        // The checks below would pass and the vault would no longer be the
        // governor's alone, so its authorities are read back too. The position
        // needs no such check: its authority is never lent.
        require!(
            ctx.accounts.vault.owner == vault_authority_key
                && ctx.accounts.vault.delegate.is_none()
                && ctx.accounts.vault.close_authority.is_none(),
            StockError::VaultAuthorityChanged
        );
        let vault_after = ctx.accounts.vault.amount;
        let stock_after = ctx.accounts.stock_account.amount;

        let spent = vault_before
            .checked_sub(vault_after)
            .ok_or(StockError::VaultBalanceIncreased)?;
        require!(spent <= amount_in, StockError::RouteOverspent);

        // The vault authority owns the destination as well as the vault, so the
        // signature lent above reaches both. A route that pointed it at the
        // destination and swept shares out would leave a *negative* delta here;
        // measuring the net movement is what makes that a revert rather than a
        // purchase that quietly cost the agent its existing position.
        let received = stock_after
            .checked_sub(stock_before)
            .ok_or(StockError::StockBalanceDecreased)?;
        require!(received >= min_output, StockError::MinimumOutputNotMet);

        // Charge the epoch what the route actually took, not what it was
        // allowed to take: an under-spending route must not consume budget it
        // never used.
        let governor = &mut ctx.accounts.governor;
        governor.spent_in_epoch = governor
            .spent_in_epoch
            .checked_add(spent)
            .ok_or(StockError::MathOverflow)?;

        // Initialising this PDA is the replay guard: a second execution of the
        // same intent id fails at account creation, before any CPI.
        let record = &mut ctx.accounts.intent_record;
        record.governor = governor.key();
        record.intent_id = intent_id;
        record.decision_hash = decision_hash;
        record.decision_record_hash = decision_record_hash;
        record.amount_authorized = amount_in;
        record.amount_spent = spent;
        record.min_output = min_output;
        record.actual_output = received;
        record.epoch = epoch;
        record.settled_at = now;
        record.bump = ctx.bumps.intent_record;

        emit!(TradeSettled {
            governor: governor.key(),
            router_program: ctx.accounts.router_program.key(),
            intent_id,
            decision_hash,
            decision_record_hash,
            instrument_mint: ctx.accounts.instrument_mint.key(),
            amount_authorized: amount_in,
            amount_spent: spent,
            min_output,
            actual_output: received,
            epoch,
            spent_in_epoch: governor.spent_in_epoch,
            settled_at: now,
        });
        Ok(())
    }
}

// ----------------------------------------------------------------- accounts

#[account]
pub struct Governor {
    pub owner: Pubkey,
    pub operator: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub epoch_cap: u64,
    pub per_trade_cap: u64,
    pub epoch_length: i64,
    pub current_epoch: i64,
    pub spent_in_epoch: u64,
    pub suspended: bool,
    pub bump: u8,
    pub vault_authority_bump: u8,
}

impl Governor {
    pub const SPACE: usize = 8 + 32 * 4 + 8 * 5 + 1 * 3;
}

#[account]
pub struct ApprovedInstrument {
    pub governor: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

impl ApprovedInstrument {
    pub const SPACE: usize = 8 + 32 * 2 + 1;
}

/// One per venue the owner allows. Same idiom as the instrument allowlist: the
/// account existing *is* the permission, so the set is not bounded by what fits
/// in one account, and a trade proves its venue by deriving an address.
///
/// The label is on-chain so an explorer shows which venue a governor trusts
/// without a client having to know the address book.
#[account]
pub struct ApprovedRouter {
    pub governor: Pubkey,
    pub program: Pubkey,
    pub label: [u8; 16],
    pub bump: u8,
}

impl ApprovedRouter {
    pub const SPACE: usize = 8 + 32 * 2 + 16 + 1;
}

/// One per settled trade. Its address is derived from the intent id, so the
/// account both proves the trade happened and prevents it happening twice.
#[account]
pub struct IntentRecord {
    pub governor: Pubkey,
    pub intent_id: [u8; 32],
    pub decision_hash: [u8; 32],
    pub decision_record_hash: [u8; 32],
    pub amount_authorized: u64,
    pub amount_spent: u64,
    pub min_output: u64,
    pub actual_output: u64,
    pub epoch: i64,
    pub settled_at: i64,
    pub bump: u8,
}

impl IntentRecord {
    pub const SPACE: usize = 8 + 32 + 32 * 3 + 8 * 4 + 8 * 2 + 1;
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct InitializeGovernor<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = Governor::SPACE,
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump
    )]
    pub governor: Account<'info, Governor>,
    /// CHECK: PDA that owns the vault; it signs by seeds and holds no data.
    #[account(seeds = [VAULT_AUTHORITY_SEED, governor.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = owner,
        token::mint = usdc_mint,
        token::authority = vault_authority,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
}

#[derive(Accounts)]
pub struct ApproveInstrument<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
    pub instrument_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = ApprovedInstrument::SPACE,
        seeds = [INSTRUMENT_SEED, governor.key().as_ref(), instrument_mint.key().as_ref()],
        bump
    )]
    pub approved_instrument: Account<'info, ApprovedInstrument>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveRouter<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
    /// CHECK: the venue being allowed. It is recorded, never called here.
    pub router_program: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = ApprovedRouter::SPACE,
        seeds = [ROUTER_SEED, governor.key().as_ref(), router_program.key().as_ref()],
        bump
    )]
    pub approved_router: Account<'info, ApprovedRouter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeRouter<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
    #[account(
        mut,
        close = owner,
        seeds = [ROUTER_SEED, governor.key().as_ref(), approved_router.program.as_ref()],
        bump = approved_router.bump
    )]
    pub approved_router: Account<'info, ApprovedRouter>,
}

#[derive(Accounts)]
pub struct RevokeInstrument<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
    #[account(
        mut,
        close = owner,
        seeds = [INSTRUMENT_SEED, governor.key().as_ref(), approved_instrument.mint.as_ref()],
        bump = approved_instrument.bump
    )]
    pub approved_instrument: Account<'info, ApprovedInstrument>,
}

#[derive(Accounts)]
pub struct DepositUsdc<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [GOVERNOR_SEED, governor.owner.as_ref()], bump = governor.bump)]
    pub governor: Account<'info, Governor>,
    #[account(mut, address = governor.vault @ StockError::WrongVault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(address = governor.usdc_mint @ StockError::WrongInputMint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawUsdc<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
    /// CHECK: vault PDA authority, signs by seeds.
    #[account(seeds = [VAULT_AUTHORITY_SEED, governor.key().as_ref()], bump = governor.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = governor.vault @ StockError::WrongVault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    #[account(address = governor.usdc_mint @ StockError::WrongInputMint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawPosition<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [GOVERNOR_SEED, owner.key().as_ref()],
        bump = governor.bump,
        has_one = owner @ StockError::OwnerRequired
    )]
    pub governor: Account<'info, Governor>,
    /// Deliberately not checked against the allowlist: see `withdraw_position`.
    pub instrument_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: this instrument's position authority, signs the transfer by seeds.
    #[account(seeds = [POSITION_SEED, governor.key().as_ref(), instrument_mint.key().as_ref()], bump)]
    pub position_authority: UncheckedAccount<'info>,
    /// The account `execute_trade` credits, under the same two constraints: it
    /// holds this mint, and this governor's position authority owns it.
    #[account(
        mut,
        constraint = position.mint == instrument_mint.key() @ StockError::WrongOutputMint,
        constraint = position.owner == position_authority.key() @ StockError::WrongOutputOwner
    )]
    pub position: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct ExecuteTrade<'info> {
    /// Only the operator may trade, and it can do nothing else.
    pub operator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [GOVERNOR_SEED, governor.owner.as_ref()],
        bump = governor.bump,
        constraint = governor.operator == operator.key() @ StockError::OperatorRequired
    )]
    pub governor: Account<'info, Governor>,
    /// CHECK: vault PDA authority, signs the swap by seeds.
    #[account(seeds = [VAULT_AUTHORITY_SEED, governor.key().as_ref()], bump = governor.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = governor.vault @ StockError::WrongVault)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub instrument_mint: InterfaceAccount<'info, Mint>,
    /// Existence proves the owner approved this mint.
    #[account(
        seeds = [INSTRUMENT_SEED, governor.key().as_ref(), instrument_mint.key().as_ref()],
        bump = approved_instrument.bump,
        constraint = approved_instrument.mint == instrument_mint.key() @ StockError::UnapprovedInstrument
    )]
    pub approved_instrument: Account<'info, ApprovedInstrument>,
    /// Authority over this instrument's position, derived from the mint. It is
    /// deliberately NOT the vault authority and is never promoted to a signer,
    /// so the signature lent to the router cannot spend a position — not this
    /// one, and not any position held for another instrument.
    /// CHECK: a PDA identified purely by its address; it holds no data.
    #[account(seeds = [POSITION_SEED, governor.key().as_ref(), instrument_mint.key().as_ref()], bump)]
    pub position_authority: UncheckedAccount<'info>,
    /// Destination for the bought stock. It belongs to the per-instrument
    /// position authority, so a route can deliver into it but cannot spend from
    /// it, nor reach the agent's other positions with the same signature.
    #[account(
        mut,
        constraint = stock_account.mint == instrument_mint.key() @ StockError::WrongOutputMint,
        constraint = stock_account.owner == position_authority.key() @ StockError::WrongOutputOwner
    )]
    pub stock_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = IntentRecord::SPACE,
        seeds = [INTENT_SEED, governor.key().as_ref(), intent_id.as_ref()],
        bump
    )]
    pub intent_record: Account<'info, IntentRecord>,
    /// CHECK: the venue this trade routes through. It carries no privilege of
    /// its own; the account below is what proves the owner allowed it.
    pub router_program: UncheckedAccount<'info>,
    /// Existence proves the owner approved this venue. Deriving the address is
    /// the check, so an operator can choose between every venue the owner
    /// allowed and cannot reach one they did not.
    #[account(
        seeds = [ROUTER_SEED, governor.key().as_ref(), router_program.key().as_ref()],
        bump = approved_router.bump,
        constraint = approved_router.program == router_program.key() @ StockError::UnapprovedProgram
    )]
    pub approved_router: Account<'info, ApprovedRouter>,
    pub system_program: Program<'info, System>,
}

// -------------------------------------------------------------------- events

#[event]
pub struct TradeSettled {
    pub governor: Pubkey,
    /// Which venue filled it — with several allowed, the receipt has to say.
    pub router_program: Pubkey,
    pub intent_id: [u8; 32],
    pub decision_hash: [u8; 32],
    pub decision_record_hash: [u8; 32],
    pub instrument_mint: Pubkey,
    pub amount_authorized: u64,
    pub amount_spent: u64,
    pub min_output: u64,
    pub actual_output: u64,
    pub epoch: i64,
    pub spent_in_epoch: u64,
    pub settled_at: i64,
}

#[event]
pub struct RouterApproved {
    pub governor: Pubkey,
    pub router_program: Pubkey,
    pub label: [u8; 16],
}

#[event]
pub struct RouterRevoked {
    pub governor: Pubkey,
    pub router_program: Pubkey,
}

#[event]
pub struct PolicyChanged {
    pub governor: Pubkey,
    pub epoch_cap: u64,
    pub per_trade_cap: u64,
}

#[event]
pub struct InstrumentApproved {
    pub governor: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct InstrumentRevoked {
    pub governor: Pubkey,
    pub mint: Pubkey,
}

/// `TradeSettled` says how a position grew; this says how it shrank, so the
/// two together account for every token a governor has held.
#[event]
pub struct PositionWithdrawn {
    pub governor: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

// -------------------------------------------------------------------- errors

#[error_code]
pub enum StockError {
    #[msg("owner authorization required")]
    OwnerRequired,
    #[msg("operator is not authorized")]
    OperatorRequired,
    #[msg("stock agent is suspended")]
    Suspended,
    #[msg("policy values are invalid")]
    InvalidPolicy,
    #[msg("trade amount must be positive")]
    InvalidAmount,
    #[msg("a trade must commit to a positive minimum output")]
    InvalidMinimumOutput,
    #[msg("trade exceeds the per-trade cap")]
    PerTradeCapExceeded,
    #[msg("trade exceeds the epoch cap")]
    EpochCapExceeded,
    #[msg("insufficient USDC vault balance")]
    InsufficientVault,
    #[msg("instrument is not approved by the owner")]
    UnapprovedInstrument,
    #[msg("only the configured USDC mint is accepted")]
    WrongInputMint,
    #[msg("destination account is for a different mint")]
    WrongOutputMint,
    #[msg("destination account is not owned by the vault authority")]
    WrongOutputOwner,
    #[msg("vault account does not belong to this governor")]
    WrongVault,
    #[msg("the swap may only be routed through the owner-approved router")]
    UnapprovedProgram,
    #[msg("the route spent more input than the owner authorized")]
    RouteOverspent,
    #[msg("the vault gained input tokens during a swap")]
    VaultBalanceIncreased,
    #[msg("the route removed tokens from the destination account")]
    StockBalanceDecreased,
    #[msg("the swap delivered less than the intent minimum")]
    MinimumOutputNotMet,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("the route changed who can spend the vault")]
    VaultAuthorityChanged,
}
