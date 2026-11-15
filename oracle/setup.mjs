// One-time oracle setup (chipnet only, $0 real money).
// Creates the funder wallet, funds it from the testnet faucet, mints the demo
// FOLD CashToken, and writes:
//   oracle/.keys.json  (SECRET, mode 600, gitignored): funder walletId + oracle signing key
//   oracle/config.json (public): token category, oracle pubkey, demo rate
// Re-running is safe: it reuses .keys.json if present and skips genesis if
// the category is already recorded.
import { createWallet } from 'mainnet-js';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { restPost, bytesToHex } from '../shared/claim-lib.mjs';

const KEYS_PATH = new URL('./.keys.json', import.meta.url);
const CONFIG_PATH = new URL('./config.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function faucet(cashaddr) {
  const r = await restPost('/faucet/get_testnet_bch', { cashaddr });
  console.log('faucet:', JSON.stringify(r).slice(0, 200));
  return r?.txId || r?.txid;
}

async function balance(walletId) {
  const r = await restPost('/wallet/balance', { walletId });
  return Number(r?.sat ?? r?.balance ?? r?.satoshis ?? 0);
}

let keys;
if (fs.existsSync(KEYS_PATH)) {
  keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
  console.log('reusing existing keys file (funder:', keys.funderAddress, ')');
} else {
  const wallet = await createWallet({ network: 'testnet', type: 'seed' });
  const info = await wallet.getInfo();
  const oraclePriv = randomBytes(32);
  const oraclePub = secp256k1.getPublicKey(oraclePriv, true);
  keys = {
    walletId: info.walletId,
    funderAddress: wallet.getDepositAddress(),
    oraclePrivHex: bytesToHex(oraclePriv),
    oraclePubHex: bytesToHex(oraclePub),
  };
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log('created funder wallet:', keys.funderAddress);
  console.log('oracle pubkey:', keys.oraclePubHex);
}

console.log('funder balance:', await balance(keys.walletId), 'sat');
let bal = await balance(keys.walletId);
if (bal < 5000) {
  console.log('requesting faucet funds…');
  await faucet(keys.funderAddress);
  for (let i = 0; i < 12; i++) {
    await sleep(10000);
    bal = await balance(keys.walletId);
    console.log(`poll ${i}: ${bal} sat`);
    if (bal >= 5000) break;
  }
}
if (bal < 5000) {
  console.log('NOT FUNDED ENOUGH — rerun setup later (faucet may be rate-limited).');
  process.exit(2);
}

let config = { tokenName: 'FOLD', ticker: 'FOLD', pointsPerFold: 100000, maxClaimFold: 50000, oraclePubHex: keys.oraclePubHex, funderAddress: keys.funderAddress };
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (existing.category) {
      console.log('token already minted, category:', existing.category);
      console.log('setup complete.');
      process.exit(0);
    }
    config = { ...config, ...existing };
  } catch {
    console.log('config.json unreadable — continuing to mint.');
  }
}

console.log('minting 1,000,000 demo FOLD…');
const g = await restPost('/wallet/token_genesis', {
  walletId: keys.walletId,
  amount: 1_000_000,
  cashaddr: keys.funderAddress,
  value: 1000,
});
console.log('genesis:', JSON.stringify(g).slice(0, 400));
const category = g?.categories?.[0] || g?.category || g?.tokenId;
if (!category) {
  console.log('GENESIS FAILED — no category in response. Inspect output above.');
  process.exit(3);
}
config.category = category;
console.log('category:', category);
console.log('setup complete. Save this as oracle/config.json (this VM forbids file');
console.log('writes from a process that has done network I/O, so setup prints it');
console.log('instead of writing it):');
console.log(JSON.stringify(config, null, 2));
console.log('Then start the oracle with: npm run oracle');
