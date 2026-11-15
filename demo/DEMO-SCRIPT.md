# FoldClaim — Demo Script (shot-by-shot)

No video could be recorded in the build VM: every browser there dies at
launch (SIGTRAP — see NOTES.md). This script is the exact sequence
`tools/headless-test.mjs` performs, so a reviewer can reproduce it in one
command on a normal machine — or follow it by hand.

## Setup (one command each)

```bash
# terminal 1 — oracle (already running in the demo VM on :8787)
npm run oracle
# terminal 2 — serve the built app
python3 -m http.server 8123 --directory docs
# terminal 3 — automated run (Playwright; needs a working Chromium)
node tools/headless-test.mjs
```

Manual run: open `http://127.0.0.1:8123/` in a browser.

## Shots

**Shot 1 — Home.** The page loads with zero console errors. Header shows
"FoldClaim" and the trust-model summary. Step 2 shows a freshly generated
claimant address (`bchtest:q…`, token address `bchtest:z…`) and a "New key"
button. The oracle status dot is green: "oracle: online
(http://localhost:8787)". History is empty ("No claims yet in this
browser", total 0 FOLD).

**Shot 2 — Lookup.** Type `folding` in the username field, click "Look
up". The result shows: Donor `folding` (id, rank #43,583), Score
86,756,097 points, Work units 18,248, Reward **867 FOLD**, and the note
"This score earns a claim. Continue to step 3." The "Request claim"
button becomes enabled. (Donors `Anonymous` and `satoshi` are already
claimed in the demo — the oracle will refuse them with HTTP 409; use
`folding` or `BCH` for a fresh claim.)

**Shot 3 — Request claim.** Click "Request claim". The result shows:
"Claim issued — the oracle signed it and funded the escrow." Amount 867
FOLD, an escrow txid (vout 0), the contract address, the nonce (first 16
hex chars), and the oracle signature (first 16 hex chars). Note: "Nothing
has moved yet — the FOLD sits in the escrow contract." The "Submit claim
on-chain" button becomes enabled.

**Shot 4 — Submit on-chain.** Click "Submit claim on-chain". The button
cycles Building… → Verifying in VM… → Broadcasting…. The result shows:
"Claim submitted on-chain." Claim txid, fee (~409 sat), "Received 867
FOLD → bchtest:q…", and a "Verify on-chain now" button. History now shows
1 claim, total 867 FOLD.

**Shot 5 — Verify on-chain.** Click "Verify on-chain now". The output
shows "Confirmations: N" (chipnet mining is slow — expect 0 at first;
re-check later) and the outputs list, with vout 0 showing the claimant
address, 0.00001 BCH, and "+ 867 FOLD". That line is the proof: the
contract released exactly the attested amount to exactly the claimant.

**Shot 6 (optional) — Double-claim refusal.** Refresh, look up `folding`
again, request a claim: the oracle answers HTTP 409 — "Nothing new to
claim: score 86,756,097 was already claimed. Fold more, then come back."
No second escrow is funded.

## What to check while watching

- The claim txid from Shot 4 is a real chipnet transaction: paste it into
  `POST https://rest-unstable.mainnet.cash/wallet/util/get_raw_transaction`
  with `{"txHash":"<txid>","network":"testnet","verbose":true}` and confirm
  vout 0 carries the FOLD token amount to the claimant's P2PKH address.
- The escrow txid from Shot 3 carries an `OP_RETURN` memo
  `FoldClaim:folding:86756097:0` — the attestation is on-chain and
  auditable.
- The oracle's registry (`GET http://localhost:8787/api/claims?username=folding`)
  lists the claim with its nonce, oracle signature, and escrow txid.
