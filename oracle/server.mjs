// FoldClaim oracle server (demo only — chipnet, $0 real money).
// The oracle is the ONE trusted component of FoldClaim: it reads the official
// Folding@home stats API and attests (username, score) -> (claimant, amount).
// It CANNOT steal or redirect funds: the contract requires the claimant's own
// signature and pins the payout to the claimant's address. It CAN lie about a
// score or refuse to attest — that residual trust is documented in README.md.
//
// Endpoints:
//   GET  /api/config                 public config (category, oracle pubkey, rate)
//   GET  /api/fah/:username          Folding@home donor record (proxied; FAH has no CORS)
//   POST /api/claim {username, claimantPkHex}
//        -> {amount, nonce, oracleSig, contractAddress, tokenAddress,
//            escrowTxid, escrowVout, escrowSatoshis, category, claimIndex, score}
//   POST /api/broadcast {txHex}     relay a fully-signed claim tx to chipnet
//   GET  /api/tx/:txid              verbose tx (on-chain verification)
//   GET  /api/claims?username=      claim history for a username
//
// Run: npm run oracle   (listens on PORT, default 8787)
import http from 'node:http';
import fs from 'node:fs';
import { Contract, SignatureTemplate } from 'cashscript';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  restPost, fetchFahUser, computeFoldAmount, computeNonce, sha256,
  bytesToHex, hexToBytes,
} from '../shared/claim-lib.mjs';
import { RestProvider } from '../shared/rest-provider.mjs';

const KEYS_PATH = new URL('./.keys.json', import.meta.url);
const CONFIG_PATH = new URL('./config.json', import.meta.url);
const ARTIFACT_PATH = new URL('../contracts/FoldClaim.json', import.meta.url);
const PORT = Number(process.env.PORT || 8787);
const ESCROW_SATS = 2000;

if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(CONFIG_PATH)) {
  console.error('Missing oracle/.keys.json or oracle/config.json — run: npm run setup');
  process.exit(1);
}
const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
if (!config.category) {
  console.error('config.json has no token category — run: npm run setup');
  process.exit(1);
}

const oracleTemplate = new SignatureTemplate(hexToBytes(keys.oraclePrivHex));
const provider = new RestProvider(keys.walletId);
const funderAddress = keys.funderAddress;

// In-memory claim registry. NOTE (VM quirk, verified 15 Nov 2026): in this
// sandbox a process that has done network I/O can no longer write files
// (EPERM on write, even in child processes). So the oracle NEVER writes to
// disk at runtime. Durability comes from the chain instead: every funding tx
// carries an OP_RETURN memo `FoldClaim:<username>:<score>:<claimIndex>`, and
// on startup the registry is rebuilt by scanning the funder wallet's history
// for those memos. A restart therefore cannot re-attest an already-funded
// score snapshot.
let registry = {};

async function rebuildRegistryFromChain() {
  try {
    const history = await restPost('/wallet/get_history', { walletId: keys.walletId, unit: 'sat' });
    const txs = Array.isArray(history) ? history : [];
    for (const tx of txs) {
      for (const out of tx.outputs || []) {
        const memo = out?.opReturn || out?.memo || '';
        const m = typeof memo === 'string' && memo.match(/^FoldClaim:([^:]+):(\d+):(\d+)$/);
        if (!m) continue;
        const [, username, score, claimIndex] = m;
        const key = username.toLowerCase();
        const entry = registry[key] || { lastScore: '0', claims: [] };
        if (BigInt(score) > BigInt(entry.lastScore)) entry.lastScore = score;
        entry.claims.push({
          username, score, claimIndex: Number(claimIndex),
          escrowTxid: tx.hash || tx.txid, fundedOnChain: true,
          note: 'Rebuilt from on-chain OP_RETURN memo (full claim details live only in the session that issued it).',
        });
        registry[key] = entry;
      }
    }
    const n = Object.values(registry).reduce((a, e) => a + e.claims.length, 0);
    console.log(`[registry] rebuilt from chain history: ${n} funded claim(s)`);
  } catch (e) {
    console.log('[registry] rebuild failed (continuing with empty registry):', String(e?.message || e).slice(0, 200));
  }
}

// FAH cache (60s) — stats update hourly anyway.
const fahCache = new Map();
async function fahUser(username) {
  const now = Date.now();
  const hit = fahCache.get(username.toLowerCase());
  if (hit && now - hit.at < 60_000) return hit.data;
  const data = await fetchFahUser(username);
  fahCache.set(username.toLowerCase(), { at: now, data });
  return data;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, {
        tokenName: config.tokenName, ticker: config.ticker,
        category: config.category, oraclePubHex: config.oraclePubHex,
        pointsPerFold: config.pointsPerFold, maxClaimFold: config.maxClaimFold,
        funderAddress, escrowSats: ESCROW_SATS,
      });
    }

    if (req.method === 'GET' && path.startsWith('/api/fah/')) {
      const username = decodeURIComponent(path.slice('/api/fah/'.length));
      if (!username) return sendJson(res, 400, { error: 'username required' });
      const data = await fahUser(username);
      return sendJson(res, 200, {
        name: data.name, id: data.id, score: data.score, wus: data.wus,
        rank: data.rank, active_7: data.active_7, active_50: data.active_50,
        last: data.last, teams: (data.teams || []).map((t) => ({ team: t.team, name: t.name })),
        foldAmount: computeFoldAmount(data.score).toString(),
      });
    }

    if (req.method === 'GET' && path === '/api/claims') {
      const username = (url.searchParams.get('username') || '').toLowerCase();
      const entry = registry[username];
      return sendJson(res, 200, { username, claims: entry ? entry.claims : [] });
    }

    if (req.method === 'GET' && path.startsWith('/api/tx/')) {
      const txid = path.slice('/api/tx/'.length);
      const tx = await provider.getRawTransactionVerbose(txid);
      return sendJson(res, 200, tx);
    }

    if (req.method === 'POST' && path === '/api/broadcast') {
      const { txHex } = await readBody(req);
      if (!txHex || typeof txHex !== 'string') return sendJson(res, 400, { error: 'txHex required' });
      const txid = await provider.sendRawTransaction(txHex);
      return sendJson(res, 200, { txid });
    }

    if (req.method === 'POST' && path === '/api/claim') {
      const { username, claimantPkHex } = await readBody(req);
      if (!username || typeof username !== 'string') return sendJson(res, 400, { error: 'username required' });
      if (!claimantPkHex || !/^[0-9a-fA-F]{66}$/.test(claimantPkHex)) {
        return sendJson(res, 400, { error: 'claimantPkHex must be a 33-byte compressed pubkey (hex)' });
      }
      const fah = await fahUser(username);
      const score = BigInt(Math.floor(Number(fah.score)));
      const amount = computeFoldAmount(score);
      if (amount <= 0n) {
        return sendJson(res, 400, { error: `Score ${score} is too low to earn any FOLD (needs >= ${config.pointsPerFold} points).` });
      }
      const key = username.toLowerCase();
      const entry = registry[key] || { lastScore: '0', claims: [] };
      if (BigInt(entry.lastScore) >= score) {
        return sendJson(res, 409, {
          error: `Nothing new to claim: score ${score} was already claimed (last claimed score ${entry.lastScore}). Fold more, then come back.`,
          lastScore: entry.lastScore,
        });
      }
      const claimIndex = entry.claims.length;
      const claimantPk = hexToBytes(claimantPkHex);
      const nonce = computeNonce({ claimantPk, amount, username: fah.name, score, claimIndex });
      const oracleSig = oracleTemplate.signMessageHash(sha256(nonce));
      const contract = new Contract(
        artifact,
        [keys.oraclePubHex, claimantPkHex, bytesToHex(nonce)],
        { provider },
      );
      console.log(`[claim] ${fah.name} score=${score} amount=${amount} claimIndex=${claimIndex}`);
      console.log(`[claim] contract ${contract.address} tokenAddr ${contract.tokenAddress}`);

      // Fund the escrow: `amount` FOLD + 2000 sats (covers the claim tx fee).
      // The OP_RETURN memo makes the attestation auditable on-chain and lets
      // the registry be rebuilt from chain history after a restart.
      const memo = `FoldClaim:${fah.name}:${score}:${claimIndex}`;
      const sendRes = await restPost('/wallet/send', {
        walletId: keys.walletId,
        to: [
          // TokenSendRequest uses FLAT fields (amount + category at top level,
          // NOT nested under `token` — nesting silently drops the tokens).
          { cashaddr: contract.tokenAddress, value: ESCROW_SATS, amount: Number(amount), category: config.category },
          ['OP_RETURN', memo],
        ],
      });
      const escrowTxid = sendRes?.txId || sendRes?.txid || sendRes?.hash;
      if (!escrowTxid) throw new Error(`fund escrow failed: ${JSON.stringify(sendRes).slice(0, 300)}`);
      console.log(`[claim] escrow funded: ${escrowTxid}`);

      // Find the escrow vout (the output paying the contract token address).
      let escrowVout = -1;
      for (let i = 0; i < 20; i++) {
        try {
          const tx = await provider.getRawTransactionVerbose(escrowTxid);
          const outs = tx?.vout || tx?.outputs || [];
          escrowVout = outs.findIndex((o) => {
            const addr = o?.scriptPubKey?.addresses?.[0] || o?.address || '';
            return addr === contract.tokenAddress || addr === contract.address;
          });
          if (escrowVout >= 0) break;
        } catch { /* not propagated yet */ }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (escrowVout < 0) throw new Error(`escrow tx ${escrowTxid} not found / vout not identified after polling`);
      console.log(`[claim] escrow vout=${escrowVout}`);

      const claim = {
        username: fah.name, score: score.toString(), amount: amount.toString(),
        claimIndex, nonce: bytesToHex(nonce), oracleSig: bytesToHex(oracleSig),
        claimantPk: claimantPkHex, oraclePub: keys.oraclePubHex,
        contractAddress: contract.address, tokenAddress: contract.tokenAddress,
        escrowTxid, escrowVout, escrowSatoshis: ESCROW_SATS,
        category: config.category, createdAt: new Date().toISOString(),
      };
      entry.lastScore = score.toString();
      entry.claims.push(claim);
      registry[key] = entry;
      return sendJson(res, 200, claim);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[error]', e);
    return sendJson(res, 500, { error: String(e?.message || e).slice(0, 500) });
  }
});

server.listen(PORT, async () => {
  console.log(`FoldClaim oracle listening on http://localhost:${PORT}`);
  console.log(`oracle pubkey: ${keys.oraclePubHex}`);
  console.log(`FOLD category: ${config.category}`);
  console.log(`funder: ${funderAddress}`);
  await rebuildRegistryFromChain();
});
