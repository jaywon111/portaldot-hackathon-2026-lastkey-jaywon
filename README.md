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

## Shamir passphrase split (v3.1)

Passphrase recovery without trusting a central party:

- The owner can split the secret into encrypted Shamir shards at registration (setShardSplit).
- A k-of-n threshold (e.g. 2 of 3 heirs) is set on-chain.
- Each beneficiary can read ONLY their own shard off-chain via shardOf(owner).
- If the owner dies without ever telling the heirs the passphrase, k beneficiaries combine their shards to reconstruct it and claim.
- No single beneficiary can steal early; no heir is locked out if the owner dies suddenly.

## Threat model and honest assumptions

1. Liveness oracle vs stolen phone: LastKey uses wallet transactions and an active check-in button as proof of life. If an attacker gains full access to the owner phone or signer pre-death, they can keep checking in. We do not use third-party death certificates or centralized oracles because they reintroduce custody and KYC; LastKey trades edge-case phone theft for sovereign, oracle-free execution.
2. Blocked vs burned tickets on vault edits: when an owner edits their vault (updateVault), removed beneficiaries have their on-chain claim rights revoked immediately. Their soulbound NFT tickets remain in their wallet as an immutable receipt of a past epoch, but the contract reverts any claim attempt (NotBeneficiary).
3. Cross-chain watcher trust: the cross-chain claim receiver relies on a quorum of watcher signatures. In production, watcher operators must be geographically and organizationally distinct to prevent collusion. The watcher interface is bridge-agnostic so LayerZero, CCIP or Axelar can swap in.

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
