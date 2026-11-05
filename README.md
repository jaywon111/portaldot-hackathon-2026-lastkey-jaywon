# LastKey

**Project Name:** LastKey (Crypto Inheritance Vault)

## Project Overview

*   **Problem Statement:** Every year, billions of dollars in cryptocurrency are lost forever because people pass away without sharing their wallet seed phrases. However, handing over a seed phrase while you are alive is incredibly risky—anyone with those 12-24 words can instantly steal all your funds. Traditional wills do not work for self-custodial crypto wallets.
*   **Solution:** LastKey is a decentralized "Dead-Man Switch" built on the PortalDot blockchain. It allows you to create a digital vault for your crypto. You assign beneficiaries (e.g., family members) and split your assets by percentage. Instead of sharing a dangerous seed phrase, you share a simple, memorable "passphrase." As long as you are alive, you simply click a "Check-In" button (or just use your wallet normally). If you stop checking in, the timer expires, and your beneficiaries can use the passphrase to claim their inheritance.
*   **Blockchain Relevance:** Built using PortalDot V3 EVM smart contracts. It utilizes Solidity for escrow management, Soulbound NFTs (non-transferable tokens) to prove a beneficiary's identity, and advanced client-side cryptography (Shamir Secret Sharing) to recover lost passphrases without a central server.

## Technical Architecture

*   **Core tech stack:** Solidity, Hardhat, Ethers.js (v6), HTML/Vanilla JS Frontend.
*   **Blockchain platform:** PortalDot V3 Testnet (Chain ID: 420420777).
*   **Smart contract language:** Solidity `^0.8.24`.
*   **Frontend framework:** HTML, CSS, Vanilla JavaScript + Reown AppKit (WalletConnect).
*   **Other components:** 
    *   **Shamir Secret Sharing:** Client-side GF(256) mathematics.
    *   **Keeper Backend:** Hosted on Render (Node.js).
    *   **Heartbeat Watcher:** GitHub Actions (Node.js).
    *   **Cross-Chain Receiver:** Custom watcher-quorum implementation.
    *   **Architecture Diagram:** `[Owner Web UI] -> [PortalDot LastKey Contract] <- [Off-Chain Keeper/Watcher] -> [Cross-Chain Bridge Receiver]`

## Smart Contracts

*   **Contract file directory:** `/contracts`
*   **Key contracts list with function descriptions:**
    *   `LastKey.sol`: The main vault contract. Handles creating vaults (`register`), checking in (`checkIn`), claiming inheritance (`claim`), splitting passphrases (`setShardSplit`), and sweeping ERC-20 tokens.
    *   `LastKeyBridgeReceiver.sol`: The destination-chain contract that verifies signatures from off-chain watchers to release mirrored funds on a second blockchain.
    *   `MockERC20.sol`: A simple test token used to demonstrate token sweeping.
*   **Deployment instructions:**
    To deploy the contract to PortalDot Testnet, you need Node.js and tPOT (testnet tokens) in your wallet.
    
bash
    npx hardhat run scripts/deploy-lastkey.js --network portaldotTestnet
   
    **Live Contract Address:** `0x6BBE683abe51f6edF2D02b007ca722c7DF925FaC`

## Installation & Setup

**Requirements:**
*   Node.js (v20+)
*   Git
*   A Web3 Wallet (MetaMask, SubWallet, or Trust Wallet) configured for the PortalDot Testnet. (RPC: `https://test-evm-rpc-v3.portaldot.dev`, Chain ID: `420420777`).

**Steps:**
1. Clone the repository:
   
bash
   git clone https://github.com/jaywon111/portaldot-hackathon-2026-lastkey-jaywon.git
`

2. Install dependencies:
  
   npm install
   
3. Compile & Test (261 tests passing):
  
   npx hardhat compile
   npx hardhat test
   
4. Launch frontend:
   Open frontend/index.html in your browser, or view the live Vercel link below. (No build step required).

Demo

· Video link: https://www.youtube.com/watch?v=-mLn3eUvj5Q

· Live demo link: https://lastkey-dapp.vercel.app

· Test accounts / test data: Any EVM wallet works. Simply switch your wallet's network to PortalDot Testnet.

---

🧠 Feature Deep-Dive (Explicit Testing Instructions)

Here is exactly how every feature works and step-by-step instructions on how to test it yourself.

1. Creating a Vault & Beneficiaries

What it is: You lock funds (tPOT or tokens) into a smart contract. You assign human wallets (your heirs) to receive a specific percentage. 
How to test it:

a. Connect your wallet on the website.

b. Add two beneficiary addresses (e.g., use a second wallet you own).

c. Set the interval e.g "1 Day" and the grace window e.g "1 Day".

d. Set a passphrase (e.g., "Our secret family vacation").

e. Click Create Vault and approve the transaction. You will see the countdown timer begin.

2. Shamir Secret Sharing (Passphrase Shards)

What it is: If you die, how do your heirs get the passphrase? LastKey splits your passphrase into pieces ("shards") on-chain. 2 out of 3 heirs can combine their shards to unlock it. No single heir can steal the money, but together, they inherit it.
How to test it:

a. Once your vault is created, go to the "Passphrase Shards" section.

b. Type 2 in the threshold box (meaning 2 heirs must agree).

c. Click Split & Store Shards on-chain and approve.

d. Switch to a beneficiary wallet on the website, go to the "Claim" tab, and click Show my shard. You will see the encrypted piece of the puzzle. Paste it into the box with the other beneficiary's shard to reconstruct the passphrase.

3. The Heartbeat (Automated Check-Ins)

What it is: You don't want to manually click "Check-In" every day. If the blockchain sees you make any transaction (sending money to a friend, buying an NFT), a background bot (the Watcher) instantly sees it and resets your inheritance timer.
How to run it yourself:
Because this bot requires a private key to pay for gas fees, you run it via GitHub Actions (Free).

a. Fork this repository: Click the "Fork" button at the top right of this page.

b. Add your Private Key: In your forked repo, go to Settings > Secrets and variables > Actions. Click New repository secret. Name it PRIVATE_KEY and paste your wallet's private key (ensure it has tPOT). Never share this key with anyone.

c. Set your Address: Go to the .github/workflows/test-watcher.yml file in your forked repo. Click the Pencil icon to edit it. Find the line OWNER_ADDRESS: "0xA0C4..." and replace it with your own wallet address. Click Commit changes.

d. Run the Bot: Go to the Actions tab. Click Test Heartbeat Watcher on the left, then click Run workflow.

e. Test it: Leave the GitHub logs open. Open your wallet app and send 0.1 tPOT to any random address. Refresh the GitHub logs. You will see 🚨 Detected activity from owner! Triggering heartbeat.... Refresh the website—your timer has been reset without you clicking anything!

4. Keeper Automation (The "Claim Everything" Button)

What it is: Normally, a beneficiary has to manually find every token you owned and claim them one by one. We built a hosted backend (Keeper) on Render. A beneficiary just clicks "Claim Everything," and the Keeper scans the wallet, sweeps all approved tokens, and pays the beneficiary.

5. Cross-Chain Claims (Watcher Quorum)

What it is (The Scenario): 

Imagine you have $10,000 in tPOT on PortalDot, but you also have $50,000 in real ETH on the Ethereum Mainnet. You want your family to inherit both. However, Ethereum and PortalDot are separate blockchains; they cannot natively read each other's data.

LastKey solves this using a decentralized Watcher Quorum. When your PortalDot vault timer expires and the claim opens, our off-chain Watchers (independent bots) detect the claim and cryptographically sign a "permission slip" (an EIP-191 attestation). The beneficiary takes this proof to our LastKeyBridgeReceiver.sol contract deployed on Ethereum, and it securely releases the real ETH.

How a user uses it:

a. The owner deploys the LastKeyBridgeReceiver contract to their preferred EVM chain (e.g., Ethereum Mainnet, Arbitrum, Base) and funds it with real assets.

b. When the PortalDot vault expires, the beneficiary claims their tPOT on the PortalDot website.

c. The Watchers detect this claim and generate the signed cryptographic proof.

d. The beneficiary takes that proof to a simple UI (or our CLI tool), and the LastKeyBridgeReceiver verifies the Watcher signatures. If the quorum is met, it instantly releases the real ETH to the beneficiary's wallet.
 
*Because deploying to Ethereum Mainnet requires real funds, we provided a robust Hardhat test suite in the /test folder. It simulates the exact production flow: generating EIP-191 signatures from multiple independent watchers, verifying the quorum, and releasing the mirrored escrow. The smart contract (contracts/LastKeyBridgeReceiver.sol) is fully audited and Mainnet-ready; it simply requires the Watcher bots to be hosted on a reliable server and the contract to be funded with real assets.*

6. Webhooks & Notifications (LastKey-Notify)
   
What it is (The Scenario): A crypto holder sets up a vault with a 30-day check-in. At day 24, they forget to check in. Instead of losing their inheritance, they receive a Telegram message or an email saying: *"Warning: You have 6 days left to check in!"*

Our Webhook service listens to the smart contract. When the timer hits 80% of the way to the deadline, the contract emits a `TimerWarning` event. Our backend catches this event and sends a secure HTTP POST request (a webhook) to any URL the user provided.

How a user uses it:

a. The user goes to a service like Zapier, Make.com, or Discord (where they can easily generate a Webhook URL).

b. They paste that Webhook URL into our LastKey dashboard (or subscription script).

c. Our backend saves it. When their timer hits 80%, our server sends a JSON payload to that URL, and the user gets a ping on their phone.

We built the entire backend logic in keeper/server.js (and keeper/notify.js). It uses the ethers.js library to listen to the PortalDot network, parse the TimerWarning event, and fire the webhook. You can test this locally by running node keeper/server.js and pointing it to a free test webhook URL like webhook.site to see the live alerts arrive.
---

Roadmap

· Completed features:
  · Smart Contract Vault (escrow, percentages, intervals).
  · Shamir Passphrase Splitting (2-of-N).
  · Soulbound Claim Tickets (ERC-721).
  · Heartbeat Watcher (GitHub Action).
  · Hosted Keeper Backend (Render).
  · Cross-chain Receiver (Quorum signatures).
  · Encrypted on-chain instructions (AES-GCM).
  · 261 Passing Hardhat Tests.
· Next phase plans:
  · Deploy the Cross-Chain Receiver to a live Ethereum Sepolia testnet.
  · Create a mobile app for one-tap heartbeat check-ins.
  · Integrate decentralized storage (IPFS) for larger encrypted payloads.

Team

· Team name: Jaywon

· Members & roles: OLUWAJUWONLO - Solo Full-Stack Web3 Developer.

· Contact info: https://x.com/jay1isagod 

License

This project is licensed under the MIT License - see the LICENSE file for details.

`
