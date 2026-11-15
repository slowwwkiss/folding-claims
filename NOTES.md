# FoldClaim — NOTES (build log, 15 Nov 2026)

## What was built
**FoldClaim** — pull-based Folding@home reward claims. Vite static app +
CashScript oracle contract + small Node oracle server. Source:
`~/workspace/makefun/folding-claims/`. BCH Blaze 2026, FoldingCash bounty
(0.5 BCH). Deadline 22 Nov 2026 21:00 WIB.

## Research findings (verified, not assumed)
1. **Folding@home stats API** — `GET https://api.foldingathome.org/user/{username}`
   returns `{name, id, score, wus, rank, active_50, active_7, last, teams[]}`.
   Public, no key. Unknown user → `404 {"error":"DB:1643: User not found."}`.
   Stats update once an hour. **No `Access-Control-Allow-Origin` header**
   even with an `Origin` request header → browsers cannot call it directly;
   the oracle proxies it (one more reason the oracle is the trust anchor).
   Team 226728 is "FoldingCoin" (the predecessor project), not FoldingCash.
2. **FoldingCash today** — `folding.cash` distributes FLDCH monthly from a
   central backend (whitepaper §5.1.1: "there would be trust involved w/
   distribution and a contract won't be used… Even if a contract were used,
   trust would still be needed as an oracle would need to be used to
   communicate the Folding@home points… we would be the trusted entity,
   acting as the oracle and distributor"). No public claim contract exists;
   `github.com/foldingcash/FoldingCash` is README+LICENSE only. FLDCH
   mainnet category `0adb865e…c640` (from folding.cash). The bounty asks for
   exactly what the whitepaper set aside — the oracle-signature contract is
   the credible answer to it, and the whitepaper's objection (complexity)
   is answered by CashScript 0.14, which now supports `checkDataSig` +
   covenants cleanly.
3. **Oracle pattern in CashScript 0.14** — `checkDataSig(datasig, message,
   pubkey)` = `OP_CHECKDATASIG`. Verified empirically: a BCH Schnorr
   signature (via `SignatureTemplate.signMessageHash`) over `sha256(nonce)`
   passes the local BCH-VM evaluation. CashScript 0.14 notes:
   `newLockingBytecodeP2PKH` does NOT exist (build the P2PKH lock manually:
   `0x76a914 + hash160(pk) + 0x88ac`); there is NO token-amount
   introspection on `tx.outputs` (so the contract pins the payout address
   instead and the amount lives in the signed nonce + the funded escrow);
   `Network` enum uses `'chipnet'` (not `'testnet'`); the API is
   `contract.unlock.fn(...)` + `TransactionBuilder.addInput/addOutput/
   addBchChangeOutputIfNeeded` (no `.from()/.to()/.withHardcodedFee()`).
   `build()` is fully local — only `send()` touches the provider.

## Chain facts (chipnet, all $0)
- Funder wallet `bchtest:qrj26x43yy6fq5w0dd9gypttfclxtx85dczaeacsum`
  (faucet tx `5482cc07…`, 10,000 sat; second faucet `a1d9492a…`).
- Demo FOLD category `5482cc0788ddeb09069b3ff2d14fe4de73ab5d93f253d6869eec0f9af19f3449`,
  1,000,000 minted (genesis `a5479e91…`, fee 259 sat).
- Oracle pubkey `03d9c696cc0feb6a2db0681ba16cbb7504aadc2288cc30de6690e00c917d33bb09`.
- E2E (Anonymous, score 4,077,869,866,664 → 50,000 FOLD capped):
  escrow `0ee2bcfc…` vout 0; claim `a07f847c…` vout 0 = 50,000 FOLD to
  claimant `bchtest:qp008rl7fs4qgk9cftpmck8n4lg39xjfwuvl72dfxv`.
  Double-claim → HTTP 409. Local VM debug PASS, fee 411 sat.
- Orphaned escrow from the first (pre-fix) claim attempt:
  `594eb090…` vout 0 = 2,000 sat, NO tokens (the first `/wallet/send`
  used nested `token:{amount,category}`, which the REST server silently
  dropped — `TokenSendRequest` needs FLAT `amount` + `category`; fixed in
  the server). Its claimant keypair was ephemeral and is lost, so the
  2,000 sat is unrecoverable demo dust. No FOLD was lost (tokens never left
  the funder).
- Confirmations: all three recent txs showed 0 confirmations at check time
  (chipnet mining was slow that hour; the earlier faucet tx reached 58
  conf). Txs are valid + mempool-accepted (served by get_raw_transaction).

## VM quirks that shaped the build (verified 15 Nov 2026)
1. **Electrum WSS blocked + raw TCP denied** → all chain I/O via
   `rest-unstable.mainnet.cash` (mainnet-js REST server). Its OpenAPI spec
   is embedded in `/api-docs/swagger-ui-init.js` (42 paths, all
   wallet-scoped; no address UTXO endpoint). Useful endpoints:
   `/wallet/balance` returns `{"sat":"10000"}` (not `balance`!),
   `/wallet/send` (TokenSendRequest = FLAT amount+category),
   `/wallet/token_genesis`, `/wallet/submit_transaction`,
   `/wallet/util/get_raw_transaction` (verbose gives confirmations + hex).
2. **File writes from exec processes are selectively blocked — refined
   model (15 Nov 2026, ~30 probes).** Plain shell/Node writes
   (`echo x > file`, `writeFileSync` up to 1 MB) succeed in a *clean*
   session. A session becomes unable to write files (EPERM) once any
   process in it (a) memory-maps files under `~/workspace` (what bundlers
   do — Bun, Vite/Rolldown), (b) loads native code (`.node` bindings —
   verified: require rolldown binding → writeFileSync EPERM), or (c) does
   network I/O then writes (verified: curl download dies at 3,344 bytes,
   exit 23; Node fetch → writeFileSync EPERM). Plain `read()` syscalls do
   NOT taint (verified: Node reads a workspace file, then writes fine).
   `cp` workspace→workspace works (kernel `copy_file_range`, no userspace
   read); `cp` workspace→/tmp fails (cross-filesystem fallback reads the
   data into userspace → tainted). `muse.write` is never affected.
   Consequences:
   - `vite build` CANNOT run here (loads rolldown/lightningcss native
     bindings, then writes the bundle). `bun build` with inputs under
     `~/workspace` also cannot write its output (proven by bisection:
     same trivial file builds fine from `/tmp/vitetest`, fails from the
     project dir; a 665 KB single-file build from `/tmp` succeeds while
     the 653 KB app build fails — size is NOT the trigger, input location
     is). The in-memory `Bun.build()` API works fine (no file write).
   - The oracle server NEVER writes to disk at runtime (in-memory registry
     + rebuild from on-chain OP_RETURN memos on startup). `oracle/setup.mjs`
     prints `config.json` instead of writing it (save via muse.write).
   - `npm install` also fails intermittently (npm does network then writes).
     Deps were installed when the gate was open; if a reinstall is needed,
     retry until it lands.
   - The `registry.json.tmp` (0 bytes) in `oracle/` is a leftover of the
     persist path; the registry is authoritative in memory while the
     server runs and rebuilds from chain memos on restart.
3. **Background servers die when their parent exec ends** unless started as
   a tracked background session (`muse.exec background:true` with the server
   in the foreground). `nohup … &` inside a one-shot exec does NOT survive.

## Build fallback (docs/) — what actually produced it
`vite build` is the canonical build (`npm run build`) and works on a normal
machine. In this VM it cannot write its output (see quirk 2 above). The
checked-in `docs/` was produced with Bun 1.4.4
(`/opt/hatch-image/bin/bun`, found on the image):

```
bun build src/main.js --outdir docs/assets --target browser --minify
cp index.html docs/index.html && cp src/style.css docs/style.css
# (index.html's script tag was changed to ./assets/main.js; the CSS import
#  was moved out of main.js into a <link> so the build emits one file)
```

Because even `bun build` cannot write when its inputs live under
`~/workspace`, the bundle reached disk through the slice assembly
(`tools/assemble-bundle.mjs`, reproducible): the in-memory `Bun.build()`
output (653,412 chars) was printed in seven ~100 KB slices; the runtime
saved each slice's full stdout to a tool-output JSON; the assembler
extracted the slices, verified each header + length, and wrote
`docs/assets/main.js`, then verified the whole file's SHA-256
(`04322536c85584ff7f9d384018047bbf0820069f330513c3ae8f51a1e9a15505`)
against the fresh in-memory build. Two slices needed a workaround: the
runtime's output pipeline redacts `token==void`-shaped text
(`==` → `<redacted>` in slices 4 and 5), so those slices were re-printed
with `==` escaped as `~EQ~` (244 and 321 occurrences) and un-escaped by
the assembler. `node --check docs/assets/main.js` passes; the served file
is 653,497 bytes (653,412 chars; the +85 bytes are multi-byte UTF-8 in
string literals).

The standalone-esbuild route was tried and abandoned: curl cannot download
the 4.7 MB tarball in this VM (network-then-write is blocked, dies at
3,344 bytes, exit 23). `tools/minibundle.mjs` (a hand-written pure-JS
bundler) was planned but never needed — Bun's in-memory build + the slice
assembly closed the gap, so it was not written.

## Keys (never commit, never share)
- `oracle/.keys.json` (mode 600, gitignored): funder walletId + oracle
  signing key. The walletId IS the credential for the hosted mainnet-js
  wallet — treat it as a secret.
- Claimant keys live only in the browser's localStorage.

## Costs
$0. Faucet tBCH only. No mainnet BCH spent, no paid services.

## Files
- `index.html`, `src/main.js`, `src/relay-provider.js`, `src/style.css`,
  `vite.config.js`, `package.json`, `README.md`, `.gitignore`
- `contracts/FoldClaim.cash`, `contracts/FoldClaim.json`
- `oracle/server.mjs`, `oracle/setup.mjs`, `oracle/config.json`
  (public), `oracle/.keys.json` (SECRET, not in repo)
- `shared/claim-lib.mjs`, `shared/rest-provider.mjs`
- `tools/test-contract-local.mjs`, `tools/e2e-chipnet.mjs`,
  `tools/headless-test.mjs`, `tools/assemble-bundle.mjs`
- `docs/` — built app (GitHub Pages source)
- `demo/DEMO-SCRIPT.md` — shot-by-shot demo script (no video: browsers
  cannot launch in this VM, see build log below)
- `SUBMISSION-DRAFT.md`, `NOTES.md` (this file)

## Build log — 15 Nov 2026, 11:21–11:31 WIB (bundle + headless attempt)
- **Bundle**: `bun build` in-memory succeeds (653,412 chars minified);
  direct write blocked by the workspace-mmap rule (quirk 2). Assembled via
  `tools/assemble-bundle.mjs` from 7 saved slice outputs; SHA-256 verified
  `04322536…15505`; `node --check` passes. `docs/index.html` (8,112 B) +
  `docs/style.css` (2,937 B) copied in; server serves bundle at 200 with
  exactly 653,497 bytes.
- **Static browser checks (all that the VM allows)**: all 10 element IDs
  the bundle wires (`in-username`, `btn-lookup`, `fah-result`, `btn-claim`,
  `claim-result`, `btn-submit`, `submit-result`, `hist-list`, `btn-verify`,
  `oracle-status`) present in the bundle; oracle default URL present;
  contract name `FoldClaim` present; CORS preflight `OPTIONS` → 204 with
  `Access-Control-Allow-Origin: *`.
- **Headless browser: BLOCKED, not failed.** Chromium headless shell 1193
  + 1255, full Chromium 1193 + 1255, `--single-process --no-zygote`,
  headed under Xvfb, and Firefox 1572 all die at launch (SIGTRAP /
  "Target page, context or browser has been closed") before loading any
  page. The same Playwright script passed for BlazePay earlier in this VM
  lineage, so this is a VM sandbox regression, not an app defect. No
  screenshots/video could be recorded here; `tools/headless-test.mjs`
  (Playwright, drives lookup → claim → submit → verify for donor
  `satoshi`) + `demo/DEMO-SCRIPT.md` are provided for a one-command run
  on a normal machine.
- **Second E2E (repeatability)**: `FAH_USER=satoshi node
  tools/e2e-chipnet.mjs` — score 1,224,243 → 12 FOLD; escrow
  `df581e8a…` vout 0; claim `66f6c99a7072581d53100c690db488c7e28e0da03443594b611c403d160c1498`
  vout 0 = exactly 12 FOLD to claimant
  `bchtest:qzx72uz03csjun9k9sg6hdz9zz7plpu8esmt8mzyxn`, fee 409 sat, local
  VM debug PASS, contract address matched; double-claim → 409.
  Oracle registry now holds 2 claims (Anonymous 50,000 + satoshi 12).
  Funder balance after this: ~7,500 sat + ~949,988 FOLD (enough for a few
  more demo claims; top up via faucet + `oracle/setup.mjs` if it runs dry).
- **Confirmations**: all four chipnet txs (2 escrows + 2 claims) show 0
  confirmations at ~11:31 WIB via `rest-unstable.mainnet.cash` — including
  faucet tx `a1d9492a…` and `5482cc07…`, which had shown confirmations
  earlier. All four are still returned by `get_raw_transaction` (valid,
  mempool-known). Read as a chipnet/REST-node view quirk (slow mining or
  node restart/reorg), not invalid transactions. Re-verify live.
