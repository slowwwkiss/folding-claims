// Local VM test for the FoldClaim contract — no chain access needed.
// Builds a mock claim tx and evaluates it against the real BCH VM (libauth)
// via cashscript's debug(). Tries oracle-signature variants until one passes.
import { Contract, SignatureTemplate, TransactionBuilder, MockNetworkProvider } from 'cashscript';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes, createHash } from 'node:crypto';
const sha256 = (b) => createHash('sha256').update(b).digest();
const ripemd160 = (b) => createHash('ripemd160').update(b).digest();
import { lockingBytecodeToCashAddress, assertSuccess } from '@bitauth/libauth';

const artifact = JSON.parse(readFileSync(new URL('../contracts/FoldClaim.json', import.meta.url), 'utf8'));

const hex = (b) => Buffer.from(b).toString('hex');
const concat = (...arrs) => Buffer.concat(arrs.map((a) => Buffer.from(a)));
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const provider = new MockNetworkProvider();
provider.network = 'chipnet';

const oraclePriv = randomBytes(32);
const oraclePub = secp256k1.getPublicKey(oraclePriv, true);
const claimantPriv = randomBytes(32);
const claimantPub = secp256k1.getPublicKey(claimantPriv, true);
const claimantTemplate = new SignatureTemplate(claimantPriv);
const oracleTemplate = new SignatureTemplate(oraclePriv);

// Claim data (mirrors the oracle's nonce construction)
const amount = 1000n;
const username = 'Anonymous';
const score = 4077868983800n;
const claimIndex = 0;
const nonce = sha256(concat(claimantPub, le64(amount), Buffer.from(username, 'utf8'), le64(score), le32(claimIndex)));
console.log('nonce:', hex(nonce));

const contract = new Contract(artifact, [hex(oraclePub), hex(claimantPub), hex(nonce)], { provider });
console.log('contract address:', contract.address);
console.log('contract tokenAddress:', contract.tokenAddress);

const pkh = ripemd160(sha256(claimantPub));
const p2pkhLock = concat([0x76, 0xa9, 0x14], pkh, [0x88, 0xac]);
const claimantAddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: p2pkhLock, prefix: 'bchtest', tokenSupport: true })).address;
console.log('claimant tokenaddr:', claimantAddr);

const CATEGORY = '00'.repeat(32); // fake category for the mock UTXO
const escrowUtxo = {
  txid: '11'.repeat(32),
  vout: 0,
  satoshis: 2000n,
  token: { amount, category: CATEGORY },
  lockingBytecode: contract.lockingBytecode,
};

function tryVariant(name, oracleSigHex) {
  try {
    const b = new TransactionBuilder({ provider });
    b.addInput(escrowUtxo, contract.unlock.claim(oracleSigHex, claimantTemplate));
    b.addOutput({ to: claimantAddr, amount: 1000n, token: { amount, category: CATEGORY } });
    b.addBchChangeOutputIfNeeded({ to: claimantAddr, feeRate: 1 });
    const res = b.debug();
    const ok = Object.values(res).every((steps) => steps.at(-1)?.status === 'success' || steps.at(-1)?.error === undefined);
    console.log(`[${name}] debug: PASS (no VM error)`);
    console.log(`[${name}] tx hex:`, b.build().slice(0, 120) + '...');
    return true;
  } catch (e) {
    console.log(`[${name}] debug: FAIL — ${String(e.message ?? e).slice(0, 300)}`);
    return false;
  }
}

// Variant A: BCH Schnorr (libauth, via SignatureTemplate) over sha256(nonce)
const sigA = oracleTemplate.signMessageHash(sha256(nonce));
console.log('sigA len:', sigA.length);
if (tryVariant('A schnorr(sha256(nonce))', hex(sigA))) process.exit(0);

// Variant B: BCH Schnorr over the nonce itself (nonce is already a 32-byte digest)
const sigB = oracleTemplate.signMessageHash(nonce);
if (tryVariant('B schnorr(nonce)', hex(sigB))) process.exit(0);

// Variant C: ECDSA (noble) over sha256(nonce), DER-encoded
const derEncode = (sig) => {
  const r = Buffer.from(sig.r.toString(16).padStart(64, '0'), 'hex');
  const s = Buffer.from(sig.s.toString(16).padStart(64, '0'), 'hex');
  const enc = (b) => { let x = b; while (x.length > 1 && x[0] === 0) x = x.subarray(1); if (x[0] & 0x80) x = Buffer.concat([Buffer.from([0]), x]); return Buffer.concat([Buffer.from([0x02, x.length]), x]); };
  const body = Buffer.concat([enc(r), enc(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('hex');
};
const sigC = secp256k1.sign(sha256(nonce), oraclePriv);
if (tryVariant('C ecdsa-der(sha256(nonce))', derEncode(sigC))) process.exit(0);

// Variant D: ECDSA over nonce directly
const sigD = secp256k1.sign(nonce, oraclePriv);
if (tryVariant('D ecdsa-der(nonce)', derEncode(sigD))) process.exit(0);

console.log('ALL VARIANTS FAILED');
process.exit(1);
