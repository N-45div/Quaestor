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
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

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
