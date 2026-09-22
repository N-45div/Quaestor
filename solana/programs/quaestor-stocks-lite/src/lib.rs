//! Quaestor Stocks, lean build — the same on-chain spend governor as
//! `programs/quaestor-stocks`, written against Pinocchio instead of Anchor.
//!
//! Why it exists: a program's rent is its size, and the Anchor build is ~320 KB
//! (about 2.3 SOL). This one carries no framework and no allocator, so it costs
//! a small fraction of that to put on mainnet.
//!
//! It is a port, not a redesign. The wire format is Anchor's, byte for byte:
//! the same eight-byte instruction and account discriminators, the same borsh
//! argument and account layouts, the same PDA seeds, the same account order and
//! the same error names in the log. So the client in `solana/client.ts` and the
//! validator tests in `solana/tests/` run against either binary unchanged, and
//! that suite — not this file's resemblance to the other — is the evidence that
//! the two enforce the same policy.
//!
//! The thesis is unchanged too: `execute_trade` never parses the route. It
//! brackets the swap CPI with reads of the real token accounts and reverts
//! unless the vault gave up no more than was authorised and the position gained
//! at least the promised minimum.
#![no_std]
#![allow(unexpected_cfgs)]

use pinocchio::{
    cpi::{invoke_signed_with_bounds, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    no_allocator, nostd_panic_handler, program_entrypoint,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};

program_entrypoint!(process_instruction);
no_allocator!();
nostd_panic_handler!();

// --------------------------------------------------------------------- seeds

const GOVERNOR_SEED: &[u8] = b"governor";
const VAULT_AUTHORITY_SEED: &[u8] = b"vault";
const INSTRUMENT_SEED: &[u8] = b"instrument";
const INTENT_SEED: &[u8] = b"intent";
const ROUTER_SEED: &[u8] = b"router";
/// Authority over a *position*, one per instrument. It is never lent to a
/// router: a bought stock is credited, never spent, during a trade.
const POSITION_SEED: &[u8] = b"position";

// ------------------------------------------------------------ fixed addresses

const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const TOKEN_PROGRAM: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145, 58,
    140, 245, 133, 126, 255, 0, 169,
]);
const TOKEN_2022_PROGRAM: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254,
    189, 249, 40, 216, 161, 139, 252,
]);

// ------------------------------------------------- Anchor's wire format, kept

// sha256("global:<name>")[..8]
const IX_INITIALIZE_GOVERNOR: u64 = 0x3b9f1c21440b9069; // 105, 144, 11, 68, 33, 28, 159, 59
const IX_SET_POLICY: u64 = 0x8402caeb9d0c8528; // 40, 133, 12, 157, 235, 202, 2, 132
const IX_SET_OPERATOR: u64 = 0x012483f3a96599ee; // 238, 153, 101, 169, 243, 131, 36, 1
const IX_APPROVE_ROUTER: u64 = 0xc89f71ae3738b41a; // 26, 180, 56, 55, 174, 113, 159, 200
const IX_REVOKE_ROUTER: u64 = 0x8fa0d2fdf0faa0d8; // 216, 160, 250, 240, 253, 210, 160, 143
const IX_SET_SUSPENDED: u64 = 0xf0b436d13cc8b6f0; // 240, 182, 200, 60, 209, 54, 180, 240
const IX_APPROVE_INSTRUMENT: u64 = 0x95867c57643a626a; // 106, 98, 58, 100, 87, 124, 134, 149
const IX_REVOKE_INSTRUMENT: u64 = 0x7c2795ab3b6ea51d; // 29, 165, 110, 59, 171, 149, 39, 124
const IX_DEPOSIT_USDC: u64 = 0x7e22d5e0a9fa94b8; // 184, 148, 250, 169, 224, 213, 34, 126
const IX_WITHDRAW_USDC: u64 = 0x9bf39c1bb8483172; // 114, 49, 72, 184, 27, 156, 243, 155
const IX_EXECUTE_TRADE: u64 = 0x616a000d87c0104d; // 77, 16, 192, 135, 13, 0, 106, 97

// sha256("account:<Name>")[..8]
const ACC_GOVERNOR: [u8; 8] = [37, 136, 44, 80, 68, 85, 213, 178];
const ACC_INSTRUMENT: [u8; 8] = [128, 71, 158, 138, 196, 82, 57, 202];
const ACC_ROUTER: [u8; 8] = [185, 221, 41, 53, 45, 159, 75, 56];
const ACC_INTENT: [u8; 8] = [176, 14, 151, 250, 200, 218, 41, 101];

// sha256("event:<Name>")[..8]
const EVT_TRADE_SETTLED: [u8; 8] = [22, 119, 166, 225, 175, 53, 93, 216];
const EVT_ROUTER_APPROVED: [u8; 8] = [51, 209, 34, 124, 110, 148, 190, 16];
const EVT_ROUTER_REVOKED: [u8; 8] = [45, 16, 17, 166, 189, 49, 20, 163];
const EVT_POLICY_CHANGED: [u8; 8] = [248, 184, 113, 45, 123, 255, 43, 248];
const EVT_INSTRUMENT_APPROVED: [u8; 8] = [122, 42, 203, 4, 216, 49, 151, 89];
const EVT_INSTRUMENT_REVOKED: [u8; 8] = [44, 151, 103, 6, 77, 120, 226, 244];

// Account sizes and field offsets: discriminator, then borsh, which for these
// structs is simply the fields packed little-endian in declaration order.
const GOVERNOR_LEN: usize = 8 + 32 * 4 + 8 * 5 + 3; // 179
const G_OWNER: usize = 8;
const G_OPERATOR: usize = 40;
const G_USDC_MINT: usize = 72;
const G_VAULT: usize = 104;
const G_EPOCH_CAP: usize = 136;
const G_PER_TRADE_CAP: usize = 144;
const G_EPOCH_LENGTH: usize = 152;
const G_CURRENT_EPOCH: usize = 160;
const G_SPENT: usize = 168;
const G_SUSPENDED: usize = 176;
const G_BUMP: usize = 177;
const G_VAULT_AUTHORITY_BUMP: usize = 178;
// A trade writes `current_epoch` and `spent_in_epoch` as one 16-byte block.
const _: () = assert!(G_SPENT == G_CURRENT_EPOCH + 8);

const INSTRUMENT_LEN: usize = 8 + 32 * 2 + 1; // 73: governor, mint, bump
const ROUTER_LEN: usize = 8 + 32 * 2 + 16 + 1; // 89: governor, program, label, bump
const INTENT_LEN: usize = 8 + 32 + 32 * 3 + 8 * 4 + 8 * 2 + 1; // 185

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

/// The most accounts a route may name. It is Pinocchio's ceiling for a CPI
/// whose account list is only known at run time.
const MAX_ROUTE_ACCOUNTS: usize = 64;

// -------------------------------------------------------------------- errors

/// Log the line Anchor would have logged, and fail with the code it would have
/// used. Clients and tests read the name; explorers read the number.
#[cold]
#[inline(never)]
fn refuse(code: u32, line: &'static [u8]) -> ProgramError {
    log(line);
    ProgramError::Custom(code)
}

macro_rules! refusal {
    ($name:ident, $code:expr, $line:literal) => {
        #[cold]
        #[inline(never)]
        fn $name() -> ProgramError {
            refuse($code, $line)
        }
    };
}

// Anchor's own, where a client can tell them apart.
refusal!(e_fallback, 101, b"Error Code: InstructionFallbackNotFound.");
refusal!(e_args, 102, b"Error Code: InstructionDidNotDeserialize.");
refusal!(e_mut, 2000, b"Error Code: ConstraintMut.");
refusal!(e_seeds, 2006, b"Error Code: ConstraintSeeds.");
refusal!(e_discriminator, 3002, b"Error Code: AccountDiscriminatorMismatch.");
refusal!(e_deserialize, 3003, b"Error Code: AccountDidNotDeserialize.");
refusal!(e_not_enough, 3005, b"Error Code: AccountNotEnoughKeys.");
refusal!(e_wrong_owner, 3007, b"Error Code: AccountOwnedByWrongProgram.");
refusal!(e_program_id, 3008, b"Error Code: InvalidProgramId.");
refusal!(e_not_signer, 3010, b"Error Code: AccountNotSigner.");
refusal!(e_not_initialized, 3012, b"Error Code: AccountNotInitialized.");

// This program's, numbered as `#[error_code]` numbers them: 6000 + position.
refusal!(e_owner_required, 6000, b"Error Code: OwnerRequired.");
refusal!(e_operator_required, 6001, b"Error Code: OperatorRequired.");
refusal!(e_suspended, 6002, b"Error Code: Suspended.");
refusal!(e_invalid_policy, 6003, b"Error Code: InvalidPolicy.");
refusal!(e_invalid_amount, 6004, b"Error Code: InvalidAmount.");
refusal!(e_invalid_minimum, 6005, b"Error Code: InvalidMinimumOutput.");
refusal!(e_per_trade_cap, 6006, b"Error Code: PerTradeCapExceeded.");
refusal!(e_epoch_cap, 6007, b"Error Code: EpochCapExceeded.");
refusal!(e_insufficient_vault, 6008, b"Error Code: InsufficientVault.");
refusal!(e_unapproved_instrument, 6009, b"Error Code: UnapprovedInstrument.");
refusal!(e_wrong_input_mint, 6010, b"Error Code: WrongInputMint.");
refusal!(e_wrong_output_mint, 6011, b"Error Code: WrongOutputMint.");
refusal!(e_wrong_output_owner, 6012, b"Error Code: WrongOutputOwner.");
refusal!(e_wrong_vault, 6013, b"Error Code: WrongVault.");
refusal!(e_unapproved_program, 6014, b"Error Code: UnapprovedProgram.");
refusal!(e_route_overspent, 6015, b"Error Code: RouteOverspent.");
refusal!(e_vault_increased, 6016, b"Error Code: VaultBalanceIncreased.");
refusal!(e_stock_decreased, 6017, b"Error Code: StockBalanceDecreased.");
refusal!(e_minimum_not_met, 6018, b"Error Code: MinimumOutputNotMet.");
refusal!(e_overflow, 6019, b"Error Code: MathOverflow.");
refusal!(e_vault_rebound, 6020, b"Error Code: VaultAuthorityChanged.");

#[inline(never)]
fn log(line: &[u8]) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    unsafe {
        pinocchio::syscalls::sol_log_(line.as_ptr(), line.len() as u64);
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    let _ = line;
}

/// An Anchor event: one `Program data:` log entry of discriminator + borsh.
#[inline(never)]
fn emit(event: &[u8]) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    unsafe {
        let fields: [&[u8]; 1] = [event];
        pinocchio::syscalls::sol_log_data(fields.as_ptr() as *const u8, 1);
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    let _ = event;
}

// ------------------------------------------------------------------- reading

/// A forward-only reader. Every step returns an error rather than panicking, so
/// a short or malformed buffer is a refusal and never an abort.
struct Cursor<'a> {
    data: &'a [u8],
    /// What running out of bytes means here: bad arguments, or a bad account.
    short: fn() -> ProgramError,
}

impl<'a> Cursor<'a> {
    #[inline(never)]
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProgramError> {
        match self.data.split_at_checked(n) {
            Some((head, tail)) => {
                self.data = tail;
                Ok(head)
            }
            None => Err((self.short)()),
        }
    }
    #[inline(never)]
    fn u64(&mut self) -> Result<u64, ProgramError> {
        match self.data.split_first_chunk::<8>() {
            Some((head, tail)) => {
                self.data = tail;
                Ok(u64::from_le_bytes(*head))
            }
            None => Err((self.short)()),
        }
    }
    fn i64(&mut self) -> Result<i64, ProgramError> {
        Ok(self.u64()? as i64)
    }
    #[inline(never)]
    fn key(&mut self) -> Result<[u8; 32], ProgramError> {
        match self.data.split_first_chunk::<32>() {
            Some((head, tail)) => {
                self.data = tail;
                Ok(*head)
            }
            None => Err((self.short)()),
        }
    }
    #[inline(never)]
    fn byte(&mut self) -> Result<u8, ProgramError> {
        match self.data.split_first() {
            Some((head, tail)) => {
                self.data = tail;
                Ok(*head)
            }
            None => Err((self.short)()),
        }
    }
    /// A borsh `Vec<u8>`: a u32 length, then that many bytes.
    fn bytes(&mut self) -> Result<&'a [u8], ProgramError> {
        let len = match self.data.split_first_chunk::<4>() {
            Some((head, tail)) => {
                self.data = tail;
                u32::from_le_bytes(*head) as usize
            }
            None => return Err((self.short)()),
        };
        self.take(len)
    }
}

type Args<'a> = Cursor<'a>;

/// The governor's bytes after the discriminator, exactly as borsh laid them
/// out. Every field is a byte array, so the struct has alignment one and any
/// 171 bytes are a valid value of it: reading it is a copy, not a parse.
#[repr(C)]
#[derive(Clone, Copy)]
struct Governor {
    owner: [u8; 32],
    operator: [u8; 32],
    usdc_mint: [u8; 32],
    vault: [u8; 32],
    epoch_cap: [u8; 8],
    per_trade_cap: [u8; 8],
    epoch_length: [u8; 8],
    current_epoch: [u8; 8],
    spent_in_epoch: [u8; 8],
    suspended: u8,
    bump: u8,
    vault_authority_bump: u8,
}

/// ApprovedInstrument after its discriminator.
#[repr(C)]
#[derive(Clone, Copy)]
struct InstrumentBody {
    governor: [u8; 32],
    mint: [u8; 32],
    bump: u8,
}

/// ApprovedRouter after its discriminator.
#[repr(C)]
#[derive(Clone, Copy)]
struct RouterBody {
    governor: [u8; 32],
    program: [u8; 32],
    label: [u8; 16],
    bump: u8,
}

/// The front of any SPL token account: the part this program reads.
#[repr(C)]
#[derive(Clone, Copy)]
struct TokenFront {
    mint: [u8; 32],
    owner: [u8; 32],
    amount: [u8; 8],
}

/// A type that is nothing but bytes: `repr(C)`, alignment one, no padding, and
/// every bit pattern valid. That is what makes copying it out of account data
/// a read rather than a parse.
///
/// # Safety
/// Implement it only for structs built purely from `u8` and `[u8; N]`.
unsafe trait Plain: Copy {}
unsafe impl Plain for Governor {}
unsafe impl Plain for InstrumentBody {}
unsafe impl Plain for RouterBody {}
unsafe impl Plain for TokenFront {}

const _: () = assert!(core::mem::size_of::<Governor>() == GOVERNOR_LEN - 8 && core::mem::align_of::<Governor>() == 1);
const _: () = assert!(core::mem::size_of::<InstrumentBody>() == INSTRUMENT_LEN - 8 && core::mem::align_of::<InstrumentBody>() == 1);
const _: () = assert!(core::mem::size_of::<RouterBody>() == ROUTER_LEN - 8 && core::mem::align_of::<RouterBody>() == 1);
const _: () = assert!(core::mem::size_of::<TokenFront>() == 72 && core::mem::align_of::<TokenFront>() == 1);

/// The first `size_of::<T>()` bytes as a `T`, or nothing if there are too few.
fn block<T: Plain>(bytes: &[u8]) -> Option<T> {
    if bytes.len() < core::mem::size_of::<T>() {
        return None;
    }
    // SAFETY: the length was just checked, and `Plain` promises alignment one
    // and no invalid bit patterns.
    Some(unsafe { core::ptr::read_unaligned(bytes.as_ptr() as *const T) })
}

/// What `Account<'info, T>` checks: it exists, this program owns it, and it
/// starts with T's discriminator.
/// What `Account<'info, T>` checks — it exists, this program owns it, and it
/// starts with T's discriminator — then hands the rest to `read`.
#[inline(never)]
fn read_owned<T>(
    account: &AccountView,
    program_id: &Address,
    discriminator: &[u8; 8],
    read: fn(&mut Cursor) -> Result<T, ProgramError>,
) -> Result<T, ProgramError> {
    if account.owned_by(&SYSTEM_PROGRAM) && account.lamports() == 0 {
        return Err(e_not_initialized());
    }
    if !account.owned_by(program_id) {
        return Err(e_wrong_owner());
    }
    let data = account.try_borrow()?;
    match data.split_first_chunk::<8>() {
        Some((tag, body)) if tag == discriminator => read(&mut Cursor { data: body, short: e_deserialize }),
        _ => Err(e_discriminator()),
    }
}

fn read_governor(c: &mut Cursor) -> Result<Governor, ProgramError> {
    block::<Governor>(c.data).ok_or_else(e_deserialize)
}

fn load_governor(account: &AccountView, program_id: &Address) -> Result<Governor, ProgramError> {
    read_owned(account, program_id, &ACC_GOVERNOR, read_governor)
}

/// An allowlist entry: what it allows, and the bump it was made with.
struct Approval {
    subject: [u8; 32],
    bump: u8,
}

fn read_instrument(c: &mut Cursor) -> Result<Approval, ProgramError> {
    let body = block::<InstrumentBody>(c.data).ok_or_else(e_deserialize)?;
    Ok(Approval { subject: body.mint, bump: body.bump })
}

fn read_router(c: &mut Cursor) -> Result<Approval, ProgramError> {
    let body = block::<RouterBody>(c.data).ok_or_else(e_deserialize)?;
    Ok(Approval { subject: body.program, bump: body.bump })
}

fn is_token_program(address: &Address) -> bool {
    *address == TOKEN_PROGRAM || *address == TOKEN_2022_PROGRAM
}

/// `InterfaceAccount<Mint>`: owned by a token program, initialised, and a mint
/// rather than a Token-2022 account that happens to be long enough.
#[inline(never)]
fn mint_decimals(account: &AccountView) -> Result<u8, ProgramError> {
    if !is_token_program(account.owner()) {
        return Err(e_wrong_owner());
    }
    let data = account.try_borrow()?;
    let shaped = data.len() == MINT_LEN || (data.len() > TOKEN_ACCOUNT_LEN && data.get(TOKEN_ACCOUNT_LEN) == Some(&1));
    match (shaped, data.get(44), data.get(45)) {
        (true, Some(decimals), Some(initialised)) if *initialised != 0 => Ok(*decimals),
        _ => Err(e_deserialize()),
    }
}

struct TokenAccount {
    mint: [u8; 32],
    owner: [u8; 32],
    amount: u64,
    /// Whether a delegate or a close authority is set: anyone besides the owner
    /// who can spend or close it. The COption tags sit at bytes 72 and 129.
    rebound: bool,
}

/// `InterfaceAccount<TokenAccount>`: owned by a token program, initialised, and
/// a token account rather than a mint with extensions.
#[inline(never)]
fn token_account(account: &AccountView) -> Result<TokenAccount, ProgramError> {
    if account.owned_by(&SYSTEM_PROGRAM) && account.lamports() == 0 {
        return Err(e_not_initialized());
    }
    if !is_token_program(account.owner()) {
        return Err(e_wrong_owner());
    }
    let data = account.try_borrow()?;
    let shaped = data.len() == TOKEN_ACCOUNT_LEN || (data.len() > TOKEN_ACCOUNT_LEN && data.get(TOKEN_ACCOUNT_LEN) == Some(&2));
    let initialised = matches!(data.get(108), Some(state) if *state != 0);
    if !shaped || !initialised {
        return Err(e_deserialize());
    }
    let front = block::<TokenFront>(&data).ok_or_else(e_deserialize)?;
    let set = |at: usize| !matches!(data.get(at..at + 4), Some([0, 0, 0, 0]));
    Ok(TokenAccount { mint: front.mint, owner: front.owner, amount: u64::from_le_bytes(front.amount), rebound: set(72) || set(129) })
}

#[inline(never)]
fn is_pda(expected: &Address, seeds: &[&[u8]], program_id: &Address) -> bool {
    match Address::create_program_address(seeds, program_id) {
        Ok(address) => address == *expected,
        Err(_) => false,
    }
}

/// The canonical PDA for these seeds. `find_program_address` panics if there is
/// none; this reports it as a seeds failure instead.
#[inline(never)]
fn find_pda(seeds: &[&[u8]], program_id: &Address) -> Result<(Address, u8), ProgramError> {
    Address::try_find_program_address(seeds, program_id).ok_or_else(e_seeds)
}

/// Every write to an account goes through here: one bounds check, one place.
#[inline(never)]
fn store(account: &mut AccountView, at: usize, bytes: &[u8]) -> ProgramResult {
    let mut data = account.try_borrow_mut()?;
    let end = at.checked_add(bytes.len()).ok_or_else(e_overflow)?;
    match data.get_mut(at..end) {
        Some(slot) => {
            for (to, from) in slot.iter_mut().zip(bytes) {
                *to = *from;
            }
            Ok(())
        }
        None => Err(e_deserialize()),
    }
}

/// Every CPI goes through here, so Pinocchio's invoke machinery is instantiated
/// once rather than at each call site.
#[inline(never)]
fn cpi(program: &Address, data: &[u8], metas: &[InstructionAccount], views: &[AccountView], signers: &[Signer]) -> ProgramResult {
    invoke_signed_with_bounds::<MAX_ROUTE_ACCOUNTS, _>(&InstructionView { program_id: program, data, accounts: metas }, views, signers)
}

fn require_signer(account: &AccountView) -> ProgramResult {
    if account.is_signer() { Ok(()) } else { Err(e_not_signer()) }
}

fn require_writable(account: &AccountView) -> ProgramResult {
    if account.is_writable() { Ok(()) } else { Err(e_mut()) }
}

fn require_token_program(account: &AccountView) -> ProgramResult {
    if is_token_program(account.address()) { Ok(()) } else { Err(e_program_id()) }
}

fn require_system_program(account: &AccountView) -> ProgramResult {
    if *account.address() == SYSTEM_PROGRAM { Ok(()) } else { Err(e_program_id()) }
}

/// The governor as the owner presents it: their PDA, and theirs.
#[inline(never)]
fn owner_governor(owner: &AccountView, governor: &AccountView, program_id: &Address) -> Result<Governor, ProgramError> {
    require_signer(owner)?;
    let state = load_governor(governor, program_id)?;
    if !is_pda(governor.address(), &[GOVERNOR_SEED, owner.address().as_ref(), &[state.bump]], program_id) {
        return Err(e_seeds());
    }
    if state.owner != *owner.address().as_array() {
        return Err(e_owner_required());
    }
    Ok(state)
}

// ---------------------------------------------------------------------- CPIs

/// Anchor's `init`: create the account, or — if someone has already sent it
/// lamports, which would make a plain create fail — top it up, allocate and
/// assign. Either way a second `init` of the same address dies in the system
/// program as "already in use", which is what makes an intent id single-use.
#[inline(never)]
fn create_account(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    owner: &Address,
    signers: &[Signer],
) -> ProgramResult {
    let rent = Rent::get()?.try_minimum_balance(space)?;
    let present = account.lamports();
    if present == 0 {
        let mut data = [0u8; 52];
        data[4..12].copy_from_slice(&rent.to_le_bytes());
        data[12..20].copy_from_slice(&(space as u64).to_le_bytes());
        data[20..52].copy_from_slice(owner.as_array());
        let metas = [InstructionAccount::writable_signer(payer.address()), InstructionAccount::writable_signer(account.address())];
        return cpi(&SYSTEM_PROGRAM, &data, &metas, &[*payer, *account], signers);
    }
    if rent > present {
        let mut data = [0u8; 12];
        data[0] = 2; // Transfer
        data[4..12].copy_from_slice(&(rent - present).to_le_bytes());
        let metas = [InstructionAccount::writable_signer(payer.address()), InstructionAccount::writable(account.address())];
        cpi(&SYSTEM_PROGRAM, &data, &metas, &[*payer, *account], &[])?;
    }
    let metas = [InstructionAccount::writable_signer(account.address())];
    let mut allocate = [0u8; 12];
    allocate[0] = 8; // Allocate
    allocate[4..12].copy_from_slice(&(space as u64).to_le_bytes());
    cpi(&SYSTEM_PROGRAM, &allocate, &metas, &[*account], signers)?;
    let mut assign = [0u8; 36];
    assign[0] = 1; // Assign
    assign[4..36].copy_from_slice(owner.as_array());
    cpi(&SYSTEM_PROGRAM, &assign, &metas, &[*account], signers)
}

#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn transfer_checked(
    token_program: &AccountView,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    let mut data = [0u8; 10];
    data[0] = 12; // TransferChecked
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = decimals;
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    cpi(token_program.address(), &data, &metas, &[*from, *mint, *to, *authority], signers)
}

/// Anchor's `close = owner`: the rent goes back, the account goes away.
#[inline(never)]
fn close_to(account: &mut AccountView, receiver: &mut AccountView) -> ProgramResult {
    let total = receiver.lamports().checked_add(account.lamports()).ok_or_else(e_overflow)?;
    receiver.set_lamports(total);
    account.close()
}

// ---------------------------------------------------------------- dispatcher

#[inline(never)]
pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (tag, rest) = match data.split_first_chunk::<8>() {
        Some(parts) => parts,
        None => return Err(e_fallback()),
    };
    let args = Args { data: rest, short: e_args };
    match u64::from_le_bytes(*tag) {
        IX_EXECUTE_TRADE => execute_trade(program_id, accounts, args),
        IX_INITIALIZE_GOVERNOR => initialize_governor(program_id, accounts, args),
        IX_SET_POLICY => set_policy(program_id, accounts, args),
        IX_SET_OPERATOR => set_operator(program_id, accounts, args),
        IX_SET_SUSPENDED => set_suspended(program_id, accounts, args),
        IX_APPROVE_ROUTER => approve_router(program_id, accounts, args),
        IX_REVOKE_ROUTER => revoke_router(program_id, accounts),
        IX_APPROVE_INSTRUMENT => approve_instrument(program_id, accounts),
        IX_REVOKE_INSTRUMENT => revoke_instrument(program_id, accounts),
        IX_DEPOSIT_USDC => deposit_usdc(program_id, accounts, args),
        IX_WITHDRAW_USDC => withdraw_usdc(program_id, accounts, args),
        _ => Err(e_fallback()),
    }
}

/// Which spending window a moment falls in. The length is positive (it cannot
/// be set otherwise) and the clock is past 1970, so this is an unsigned divide,
/// which the machine does natively; a signed one is a library routine.
#[inline(never)]
fn epoch_of(now: i64, epoch_length: i64) -> Result<i64, ProgramError> {
    if now < 0 || epoch_length <= 0 {
        return Err(e_invalid_policy());
    }
    Ok(((now as u64) / (epoch_length as u64)) as i64)
}


// ------------------------------------------------------------- owner's side

#[inline(never)]
fn initialize_governor(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: InitializeGovernor");
    let [a0, a1, a2, a3, a4, a5, a6, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let operator = args.key()?;
    let epoch_cap = args.u64()?;
    let per_trade_cap = args.u64()?;
    let epoch_length = args.i64()?;

    let owner = *a0;
    let mut governor = *a1;
    let vault_authority = *a2;
    let usdc_mint = *a3;
    let vault = *a4;
    let token_program = *a5;
    let system_program = *a6;

    require_signer(&owner)?;
    require_writable(&owner)?;
    let (governor_address, bump) = find_pda(&[GOVERNOR_SEED, owner.address().as_ref()], program_id)?;
    if governor_address != *governor.address() {
        return Err(e_seeds());
    }
    let (authority_address, vault_authority_bump) = find_pda(&[VAULT_AUTHORITY_SEED, governor.address().as_ref()], program_id)?;
    if authority_address != *vault_authority.address() {
        return Err(e_seeds());
    }
    mint_decimals(&usdc_mint)?;
    require_signer(&vault)?;
    require_token_program(&token_program)?;
    require_system_program(&system_program)?;

    let bump_seed = [bump];
    let seeds = [Seed::from(GOVERNOR_SEED), Seed::from(owner.address().as_ref()), Seed::from(&bump_seed)];
    create_account(&owner, &governor, GOVERNOR_LEN, program_id, &[Signer::from(&seeds)])?;

    // The vault is a fresh keypair the client signed with, owned by a PDA that
    // holds no data and signs only by seeds.
    create_account(&owner, &vault, TOKEN_ACCOUNT_LEN, token_program.address(), &[])?;
    let mut init = [0u8; 33];
    init[0] = 18; // InitializeAccount3
    init[1..33].copy_from_slice(vault_authority.address().as_array());
    let metas = [InstructionAccount::writable(vault.address()), InstructionAccount::readonly(usdc_mint.address())];
    cpi(token_program.address(), &init, &metas, &[vault, usdc_mint], &[])?;

    if epoch_length <= 0 || per_trade_cap == 0 || per_trade_cap > epoch_cap {
        return Err(e_invalid_policy());
    }
    let now = Clock::get()?.unix_timestamp;
    let epoch = epoch_of(now, epoch_length)?;
    let mut image = [0u8; GOVERNOR_LEN];
    image[..8].copy_from_slice(&ACC_GOVERNOR);
    image[G_OWNER..G_OWNER + 32].copy_from_slice(owner.address().as_array());
    image[G_OPERATOR..G_OPERATOR + 32].copy_from_slice(&operator);
    image[G_USDC_MINT..G_USDC_MINT + 32].copy_from_slice(usdc_mint.address().as_array());
    image[G_VAULT..G_VAULT + 32].copy_from_slice(vault.address().as_array());
    image[G_EPOCH_CAP..G_EPOCH_CAP + 8].copy_from_slice(&epoch_cap.to_le_bytes());
    image[G_PER_TRADE_CAP..G_PER_TRADE_CAP + 8].copy_from_slice(&per_trade_cap.to_le_bytes());
    image[G_EPOCH_LENGTH..G_EPOCH_LENGTH + 8].copy_from_slice(&epoch_length.to_le_bytes());
    image[G_CURRENT_EPOCH..G_CURRENT_EPOCH + 8].copy_from_slice(&epoch.to_le_bytes());
    image[G_BUMP] = bump;
    image[G_VAULT_AUTHORITY_BUMP] = vault_authority_bump;
    store(&mut governor, 0, &image)
}

/// Caps are owner-only and can never be reached from the trading path.
#[inline(never)]
fn set_policy(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: SetPolicy");
    let [a0, a1, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let epoch_cap = args.u64()?;
    let per_trade_cap = args.u64()?;
    let owner = *a0;
    let mut governor = *a1;
    owner_governor(&owner, &governor, program_id)?;
    require_writable(&governor)?;
    if per_trade_cap == 0 || per_trade_cap > epoch_cap {
        return Err(e_invalid_policy());
    }
    let mut caps = [0u8; 16];
    caps[..8].copy_from_slice(&epoch_cap.to_le_bytes());
    caps[8..].copy_from_slice(&per_trade_cap.to_le_bytes());
    store(&mut governor, G_EPOCH_CAP, &caps)?;
    let mut event = [0u8; 8 + 32 + 16];
    event[..8].copy_from_slice(&EVT_POLICY_CHANGED);
    event[8..40].copy_from_slice(governor.address().as_array());
    event[40..48].copy_from_slice(&epoch_cap.to_le_bytes());
    event[48..56].copy_from_slice(&per_trade_cap.to_le_bytes());
    emit(&event);
    Ok(())
}

/// The operator may only be replaced by the owner, never rotated in-flight.
#[inline(never)]
fn set_operator(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: SetOperator");
    let [a0, a1, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let operator = args.key()?;
    let owner = *a0;
    let mut governor = *a1;
    owner_governor(&owner, &governor, program_id)?;
    require_writable(&governor)?;
    store(&mut governor, G_OPERATOR, &operator)
}

#[inline(never)]
fn set_suspended(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: SetSuspended");
    let [a0, a1, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let suspended = args.byte()? != 0;
    let owner = *a0;
    let mut governor = *a1;
    owner_governor(&owner, &governor, program_id)?;
    require_writable(&governor)?;
    store(&mut governor, G_SUSPENDED, &[suspended as u8])
}

/// Allow this vault's signature to reach one more venue. Only the owner may add
/// one, so an agent can pick a venue but can never widen the set it picks from.
/// The allowlist is least-authority, not the guarantee: that is the balance
/// check in `execute_trade`, which holds whichever program ran.
#[inline(never)]
fn approve_router(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: ApproveRouter");
    let [a0, a1, a2, a3, a4, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let mut label = [0u8; 16];
    for (to, from) in label.iter_mut().zip(args.take(16)?) {
        *to = *from;
    }
    let owner = *a0;
    let governor = *a1;
    let router_program = *a2;
    let mut approved = *a3;
    let system_program = *a4;
    require_writable(&owner)?;
    owner_governor(&owner, &governor, program_id)?;
    require_system_program(&system_program)?;

    let (address, bump) = find_pda(&[ROUTER_SEED, governor.address().as_ref(), router_program.address().as_ref()], program_id)?;
    if address != *approved.address() {
        return Err(e_seeds());
    }
    let bump_seed = [bump];
    let seeds = [
        Seed::from(ROUTER_SEED),
        Seed::from(governor.address().as_ref()),
        Seed::from(router_program.address().as_ref()),
        Seed::from(&bump_seed),
    ];
    create_account(&owner, &approved, ROUTER_LEN, program_id, &[Signer::from(&seeds)])?;
    // The account and the event are the same bytes behind different tags.
    let mut image = [0u8; ROUTER_LEN];
    image[..8].copy_from_slice(&ACC_ROUTER);
    image[8..40].copy_from_slice(governor.address().as_array());
    image[40..72].copy_from_slice(router_program.address().as_array());
    image[72..88].copy_from_slice(&label);
    image[88] = bump;
    store(&mut approved, 0, &image)?;
    image[..8].copy_from_slice(&EVT_ROUTER_APPROVED);
    emit(&image[..88]);
    Ok(())
}

/// Closing the PDA withdraws the venue and returns its rent. Any trade already
/// signed against it stops being executable.
#[inline(never)]
fn revoke_router(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    log(b"Instruction: RevokeRouter");
    let [a0, a1, a2, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let mut owner = *a0;
    let governor = *a1;
    let mut approved = *a2;
    require_writable(&owner)?;
    owner_governor(&owner, &governor, program_id)?;
    let Approval { subject: program, bump } = read_owned(&approved, program_id, &ACC_ROUTER, read_router)?;
    require_writable(&approved)?;
    if !is_pda(approved.address(), &[ROUTER_SEED, governor.address().as_ref(), &program, &[bump]], program_id) {
        return Err(e_seeds());
    }
    let mut event = [0u8; 8 + 32 + 32];
    event[..8].copy_from_slice(&EVT_ROUTER_REVOKED);
    event[8..40].copy_from_slice(governor.address().as_array());
    event[40..72].copy_from_slice(&program);
    emit(&event);
    close_to(&mut approved, &mut owner)
}

/// Approving a mint creates a PDA. Its existence *is* the allowlist, so the
/// trading path proves approval by deriving an address rather than by scanning
/// a vector that would bound how many instruments can be approved.
#[inline(never)]
fn approve_instrument(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    log(b"Instruction: ApproveInstrument");
    let [a0, a1, a2, a3, a4, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let owner = *a0;
    let governor = *a1;
    let instrument_mint = *a2;
    let mut approved = *a3;
    let system_program = *a4;
    require_writable(&owner)?;
    owner_governor(&owner, &governor, program_id)?;
    mint_decimals(&instrument_mint)?;
    require_system_program(&system_program)?;

    let (address, bump) = find_pda(&[INSTRUMENT_SEED, governor.address().as_ref(), instrument_mint.address().as_ref()], program_id)?;
    if address != *approved.address() {
        return Err(e_seeds());
    }
    let bump_seed = [bump];
    let seeds = [
        Seed::from(INSTRUMENT_SEED),
        Seed::from(governor.address().as_ref()),
        Seed::from(instrument_mint.address().as_ref()),
        Seed::from(&bump_seed),
    ];
    create_account(&owner, &approved, INSTRUMENT_LEN, program_id, &[Signer::from(&seeds)])?;
    let mut image = [0u8; INSTRUMENT_LEN];
    image[..8].copy_from_slice(&ACC_INSTRUMENT);
    image[8..40].copy_from_slice(governor.address().as_array());
    image[40..72].copy_from_slice(instrument_mint.address().as_array());
    image[72] = bump;
    store(&mut approved, 0, &image)?;
    image[..8].copy_from_slice(&EVT_INSTRUMENT_APPROVED);
    emit(&image[..72]);
    Ok(())
}

/// Closing the PDA revokes the instrument and returns its rent.
#[inline(never)]
fn revoke_instrument(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    log(b"Instruction: RevokeInstrument");
    let [a0, a1, a2, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let mut owner = *a0;
    let governor = *a1;
    let mut approved = *a2;
    require_writable(&owner)?;
    owner_governor(&owner, &governor, program_id)?;
    let Approval { subject: mint, bump } = read_owned(&approved, program_id, &ACC_INSTRUMENT, read_instrument)?;
    require_writable(&approved)?;
    if !is_pda(approved.address(), &[INSTRUMENT_SEED, governor.address().as_ref(), &mint, &[bump]], program_id) {
        return Err(e_seeds());
    }
    let mut event = [0u8; 8 + 32 + 32];
    event[..8].copy_from_slice(&EVT_INSTRUMENT_REVOKED);
    event[8..40].copy_from_slice(governor.address().as_array());
    event[40..72].copy_from_slice(&mint);
    emit(&event);
    close_to(&mut approved, &mut owner)
}

#[inline(never)]
fn deposit_usdc(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: DepositUsdc");
    let [a0, a1, a2, a3, a4, a5, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let amount = args.u64()?;
    let depositor = *a0;
    let governor = *a1;
    let vault = *a2;
    let depositor_usdc = *a3;
    let usdc_mint = *a4;
    let token_program = *a5;

    require_signer(&depositor)?;
    let state = load_governor(&governor, program_id)?;
    if !is_pda(governor.address(), &[GOVERNOR_SEED, &state.owner, &[state.bump]], program_id) {
        return Err(e_seeds());
    }
    token_account(&vault)?;
    require_writable(&vault)?;
    if *vault.address().as_array() != state.vault {
        return Err(e_wrong_vault());
    }
    token_account(&depositor_usdc)?;
    require_writable(&depositor_usdc)?;
    let decimals = mint_decimals(&usdc_mint)?;
    if *usdc_mint.address().as_array() != state.usdc_mint {
        return Err(e_wrong_input_mint());
    }
    require_token_program(&token_program)?;
    if amount == 0 {
        return Err(e_invalid_amount());
    }
    transfer_checked(&token_program, &depositor_usdc, &usdc_mint, &vault, &depositor, amount, decimals, &[])
}

/// Only the owner can move money out, and to wherever they choose. Nothing on
/// the trading path reaches this.
#[inline(never)]
fn withdraw_usdc(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: WithdrawUsdc");
    let [a0, a1, a2, a3, a4, a5, a6, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let amount = args.u64()?;
    let owner = *a0;
    let governor = *a1;
    let vault_authority = *a2;
    let vault = *a3;
    let destination = *a4;
    let usdc_mint = *a5;
    let token_program = *a6;

    let state = owner_governor(&owner, &governor, program_id)?;
    let authority_bump = [state.vault_authority_bump];
    if !is_pda(vault_authority.address(), &[VAULT_AUTHORITY_SEED, governor.address().as_ref(), &authority_bump], program_id) {
        return Err(e_seeds());
    }
    token_account(&vault)?;
    require_writable(&vault)?;
    if *vault.address().as_array() != state.vault {
        return Err(e_wrong_vault());
    }
    token_account(&destination)?;
    require_writable(&destination)?;
    let decimals = mint_decimals(&usdc_mint)?;
    if *usdc_mint.address().as_array() != state.usdc_mint {
        return Err(e_wrong_input_mint());
    }
    require_token_program(&token_program)?;
    if amount == 0 {
        return Err(e_invalid_amount());
    }
    let seeds = [Seed::from(VAULT_AUTHORITY_SEED), Seed::from(governor.address().as_ref()), Seed::from(&authority_bump)];
    transfer_checked(&token_program, &vault, &usdc_mint, &destination, &vault_authority, amount, decimals, &[Signer::from(&seeds)])
}

// ---------------------------------------------------------- the trading path

/// Spend from the vault through an approved venue, inside the owner's limits.
///
/// `swap_data` and the remaining accounts are the venue's own instruction. They
/// are passed through unread: this program deliberately does not try to parse a
/// route. It measures both token accounts either side of the call, which is the
/// only check that stays true no matter what the route does.
#[inline(never)]
fn execute_trade(program_id: &Address, accounts: &mut [AccountView], mut args: Args) -> ProgramResult {
    log(b"Instruction: ExecuteTrade");
    let [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, ..] = &*accounts else {
        return Err(e_not_enough());
    };
    let intent_id = args.key()?;
    let decision_hash = args.key()?;
    let decision_record_hash = args.key()?;
    let amount_in = args.u64()?;
    let min_output = args.u64()?;
    let swap_data = args.bytes()?;

    let operator = *a0;
    let payer = *a1;
    let mut governor = *a2;
    let vault_authority = *a3;
    let vault = *a4;
    let instrument_mint = *a5;
    let approved_instrument = *a6;
    let position_authority = *a7;
    let stock_account = *a8;
    let mut intent_record = *a9;
    let router_program = *a10;
    let approved_router = *a11;
    let system_program = *a12;

    // Only the operator may trade, and it can do nothing else.
    require_signer(&operator)?;
    require_signer(&payer)?;
    require_writable(&payer)?;

    let state = load_governor(&governor, program_id)?;
    require_writable(&governor)?;
    if !is_pda(governor.address(), &[GOVERNOR_SEED, &state.owner, &[state.bump]], program_id) {
        return Err(e_seeds());
    }
    if state.operator != *operator.address().as_array() {
        return Err(e_operator_required());
    }

    let authority_bump = [state.vault_authority_bump];
    if !is_pda(vault_authority.address(), &[VAULT_AUTHORITY_SEED, governor.address().as_ref(), &authority_bump], program_id) {
        return Err(e_seeds());
    }
    let vault_before = token_account(&vault)?.amount;
    require_writable(&vault)?;
    if *vault.address().as_array() != state.vault {
        return Err(e_wrong_vault());
    }
    mint_decimals(&instrument_mint)?;

    // Existence proves the owner approved this mint.
    let Approval { subject: approved_mint, bump: instrument_bump } =
        read_owned(&approved_instrument, program_id, &ACC_INSTRUMENT, read_instrument)?;
    if !is_pda(
        approved_instrument.address(),
        &[INSTRUMENT_SEED, governor.address().as_ref(), instrument_mint.address().as_ref(), &[instrument_bump]],
        program_id,
    ) {
        return Err(e_seeds());
    }
    if approved_mint != *instrument_mint.address().as_array() {
        return Err(e_unapproved_instrument());
    }

    // Authority over this instrument's position, derived from the mint. It is
    // deliberately NOT the vault authority and is never promoted to a signer,
    // so the signature lent to the router cannot spend a position — not this
    // one, and not any position held for another instrument.
    let (position_address, _) = find_pda(&[POSITION_SEED, governor.address().as_ref(), instrument_mint.address().as_ref()], program_id)?;
    if position_address != *position_authority.address() {
        return Err(e_seeds());
    }
    let stock = token_account(&stock_account)?;
    require_writable(&stock_account)?;
    if stock.mint != *instrument_mint.address().as_array() {
        return Err(e_wrong_output_mint());
    }
    if stock.owner != *position_authority.address().as_array() {
        return Err(e_wrong_output_owner());
    }
    let stock_before = stock.amount;

    // Initialising this PDA is the replay guard: a second execution of the same
    // intent id fails at account creation, before any CPI.
    let (intent_address, intent_bump) = find_pda(&[INTENT_SEED, governor.address().as_ref(), &intent_id], program_id)?;
    if intent_address != *intent_record.address() {
        return Err(e_seeds());
    }
    require_system_program(&system_program)?;
    {
        let bump_seed = [intent_bump];
        let seeds = [
            Seed::from(INTENT_SEED),
            Seed::from(governor.address().as_ref()),
            Seed::from(&intent_id),
            Seed::from(&bump_seed),
        ];
        create_account(&payer, &intent_record, INTENT_LEN, program_id, &[Signer::from(&seeds)])?;
    }

    // Existence proves the owner approved this venue. Deriving the address is
    // the check, so an operator can choose between every venue the owner
    // allowed and cannot reach one they did not.
    let Approval { subject: approved_program, bump: router_bump } =
        read_owned(&approved_router, program_id, &ACC_ROUTER, read_router)?;
    if !is_pda(
        approved_router.address(),
        &[ROUTER_SEED, governor.address().as_ref(), router_program.address().as_ref(), &[router_bump]],
        program_id,
    ) {
        return Err(e_seeds());
    }
    if approved_program != *router_program.address().as_array() {
        return Err(e_unapproved_program());
    }

    // ---- the owner's limits
    if state.suspended != 0 {
        return Err(e_suspended());
    }
    if amount_in == 0 {
        return Err(e_invalid_amount());
    }
    if min_output == 0 {
        return Err(e_invalid_minimum());
    }
    if amount_in > u64::from_le_bytes(state.per_trade_cap) {
        return Err(e_per_trade_cap());
    }

    // Roll the epoch before the cap check so a trade is always measured against
    // the window it actually lands in.
    let now = Clock::get()?.unix_timestamp;
    let epoch = epoch_of(now, i64::from_le_bytes(state.epoch_length))?;
    let mut spent_in_epoch = u64::from_le_bytes(state.spent_in_epoch);
    if epoch != i64::from_le_bytes(state.current_epoch) {
        spent_in_epoch = 0;
    }
    let spent_after = spent_in_epoch.checked_add(amount_in).ok_or_else(e_overflow)?;
    if spent_after > u64::from_le_bytes(state.epoch_cap) {
        return Err(e_epoch_cap());
    }
    if vault_before < amount_in {
        return Err(e_insufficient_vault());
    }

    // ---- the route, passed through unread
    //
    // The vault authority is promoted to a signer here and nowhere else. It is
    // a PDA, so it cannot have signed the outer transaction, and a router that
    // is handed it unsigned cannot move anything out of the vault. Every other
    // account keeps the flags the outer transaction gave it: this program lends
    // one signature, the one whose seeds it passes below, and a route must not
    // be able to borrow any other.
    {
        let remaining = match accounts.get(13..) {
            Some(rest) if rest.len() <= MAX_ROUTE_ACCOUNTS => rest,
            _ => return Err(e_not_enough()),
        };
        let mut metas = [const { core::mem::MaybeUninit::<InstructionAccount>::uninit() }; MAX_ROUTE_ACCOUNTS];
        for (slot, account) in metas.iter_mut().zip(remaining.iter()) {
            let is_signer = account.is_signer() || account.address() == vault_authority.address();
            slot.write(InstructionAccount::new(account.address(), account.is_writable(), is_signer));
        }
        // SAFETY: exactly the first `remaining.len()` slots were written above,
        // and `remaining.len() <= MAX_ROUTE_ACCOUNTS` was checked.
        let metas = unsafe { core::slice::from_raw_parts(metas.as_ptr() as *const InstructionAccount, remaining.len()) };
        let seeds = [Seed::from(VAULT_AUTHORITY_SEED), Seed::from(governor.address().as_ref()), Seed::from(&authority_bump)];
        cpi(router_program.address(), swap_data, metas, remaining, &[Signer::from(&seeds)])?;
    }

    // Everything above this line was a request. Everything below is what
    // actually happened, read back from the accounts themselves.
    // The route held the vault's signature for the length of the call, and a
    // signature can approve a delegate or hand the vault to a new owner while
    // every balance stays put. Read its authorities back as well as its amount.
    let vault_now = token_account(&vault)?;
    if vault_now.owner != *vault_authority.address().as_array() || vault_now.rebound {
        return Err(e_vault_rebound());
    }
    let vault_after = vault_now.amount;
    let stock_after = token_account(&stock_account)?.amount;

    let spent = vault_before.checked_sub(vault_after).ok_or_else(e_vault_increased)?;
    if spent > amount_in {
        return Err(e_route_overspent());
    }
    // A route that swept shares out of the destination would leave a negative
    // delta here; measuring the net movement makes that a revert rather than a
    // purchase that quietly cost the agent its existing position.
    let received = stock_after.checked_sub(stock_before).ok_or_else(e_stock_decreased)?;
    if received < min_output {
        return Err(e_minimum_not_met());
    }

    // Charge the epoch what the route actually took, not what it was allowed to
    // take: an under-spending route must not consume budget it never used.
    let spent_in_epoch = spent_in_epoch.checked_add(spent).ok_or_else(e_overflow)?;
    let mut window = [0u8; 16];
    window[..8].copy_from_slice(&epoch.to_le_bytes());
    window[8..].copy_from_slice(&spent_in_epoch.to_le_bytes());
    store(&mut governor, G_CURRENT_EPOCH, &window)?;

    let mut record = [0u8; INTENT_LEN];
    record[..8].copy_from_slice(&ACC_INTENT);
    record[8..40].copy_from_slice(governor.address().as_array());
    record[40..72].copy_from_slice(&intent_id);
    record[72..104].copy_from_slice(&decision_hash);
    record[104..136].copy_from_slice(&decision_record_hash);
    record[136..144].copy_from_slice(&amount_in.to_le_bytes());
    record[144..152].copy_from_slice(&spent.to_le_bytes());
    record[152..160].copy_from_slice(&min_output.to_le_bytes());
    record[160..168].copy_from_slice(&received.to_le_bytes());
    record[168..176].copy_from_slice(&epoch.to_le_bytes());
    record[176..184].copy_from_slice(&now.to_le_bytes());
    record[184] = intent_bump;
    store(&mut intent_record, 0, &record)?;

    let mut event = [0u8; 8 + 32 * 6 + 8 * 7];
    event[..8].copy_from_slice(&EVT_TRADE_SETTLED);
    event[8..40].copy_from_slice(governor.address().as_array());
    event[40..72].copy_from_slice(router_program.address().as_array());
    event[72..104].copy_from_slice(&intent_id);
    event[104..136].copy_from_slice(&decision_hash);
    event[136..168].copy_from_slice(&decision_record_hash);
    event[168..200].copy_from_slice(instrument_mint.address().as_array());
    event[200..208].copy_from_slice(&amount_in.to_le_bytes());
    event[208..216].copy_from_slice(&spent.to_le_bytes());
    event[216..224].copy_from_slice(&min_output.to_le_bytes());
    event[224..232].copy_from_slice(&received.to_le_bytes());
    event[232..240].copy_from_slice(&epoch.to_le_bytes());
    event[240..248].copy_from_slice(&spent_in_epoch.to_le_bytes());
    event[248..256].copy_from_slice(&now.to_le_bytes());
    emit(&event);
    Ok(())
}
