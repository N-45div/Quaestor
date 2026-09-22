//! A stand-in for a swap aggregator, used only by the local test validator.
//!
//! The governor pins which program its vault's signature may reach, so the real
//! Jupiter aggregator cannot be called from a local validator that does not
//! have it. That would leave the two checks this project exists for — that a
//! route cannot overspend the vault, and cannot underdeliver against the
//! intent's floor — untested, since both are measured around the CPI.
//!
//! This program takes the two amounts as arguments instead of computing them
//! from liquidity, so a test can construct exactly the route it needs: one that
//! pays out too little, one that takes too much, one that behaves. It is
//! deliberately dumb; the point is that the governor's postconditions hold no
//! matter how badly the thing it called behaves.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Approve, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("3RTVgJ1jXnUZTkaQwvgZiy98vfFqHxHr9Ey8CXyX9imS");

#[program]
pub mod router_stub {
    use super::*;

    /// Move `input_taken` out of the payer's vault and `output_given` back.
    /// Either side may be zero, which is how a test builds a route that takes
    /// the money and delivers nothing.
    pub fn swap(ctx: Context<Swap>, input_taken: u64, output_given: u64) -> Result<()> {
        if input_taken > 0 {
            // The vault authority reached us as a signer through the governor's
            // invoke_signed, and signer privileges carry down the CPI chain, so
            // this needs no seeds of its own.
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.input_token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.input_mint.to_account_info(),
                        to: ctx.accounts.pool_input.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                ),
                input_taken,
                ctx.accounts.input_mint.decimals,
            )?;
        }
        if output_given > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.output_token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.pool_output.to_account_info(),
                        mint: ctx.accounts.output_mint.to_account_info(),
                        to: ctx.accounts.destination.to_account_info(),
                        authority: ctx.accounts.pool_authority.to_account_info(),
                    },
                ),
                output_given,
                ctx.accounts.output_mint.decimals,
            )?;
        }
        Ok(())
    }

    /// A route that swaps exactly as asked and, on the same borrowed signature,
    /// makes the pool authority a delegate of the whole vault.
    ///
    /// Every balance moves as authorised, so no balance check can see it; the
    /// vault simply stops being the governor's alone, and whoever holds the
    /// delegation can empty it later. The governor has to read the vault's
    /// authorities back after the call to refuse it.
    pub fn swap_and_approve(ctx: Context<Swap>, input_taken: u64, output_given: u64) -> Result<()> {
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.input_token_program.key(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.input_mint.to_account_info(),
                    to: a.pool_input.to_account_info(),
                    authority: a.vault_authority.to_account_info(),
                },
            ),
            input_taken,
            a.input_mint.decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                a.output_token_program.key(),
                TransferChecked {
                    from: a.pool_output.to_account_info(),
                    mint: a.output_mint.to_account_info(),
                    to: a.destination.to_account_info(),
                    authority: a.pool_authority.to_account_info(),
                },
            ),
            output_given,
            a.output_mint.decimals,
        )?;
        token_interface::approve(
            CpiContext::new(
                a.input_token_program.key(),
                Approve {
                    to: a.vault.to_account_info(),
                    delegate: a.pool_authority.to_account_info(),
                    authority: a.vault_authority.to_account_info(),
                },
            ),
            u64::MAX,
        )
    }

    /// Take `amount` back *out* of the destination, on the vault authority's
    /// borrowed signature.
    ///
    /// A router that has been handed a signature can point it at any account
    /// that signature owns, and the vault authority owns the share account as
    /// well as the USDC vault. This is the route that buys nothing and helps
    /// itself to the position the agent already held. It shares `Swap`'s
    /// accounts so a test can aim it with the same list.
    pub fn sweep(ctx: Context<Swap>, amount: u64) -> Result<()> {
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.output_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.destination.to_account_info(),
                    mint: ctx.accounts.output_mint.to_account_info(),
                    to: ctx.accounts.pool_output.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.output_mint.decimals,
        )
    }

    /// A route that does exactly what it was asked — takes the input, delivers
    /// the output — and, in the same instruction, sells off a *different*
    /// position the agent holds.
    ///
    /// Postconditions on the vault and on the instrument being bought cannot
    /// see this: both move exactly as authorised. The only defence is for the
    /// borrowed signature not to own that other position in the first place,
    /// which is what this route exists to prove.
    pub fn swap_and_sweep(
        ctx: Context<SwapAndSweep>,
        input_taken: u64,
        output_given: u64,
        swept: u64,
    ) -> Result<()> {
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.input_token_program.key(),
                TransferChecked {
                    from: a.vault.to_account_info(),
                    mint: a.input_mint.to_account_info(),
                    to: a.pool_input.to_account_info(),
                    authority: a.vault_authority.to_account_info(),
                },
            ),
            input_taken,
            a.input_mint.decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                a.output_token_program.key(),
                TransferChecked {
                    from: a.pool_output.to_account_info(),
                    mint: a.output_mint.to_account_info(),
                    to: a.destination.to_account_info(),
                    authority: a.pool_authority.to_account_info(),
                },
            ),
            output_given,
            a.output_mint.decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                a.output_token_program.key(),
                TransferChecked {
                    from: a.other_position.to_account_info(),
                    mint: a.other_mint.to_account_info(),
                    to: a.other_pool.to_account_info(),
                    authority: a.vault_authority.to_account_info(),
                },
            ),
            swept,
            a.other_mint.decimals,
        )
    }
}

#[derive(Accounts)]
pub struct SwapAndSweep<'info> {
    /// CHECK: signer forwarded by the governor's invoke_signed.
    pub vault_authority: UncheckedAccount<'info>,
    pub pool_authority: Signer<'info>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_input: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_output: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub input_mint: InterfaceAccount<'info, Mint>,
    pub output_mint: InterfaceAccount<'info, Mint>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    /// A position held for another instrument — the one this route should
    /// never be able to reach.
    #[account(mut)]
    pub other_position: InterfaceAccount<'info, TokenAccount>,
    pub other_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub other_pool: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// CHECK: signer forwarded by the governor's invoke_signed.
    pub vault_authority: UncheckedAccount<'info>,
    pub pool_authority: Signer<'info>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_input: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_output: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub input_mint: InterfaceAccount<'info, Mint>,
    pub output_mint: InterfaceAccount<'info, Mint>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
}
