# BCH Blaze 2026 — Submission Draft: FoldClaim (FoldingCash Reward Claims)

> **DRAFT — do not submit as-is.** Status as of 15 Nov 2026, 11:31 WIB.
> Submit deadline: 22 Nov 2026 21:00 WIB. This draft states the real status,
> including the one thing that could not be verified in the build VM.

## Project

**FoldClaim** — pull-based reward claims for FoldingCash on Bitcoin Cash.
Donate compute to Folding@home, then pull your reward on-chain whenever you
want. A CashScript contract verifies an oracle attestation of your official
Folding@home score and releases CashTokens (demo FOLD, a stand-in for
FLDCH) to your address. No monthly airdrop to wait for, no custodian
holding your tokens.

- **Bounty:** FoldingCash Reward Claims (0.5 BCH)
- **Repo:** `folding-claims` (Vite static app + CashScript contract +
  Node oracle server; `docs/` is the built app, GitHub Pages source)
- **Network:** chipnet (BCH testnet) only. No mainnet BCH, no real money.

## What it does (verified)

1. **Lookup** — enter a Folding@home username; the app reads the score live
   from the official stats API (`api.foldingathome.org`, public, no key,
   proxied through the oracle because the API sends no CORS headers).
2. **Claim** — the oracle signs the claim
   (`nonce = sha256(claimantPk ‖ amount ‖ username ‖ score ‖ index)`) and
   funds a one-time escrow contract with the reward: **1 FOLD per 100,000
   points, capped at 50,000 FOLD per claim**.
3. **Submit** — the browser builds the claim transaction, evaluates it
   against the real BCH virtual machine locally, and broadcasts it. The
   contract checks the oracle signature (`OP_CHECKDATASIG`), the claimant
   signature, and pins the payout to the claimant's P2PKH address.
4. **No double-claims** — the escrow UTXO spends exactly once, and the
   oracle refuses to attest a score it already paid (HTTP 409).
5. **History** — past claims listed in the app (local + oracle registry),
   with on-chain verification per claim.

## Verification evidence (chipnet, 15 Nov 2026)

- **Contract:** `contracts/FoldClaim.cash` compiles with `cashc` 0.14.0;
  local BCH-VM evaluation passes (`tools/test-contract-local.mjs`).
- **E2E #1 — Anonymous**, score 4,077,869,866,664 → 50,000 FOLD (capped).
  Escrow `0ee2bcfc866d13307feb094015d3fd5d5457f88ec50acf4be855fcb32ce0f4e2`
  vout 0. Claim `a07f847c19fd50bf05b43d4e7b575a8e1ce244079bd9a880ba0ea21be9898c02`
  vout 0 = exactly 50,000 FOLD to the claimant. Fee 411 sat.
- **E2E #2 — satoshi**, score 1,224,243 → 12 FOLD (repeatability).
  Escrow `df581e8aaa79028ed1bef862264e1bf44000e2584d754b1200caf23575e0d972`
  vout 0. Claim `66f6c99a7072581d53100c690db488c7e28e0da03443594b611c403d160c1498`
  vout 0 = exactly 12 FOLD to the claimant. Fee 409 sat.
- **Double-claim refused** (HTTP 409) in both runs.
- **Demo token:** FOLD category
  `5482cc0788ddeb09069b3ff2d14fe4de73ab5d93f253d6869eec0f9af19f3449`
  (genesis `a5479e91da4a3d49350a8b71390ed2324bf5783d341f7b06ea91c398fffadd3d`).
  Real FLDCH mainnet category:
  `0adb865ee9cc3038de87fba682e6cd361414edc9acff0da2fd0690d75341c640`.
- **Browser bundle:** `docs/assets/main.js`, 653,497 bytes, SHA-256
  `04322536c85584ff7f9d384018047bbf0820069f330513c3ae8f51a1e9a15505`,
  `node --check` passes; served with the exact byte count; all wired
  element IDs present; oracle CORS preflight OK.

## The honest trust model (stated in the UI, README, and here)

A BCH contract cannot read an off-chain API, so "verify contributions from
verified data" needs an oracle — exactly what FoldingCash's whitepaper
(§5.1.1) says. FoldClaim does **not** claim full trust-minimization. It
shrinks trust to one well-defined component:

| Guarantee | Who provides it |
|---|---|
| The score is real | The oracle, reading the public FAH API (anyone can re-check) |
| Only the claimant can move the escrow | The contract (`checkSig`) |
| Payout goes to the claimant, nowhere else | The contract (output-0 P2PKH covenant) |
| One score pays once | Escrow UTXO (spends once) + oracle refusal (409) |
| Every attestation is auditable | `OP_RETURN FoldClaim:<user>:<score>:<index>` on each funding tx |

**Residual trust:** the oracle can lie about a score or refuse to attest.
In production it would be run by FoldingCash itself (the party that runs
today's monthly distributions) — or by several independent signers under
an m-of-n scheme; the contract does not change for that upgrade.
**Username binding:** FAH usernames have no cryptography; binding a name
to a person is the same registration trust FoldingCash already uses.

## What could NOT be verified in the build VM (stated plainly)

- **No live in-browser click-through.** All browsers in the build VM
  (Chromium headless shell 1193/1255, full Chromium 1193/1255,
  single-process, headed under Xvfb, Firefox 1572) die at launch
  (SIGTRAP) before loading any page — a VM sandbox regression (the same
  Playwright script passed for our other entry earlier in this VM lineage).
  The UI was verified statically (bundle parses, wiring present, CORS OK)
  and the claim path twice on-chain with the identical code, but no video
  or screenshots could be recorded here. `tools/headless-test.mjs` +
  `demo/DEMO-SCRIPT.md` reproduce the full browser flow in one command on
  a normal machine.
- **0 confirmations at check time.** All four chipnet txs show 0
  confirmations via the REST node at 15 Nov ~11:31 WIB (including faucet
  txs that had confirmed earlier). They are valid and mempool-known
  (`get_raw_transaction` returns them); this reads as slow chipnet mining
  / a REST-node view quirk. Re-verify confirmations live.
- **Build quirk:** `vite build` / `bun build` cannot write their output in
  this VM (sandbox blocks writes from processes that memory-map workspace
  files). The checked-in bundle was produced by an in-memory Bun build and
  assembled from slices with SHA-256 verification (see NOTES.md). On a
  normal machine `bun build` (or `vite build`) writes it directly.

## How to run the demo

```bash
npm install
npm run setup     # one-time: funder wallet + faucet + mint demo FOLD
npm run oracle    # oracle on http://localhost:8787
npm run build     # or: bun build src/main.js --outdir docs/assets --target browser --minify
npm run preview   # serve docs/; open it, look up a Folding@home username, claim
```

Try donors `Anonymous` (already claimed 50,000 in the demo), `satoshi`
(already claimed 12), or any real Folding@home username — e.g. `folding`
(score 86,756,097 → 867 FOLD) or `BCH` (score 248,329 → 2 FOLD).

## Links

- Folding@home stats API: `https://api.foldingathome.org/user/{username}`
- FoldingCash: https://folding.cash (whitepaper §5.1.1 — the oracle problem)
- CashScript: https://cashscript.org (0.14.0, `checkDataSig` + covenants)
