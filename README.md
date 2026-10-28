# LastKey

A dead-man's-switch inheritance vault for your crypto. Prove of life is your own wallet activity: check in before your timer runs out and nothing happens. Miss it, and your beneficiaries can claim their shares with a passphrase only they hold.

## Live demo

A local demo chain (chain id 31338) runs the full flow: deploy, register, check in, edit the vault live, and claim. The frontend is phone-first and connects through the Reown WalletConnect modal (SubWallet, MetaMask, or any WalletConnect wallet).

## How it works

- Register a vault with a check-in interval (1-3650 days) and grace window, encrypted instructions, and beneficiaries with percentage shares.
- Prove of life by checking in, or just by transacting: wallet activity counts as a heartbeat, not only the button.
- Miss the deadline and the grace window, and claims open. Each beneficiary connects their wallet, and their non-transferable (soulbound) claim ticket is detected automatically.
- Claims require the passphrase the owner shared. It never lives on-chain in plaintext.

## Two claim modes

- Specific assets: the beneficiary sweeps only ERC-20 tokens the owner explicitly listed, within caps.
- Everything: the owner records a blanket-approval attestation on-chain and approves the vault for their tokens; a keeper sweeps everything approved and held, including tokens never listed.

The owner can switch modes while alive; the mode locks at claim time.

## Edit, don't restart

`updateVault` edits a live vault in place, same epoch: interval, grace, beneficiaries, shares, passphrase and instructions. The clock does not reset. Shorten 30 days to 7 and the time already elapsed still counts.

## Cross-chain and automation (interfaces live, v4 roadmap)

- Cross-chain claims: a mirrored claim receiver pays a beneficiary's share on a second EVM chain once a quorum of watcher signatures arrives.
- LastKey-Notify: vaults emit structured events (check-ins, timer warnings at 80%, claim opened) for signed HTTP webhooks.
- Keeper: an open-source script that can claim for a beneficiary once the window opens, using their own key and passphrase. Keepers never hold the passphrase unless given it.
- Full-wallet takeover via an ERC-4337 smart account is v4 roadmap.

## Development

```
npm install
npx hardhat test          # 258 tests
npm run demo              # local chain + keeper + frontend on 127.0.0.1
```

## Structure

- `contracts/LastKey.sol` — the vault, tickets and sweep system
- `contracts/CrossChainClaimReceiver.sol` — cross-chain claim interface
- `frontend/` — phone-first dapp (no build step)
- `keeper/` — claim/sweep automation service
- `notify/` — webhook event service
- `test/` — hardhat tests

Built for the Portaldot Hacker House 2026.
