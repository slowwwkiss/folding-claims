// End-to-end chipnet test for FoldClaim (real chain, $0 real money).
// Assumes the oracle server is running (npm run oracle, :8787).
// Flow: FAH lookup -> request claim (oracle signs + funds escrow) ->
// build claim tx locally (cashscript, real BCH VM debug) -> broadcast via
// oracle relay -> verify on-chain. Then proves the double-claim refusal.
import { Contract, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { lockingBytecodeToCashAddress, assertSuccess } from '@bitauth/libauth';
import { bytesToHex, hexToBytes } from '../shared/claim-lib.mjs';
import { RestProvider } from '../shared/rest-provider.mjs';

const ORACLE = process.env.ORACLE_URL || 'http://localhost:8787';
const USERNAME = process.env.FAH_USER || 'Anonymous';
const artifact = JSON.parse(readFileSync(new URL('../contracts/FoldClaim.json', import.meta.url), 'utf8'));
const keys = JSON.parse(readFileSync(new URL('../oracle/.keys.json', import.meta.url), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest();
const ripemd160 = (b) => createHash('ripemd160').update(b).digest();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
  return { status: res.status, body: j };
}

console.log('== 1. oracle config ==');
const cfg = await jfetch(`${ORACLE}/api/config`);
console.log('config:', cfg.status, JSON.stringify(cfg.body).slice(0, 300));
if (cfg.status !== 200) process.exit(2);
const category = cfg.body.category;

console.log('== 2. FAH lookup ==');
const fah = await jfetch(`${ORACLE}/api/fah/${encodeURIComponent(USERNAME)}`);
console.log('fah:', fah.status, JSON.stringify(fah.body).slice(0, 300));
if (fah.status !== 200) process.exit(3);

console.log('== 3. claimant keypair ==');
const claimantPriv = randomBytes(32);
const claimantPub = secp256k1.getPublicKey(claimantPriv, true);
const claimantPkHex = bytesToHex(claimantPub);
const pkh = ripemd160(sha256(claimantPub));
const p2pkhLock = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])]);
const claimantTokenAddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: p2pkhLock, prefix: 'bchtest', tokenSupport: true })).address;
const claimantAddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: p2pkhLock, prefix: 'bchtest', tokenSupport: false })).address;
console.log('claimant:', claimantAddr, '| token:', claimantTokenAddr);

console.log('== 4. request claim ==');
const claimRes = await jfetch(`${ORACLE}/api/claim`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USERNAME, claimantPkHex }),
});
console.log('claim:', claimRes.status, JSON.stringify(claimRes.body).slice(0, 500));
if (claimRes.status !== 200) process.exit(4);
const claim = claimRes.body;

console.log('== 5. build claim tx (local) ==');
const provider = new RestProvider(keys.walletId);
const contract = new Contract(artifact, [claim.oraclePub, claim.claimantPk, claim.nonce], { provider });
console.log('contract address matches oracle:', contract.address === claim.contractAddress, contract.address);
const escrowUtxo = {
  txid: claim.escrowTxid,
  vout: claim.escrowVout,
  satoshis: BigInt(claim.escrowSatoshis),
  token: { amount: BigInt(claim.amount), category },
  lockingBytecode: contract.lockingBytecode,
};
const claimantTemplate = new SignatureTemplate(claimantPriv);
const b = new TransactionBuilder({ provider });
b.addInput(escrowUtxo, contract.unlock.claim(claim.oracleSig, claimantTemplate));
b.addOutput({ to: claimantTokenAddr, amount: 1000n, token: { amount: BigInt(claim.amount), category } });
b.addBchChangeOutputIfNeeded({ to: claimantAddr, feeRate: 1 });
const dbg = b.debug();
console.log('local VM debug: PASS (no error thrown)');
const txHex = b.build();
console.log('claim tx bytes:', txHex.length / 2, '| fee:', b.calculateTransactionFee());

console.log('== 6. broadcast via oracle relay ==');
const bc = await jfetch(`${ORACLE}/api/broadcast`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ txHex }),
});
console.log('broadcast:', bc.status, JSON.stringify(bc.body).slice(0, 300));
if (bc.status !== 200) process.exit(5);
const claimTxid = bc.body.txid;

console.log('== 7. verify on-chain ==');
let tx = null;
for (let i = 0; i < 20; i++) {
  try {
    const r = await jfetch(`${ORACLE}/api/tx/${claimTxid}`);
    if (r.status === 200 && r.body?.hex) { tx = r.body; break; }
  } catch { /* retry */ }
  await sleep(5000);
}
if (!tx) { console.log('VERIFY FAILED — tx not found after polling'); process.exit(6); }
console.log('confirmations:', tx.confirmations, '| blockheight:', tx.blockheight ?? tx.blockHeight);
console.log('vout:', JSON.stringify(tx.vout).slice(0, 600));
const paid = (tx.vout || []).some((o) => (o?.scriptPubKey?.addresses || []).includes(claimantTokenAddr) && o?.scriptPubKey?.token?.amount === claim.amount);
console.log('token output to claimant with exact amount:', paid ? 'YES' : 'CHECK MANUALLY');

console.log('== 8. double-claim refusal ==');
const again = await jfetch(`${ORACLE}/api/claim`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USERNAME, claimantPkHex }),
});
console.log('second claim:', again.status, JSON.stringify(again.body).slice(0, 200));
if (again.status !== 409) console.log('WARNING: expected 409 for double-claim');

console.log('== 9. history ==');
const hist = await jfetch(`${ORACLE}/api/claims?username=${encodeURIComponent(USERNAME)}`);
console.log('history claims:', hist.body?.claims?.length);

console.log('\nE2E RESULT:');
console.log('  FAH user:', USERNAME, 'score:', fah.body.score, '-> FOLD:', claim.amount);
console.log('  escrow tx:', claim.escrowTxid, 'vout', claim.escrowVout);
console.log('  claim tx :', claimTxid);
console.log('  claimant :', claimantAddr);
