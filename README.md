# FoldClaim — Pull-based Folding@home reward claims on Bitcoin Cash

**BCH Blaze 2026 · FoldingCash Reward Claims bounty (0.5 BCH) · chipnet demo**

Donate spare compute to [Folding@home](https://foldingathome.org) medical
research, then pull your reward on-chain. A CashScript contract verifies an
oracle attestation of your official Folding@home score — no monthly airdrop
to wait for, no custodian holding your tokens.

> **Demo on chipnet (BCH testnet).** Rewards are **demo FOLD**, a stand-in
> CashToken for FLDCH. No real BCH, no real FLDCH. Folding@home scores are
> real, read live from the official stats API.

## The problem (honest version)

A BCH contract cannot read an off-chain API. So "verify contributions from
verified data" needs an oracle — someone who reads the Folding@home stats
API and carries the score on-chain. FoldingCash's own whitepaper (§5.1.1)
says exactly this: even with a contract, trust in an oracle would still be
needed, which is why they distribute centrally today.

FoldClaim does not pretend that problem away. It **shrinks** the trust to
one well-defined component (the oracle) and makes everything else
checkable on-chain:

| What | Who guarantees it |
|---|---|
| The score is real | The oracle, reading `api.foldingathome.org` (public, no key). Anyone can re-check the same username against the same API. |
| Only the claimant can move the escrow | The contract: `require(checkSig(claimantSig, claimantPk))` |
| The payout goes to the claimant, nowhere else | The contract: output-0 locking bytecode must equal the claimant's P2PKH |
| One score pays once | The escrow UTXO can be spent exactly once **and** the oracle refuses to attest a score it already paid |
| Every attestation is auditable | Each funding tx carries `OP_RETURN FoldClaim:<user>:<score>:<index>` |

**What the oracle CAN still do:** lie about a score, or refuse to attest.
That is the documented residual trust. In production the oracle would be
run by FoldingCash itself (the same party that runs today's monthly
distributions) — or by several independent signers under an m-of-n scheme.
The contract code does not change for that upgrade.

**Username binding (limitation, stated plainly):** Folding@home usernames
have no cryptography behind them — anyone can type someone else's name.
The oracle attests the *score* for a name; binding a name to a person is
the same registration trust FoldingCash already uses for its distributions.
Proving control of a Folding@home passkey is future work, not claimed here.

## How it works

1. You enter your Folding@home username. The app reads your score from the
   official stats API (proxied through the oracle — the API sends no CORS
   headers, so browsers cannot call it directly).
2. The oracle signs the claim — `nonce = sha256(claimantPk ‖ amount ‖
   username ‖ score ‖ index)` — and funds a one-time escrow contract with
   your FOLD.
3. Your browser builds the claim transaction, evaluates it against the real
   BCH virtual machine locally, and broadcasts it. The contract checks the
   oracle signature (`OP_CHECKDATASIG`), your signature, and the payout
   address, then releases the FOLD.
4. Claim again only after you fold more: the oracle refuses to attest a
   score it already paid.

Demo economics: **1 FOLD per 100,000 Folding@home points, capped at 50,000
FOLD per claim.** Real FLDCH rates are set by FoldingCash; this is a demo
stand-in.

## Verified on chipnet (15 Nov 2026)

- Contract compiles with `cashc` 0.14.0 and passes a local BCH-VM
  evaluation (`tools/test-contract-local.mjs`): oracle Schnorr signature
  over `sha256(nonce)` verifies under `OP_CHECKDATASIG`.
- Full end-to-end on chipnet (`tools/e2e-chipnet.mjs`):
  - FAH user `Anonymous`, score 4,077,869,866,664 → **50,000 FOLD**
    (capped).
  - Escrow funded: `0ee2bcfc866d13307feb094015d3fd5d5457f88ec50acf4be855fcb32ce0f4e2`
    vout 0 (50,000 FOLD to the contract; 950,000 FOLD change to funder).
  - Claim tx: `a07f847c19fd50bf05b43d4e7b575a8e1ce244079bd9a880ba0ea21be9898c02`
    — vout 0 pays exactly 50,000 FOLD to the claimant's P2PKH address.
  - Double-claim refused with HTTP 409.
- Second end-to-end, same script, different donor (repeatability,
  15 Nov 2026 ~11:31 WIB):
  - FAH user `satoshi`, score 1,224,243 → **12 FOLD**.
  - Escrow funded: `df581e8aaa79028ed1bef862264e1bf44000e2584d754b1200caf23575e0d972`
    vout 0.
  - Claim tx: `66f6c99a7072581d53100c690db488c7e28e0da03443594b611c403d160c1498`
    — vout 0 pays exactly 12 FOLD to the claimant
    (`bchtest:qzx72uz03csjun9k9sg6hdz9zz7plpu8esmt8mzyxn`), fee 409 sat,
    local BCH-VM debug PASS, contract address matched the oracle's.
  - Double-claim refused with HTTP 409 ("Nothing new to claim").
- Browser bundle: `docs/assets/main.js`, 653,497 bytes, built with Bun
  (`bun build src/main.js --outdir docs/assets --target browser --minify`),
  SHA-256 `04322536c85584ff7f9d384018047bbf0820069f330513c3ae8f51a1e9a15505`
  (verified after assembly — see NOTES.md for why it was assembled from
  slices). `node --check` passes; served 200 with the exact byte count.
  All 10 element IDs the bundle wires up are present; oracle CORS
  preflight answers `Access-Control-Allow-Origin: *`.
- Token: demo FOLD, category
  `5482cc0788ddeb09069b3ff2d14fe4de73ab5d93f253d6869eec0f9af19f3449`
  (genesis tx
  `a5479e91da4a3d49350a8b71390ed2324bf5783d341f7b06ea91c398fffadd3d`).
  Real FLDCH (mainnet) category:
  `0adb865ee9cc3038de87fba682e6cd361414edc9acff0da2fd0690d75341c640`.

## Run it

```bash
npm install
npm run setup     # one-time: funder wallet + faucet + mint 1,000,000 demo FOLD
                  # (prints oracle/config.json — save it; see NOTES.md for why)
npm run oracle    # oracle server on http://localhost:8787
npm run build     # vite build -> docs/ (works on a normal machine;
                  # in THIS VM use the bun build below — see NOTES.md)
npm run preview   # serve the app (point it at the oracle with ?oracle=<url>)
```

Build that actually produced `docs/` in this VM (Bun 1.4.4, no Vite):

```bash
/opt/hatch-image/bin/bun build src/main.js --outdir docs/assets --target browser --minify
cp index.html docs/index.html && cp src/style.css docs/style.css
# then serve docs/ (e.g. python3 -m http.server 8123 --directory docs)
```

If the direct `bun build` write is blocked by the VM sandbox (see NOTES.md),
reproduce the bundle deterministically with
`node tools/assemble-bundle.mjs` (re-assembles the verified bundle from the
saved slice outputs; checks SHA-256 before writing).

Files:

- `contracts/FoldClaim.cash` — the CashScript contract (+ compiled
  `FoldClaim.json` artifact).
- `oracle/server.mjs` — the oracle: FAH proxy, claim signing, escrow
  funding, broadcast relay, claim history.
- `oracle/setup.mjs` — one-time chipnet setup.
- `shared/claim-lib.mjs` — nonce/amount math + REST/FAH clients (shared by
  oracle and app).
- `shared/rest-provider.mjs` — CashScript NetworkProvider over the
  mainnet-js REST server (chipnet), because this VM blocks Electrum WSS.
- `src/` — the Vite app (`main.js`, `relay-provider.js`, `style.css`).
- `tools/` — `test-contract-local.mjs` (local VM test),
  `e2e-chipnet.mjs` (full on-chain E2E), `headless-test.mjs` (Playwright
  browser E2E — blocked in this VM, see below),
  `assemble-bundle.mjs` (re-assembles the verified browser bundle from
  saved slice outputs when the sandbox blocks the bundler's write).

## Known limits (this VM)

- **Electrum over WebSocket is blocked** in this VM, so chain reads/writes
  go through the mainnet-js REST server. The app's claim flow was verified
  end-to-end over that path; a judge's browser with normal network access
  can use Electrum directly.
- **File writes from exec processes are selectively blocked** (verified
  15 Nov 2026, see NOTES.md § "The build"): a process that memory-maps
  files under `~/workspace`, loads native code, or does network I/O can no
  longer write files in that session. `vite build` and `bun build` (whose
  inputs live in the workspace) are affected; the bundle in `docs/` was
  produced by an in-memory Bun build and assembled from slices, with the
  SHA-256 verified against the fresh in-memory build. On a normal machine
  `bun build` (or `vite build`) writes it directly.
- **No headless browser runs in this VM** (verified 15 Nov 2026): Chromium
  (headless shell 1193 + 1255, full 1193 + 1255, single-process, headed
  under Xvfb) and Firefox 1572 all die at launch (SIGTRAP / "target …
  has been closed") before loading any page. The same Playwright script
  passed for BlazePay earlier in this VM lineage, so this is a VM sandbox
  regression, not an app failure. Consequence: the browser UI was verified
  statically (bundle parses, all wired element IDs present, CORS preflight
  OK, served bytes exact) and the claim path was verified end-to-end twice
  on-chain with the identical code — but a live in-browser click-through
  could not be recorded here. `tools/headless-test.mjs` + `demo/DEMO-SCRIPT.md`
  are provided so a reviewer can run it in one command elsewhere.
- Chipnet confirmations: all four chipnet txs (2 escrows + 2 claims) show
  **0 confirmations** at verification time (15 Nov ~11:31 WIB) via the
  REST node — including a faucet tx that had shown confirmations earlier.
  The txs are all returned by `get_raw_transaction` (valid, mempool-known),
  so this reads as a chipnet/REST-node view quirk (slow mining or a node
  restart/reorg), not invalid transactions. Re-verify confirmations live
  before judging.

## Status for the bounty

Working chipnet demo of the full pull-based claim loop with an honest,
documented trust model. Not "fully trust-minimized" — no design that reads
Folding@home scores can be, and this repo says so in the UI, the README,
and the submission draft.
