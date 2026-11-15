// Shared FoldClaim helpers — used by the oracle server (Node) and the Vite app.
// Pure functions only; no secrets here. Uses @noble/hashes so the same file
// bundles for the browser (no node: builtins).
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

export const REST_BASE = 'https://rest-unstable.mainnet.cash';
export const FAH_API = 'https://api.foldingathome.org';

// Demo economics (NOT the real FLDCH rate — this is a chipnet demo token).
// 1 demo-FOLD per 100,000 Folding@home points, capped at 50,000 per claim.
export const POINTS_PER_FOLD = 100_000;
export const MAX_CLAIM_FOLD = 50_000;
export const TOKEN_NAME = 'FOLD';
export const TOKEN_TICKER = 'FOLD';

export function sha256(bytes) {
  return nobleSha256(bytes);
}

export function computeFoldAmount(score) {
  const s = typeof score === 'bigint' ? score : BigInt(Math.floor(Number(score)));
  if (s <= 0n) return 0n;
  let amount = s / BigInt(POINTS_PER_FOLD);
  if (amount > BigInt(MAX_CLAIM_FOLD)) amount = BigInt(MAX_CLAIM_FOLD);
  return amount;
}

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** nonce = sha256(claimantPk || amount || utf8(username) || score || claimIndex) */
export function computeNonce({ claimantPk, amount, username, score, claimIndex }) {
  return sha256(
    Buffer.concat([
      Buffer.from(claimantPk),
      u64le(amount),
      Buffer.from(username, 'utf8'),
      u64le(score),
      u32le(claimIndex),
    ]),
  );
}

export function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/** Minimal REST client for rest-unstable.mainnet.cash (chipnet). */
export async function restPost(path, body) {
  const res = await fetch(REST_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(`REST ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/** Fetch a Folding@home donor record from the official public stats API. No key needed. */
export async function fetchFahUser(username) {
  const res = await fetch(`${FAH_API}/user/${encodeURIComponent(username)}`);
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`FAH API returned non-JSON (${res.status})`);
  }
  if (!res.ok || json.error) {
    throw new Error(json.error || `FAH user not found (HTTP ${res.status})`);
  }
  return json; // { name, id, score, wus, rank, active_50, active_7, last, teams }
}
