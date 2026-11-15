// FoldClaim — browser app (chipnet demo).
// Flow: FAH lookup (via oracle proxy) -> request claim (oracle signs + funds
// escrow) -> build + locally-verify + broadcast claim tx (cashscript) ->
// on-chain verification + history. No real BCH, no mainnet.
import { Contract, SignatureTemplate, TransactionBuilder, utils } from 'cashscript';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { lockingBytecodeToCashAddress, assertSuccess } from '@bitauth/libauth';
import artifact from '../contracts/FoldClaim.json';
import { RelayProvider } from './relay-provider.js';

const $ = (id) => document.getElementById(id);
const els = {
  oracleDot: $('oracle-dot'), oracleStatus: $('oracle-status'),
  inUsername: $('in-username'), btnLookup: $('btn-lookup'), fahResult: $('fah-result'),
  claimAddr: $('claim-addr'), claimTokenAddr: $('claim-tokenaddr'), claimPk: $('claim-pk'),
  btnNewKey: $('btn-newkey'), btnClaim: $('btn-claim'), claimResult: $('claim-result'),
  btnSubmit: $('btn-submit'), submitResult: $('submit-result'),
  histTotal: $('hist-total'), histList: $('hist-list'), btnRefreshHist: $('btn-refresh-hist'),
  cfgCategory: $('cfg-category'),
};

// Oracle URL: ?oracle= param wins, then localStorage, then localhost default.
const params = new URLSearchParams(location.search);
const ORACLE_URL = (params.get('oracle') || localStorage.getItem('foldclaim-oracle') || 'http://localhost:8787').replace(/\/$/, '');
localStorage.setItem('foldclaim-oracle', ORACLE_URL);

const KEY_KEY = 'foldclaim-claimant-priv';
const HIST_KEY = 'foldclaim-history';
let config = null;
let fah = null;      // last lookup result
let claim = null;    // last issued claim (from oracle)
let claimantPriv = null;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b) { return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtScore(n) { return Number(n).toLocaleString('en-US'); }
function short(hex, n = 12) { return hex ? `${hex.slice(0, n)}…${hex.slice(-6)}` : ''; }

function show(el, html) { el.classList.remove('hidden'); el.innerHTML = html; }
function statusMsg(msg, kind = 'info') {
  els.oracleStatus.textContent = msg;
  els.oracleDot.style.background = kind === 'ok' ? '#2fbf71' : kind === 'err' ? '#e5484d' : '#f5a524';
}

function loadOrCreateClaimant() {
  let privHex = localStorage.getItem(KEY_KEY);
  if (!privHex || !/^[0-9a-f]{64}$/.test(privHex)) {
    const priv = new Uint8Array(32);
    crypto.getRandomValues(priv);
    privHex = bytesToHex(priv);
    localStorage.setItem(KEY_KEY, privHex);
  }
  claimantPriv = hexToBytes(privHex);
  const pub = secp256k1.getPublicKey(claimantPriv, true);
  const pkh = utils.hash160(pub);
  const lock = Uint8Array.from([...[0x76, 0xa9, 0x14], ...pkh, ...[0x88, 0xac]]);
  const addr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: lock, prefix: 'bchtest', tokenSupport: false })).address;
  const tokenAddr = assertSuccess(lockingBytecodeToCashAddress({ bytecode: lock, prefix: 'bchtest', tokenSupport: true })).address;
  els.claimAddr.textContent = addr;
  els.claimTokenAddr.textContent = tokenAddr;
  els.claimPk.textContent = bytesToHex(pub);
  return { pubHex: bytesToHex(pub), addr, tokenAddr };
}
let identity = loadOrCreateClaimant();

async function oracleGet(path) {
  const res = await fetch(`${ORACLE_URL}${path}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `oracle HTTP ${res.status}`);
  return j;
}
async function oraclePost(path, body) {
  const res = await fetch(`${ORACLE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `oracle HTTP ${res.status}`);
  return j;
}

async function init() {
  try {
    config = await oracleGet('/api/config');
    statusMsg(`oracle: online (${ORACLE_URL})`, 'ok');
    els.cfgCategory.textContent = config.category;
  } catch (e) {
    statusMsg(`oracle: offline — ${e.message} (start it: npm run oracle)`, 'err');
    show(els.fahResult, `<p class="err">The FoldClaim oracle is not reachable at <code>${esc(ORACLE_URL)}</code>. The demo needs the oracle running (it signs claims and funds escrows). Start it with <code>npm run oracle</code>, or open the app with <code>?oracle=&lt;url&gt;</code>.</p>`);
  }
  renderHistory();
}

els.btnNewKey.addEventListener('click', () => {
  localStorage.removeItem(KEY_KEY);
  identity = loadOrCreateClaimant();
  fah = null; claim = null;
  els.btnClaim.disabled = true; els.btnSubmit.disabled = true;
  els.claimResult.classList.add('hidden'); els.submitResult.classList.add('hidden');
});

els.btnLookup.addEventListener('click', async () => {
  const username = els.inUsername.value.trim();
  if (!username) { show(els.fahResult, '<p class="err">Enter a Folding@home username first.</p>'); return; }
  els.btnLookup.disabled = true; els.btnLookup.textContent = 'Looking up…';
  try {
    fah = await oracleGet(`/api/fah/${encodeURIComponent(username)}`);
    claim = null;
    els.btnSubmit.disabled = true; els.submitResult.classList.add('hidden');
    const teams = (fah.teams || []).map((t) => esc(t.name)).join(', ') || '—';
    show(els.fahResult, `
      <div class="kv"><span>Donor</span><strong>${esc(fah.name)}</strong> <span class="hint">(id ${esc(fah.id)}, rank #${esc(fah.rank)})</span></div>
      <div class="kv"><span>Score</span><strong>${fmtScore(fah.score)} points</strong></div>
      <div class="kv"><span>Work units</span><strong>${fmtScore(fah.wus)}</strong></div>
      <div class="kv"><span>Active (7d / 50d)</span><strong>${esc(fah.active_7)} / ${esc(fah.active_50)}</strong></div>
      <div class="kv"><span>Last active</span><strong>${esc(fah.last || '—')}</strong></div>
      <div class="kv"><span>Teams</span><strong>${teams}</strong></div>
      <div class="kv reward"><span>Reward for this score</span><strong>${fmtScore(fah.foldAmount)} FOLD</strong></div>
      ${Number(fah.foldAmount) > 0
        ? '<p class="ok">This score earns a claim. Continue to step 3.</p>'
        : '<p class="err">Score too low to earn any FOLD (needs 100,000+ points).</p>'}`);
    els.btnClaim.disabled = Number(fah.foldAmount) <= 0;
  } catch (e) {
    show(els.fahResult, `<p class="err">Lookup failed: ${esc(e.message)}</p>`);
    els.btnClaim.disabled = true;
  } finally {
    els.btnLookup.disabled = false; els.btnLookup.textContent = 'Look up';
  }
});

els.btnClaim.addEventListener('click', async () => {
  if (!fah) return;
  els.btnClaim.disabled = true; els.btnClaim.textContent = 'Requesting…';
  try {
    claim = await oraclePost('/api/claim', { username: fah.name, claimantPkHex: identity.pubHex });
    show(els.claimResult, `
      <p class="ok">Claim issued — the oracle signed it and funded the escrow.</p>
      <div class="kv"><span>Amount</span><strong>${fmtScore(claim.amount)} FOLD</strong></div>
      <div class="kv"><span>Escrow tx</span><code>${esc(claim.escrowTxid)}</code> (vout ${esc(claim.escrowVout)})</div>
      <div class="kv"><span>Contract</span><code>${esc(claim.contractAddress)}</code></div>
      <div class="kv"><span>Nonce</span><code>${short(claim.nonce, 16)}</code></div>
      <div class="kv"><span>Oracle signature</span><code>${short(claim.oracleSig, 16)}</code></div>
      <p class="hint">Nothing has moved yet — the FOLD sits in the escrow contract. Submit the claim (step 4) to pull it to your address.</p>`);
    els.btnSubmit.disabled = false;
  } catch (e) {
    show(els.claimResult, `<p class="err">Claim failed: ${esc(e.message)}</p>`);
  } finally {
    els.btnClaim.disabled = false; els.btnClaim.textContent = 'Request claim';
  }
});

els.btnSubmit.addEventListener('click', async () => {
  if (!claim || !config) return;
  els.btnSubmit.disabled = true; els.btnSubmit.textContent = 'Building…';
  try {
    const provider = new RelayProvider(ORACLE_URL);
    const contract = new Contract(artifact, [claim.oraclePub, claim.claimantPk, claim.nonce], { provider });
    if (contract.address !== claim.contractAddress) throw new Error('contract address mismatch — refusing to sign');
    const escrowUtxo = {
      txid: claim.escrowTxid,
      vout: claim.escrowVout,
      satoshis: BigInt(claim.escrowSatoshis),
      token: { amount: BigInt(claim.amount), category: config.category },
      lockingBytecode: contract.lockingBytecode,
    };
    const template = new SignatureTemplate(claimantPriv);
    const b = new TransactionBuilder({ provider });
    b.addInput(escrowUtxo, contract.unlock.claim(claim.oracleSig, template));
    b.addOutput({ to: identity.tokenAddr, amount: 1000n, token: { amount: BigInt(claim.amount), category: config.category } });
    b.addBchChangeOutputIfNeeded({ to: identity.addr, feeRate: 1 });
    els.btnSubmit.textContent = 'Verifying in VM…';
    b.debug(); // local BCH VM evaluation — throws on any failing require
    const txHex = b.build();
    const fee = b.calculateTransactionFee();
    els.btnSubmit.textContent = 'Broadcasting…';
    const txid = await provider.sendRawTransaction(txHex);
    const receipt = { ...claim, claimTxid: txid, feeSats: fee.feeSats.toString(), at: new Date().toISOString() };
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    hist.push(receipt);
    localStorage.setItem(HIST_KEY, JSON.stringify(hist));
    renderHistory();
    show(els.submitResult, `
      <p class="ok">Claim submitted on-chain.</p>
      <div class="kv"><span>Claim tx</span><code>${esc(txid)}</code></div>
      <div class="kv"><span>Fee</span><strong>${esc(fee.feeSats.toString())} sat</strong></div>
      <div class="kv"><span>Received</span><strong>${fmtScore(claim.amount)} FOLD → ${esc(identity.addr)}</strong></div>
      <p><button class="btn" id="btn-verify">Verify on-chain now</button> <span id="verify-out" class="hint"></span></p>`);
    $('btn-verify').addEventListener('click', async () => {
      try {
        const tx = await oracleGet(`/api/tx/${txid}`);
        const outs = (tx.vout || []).map((o) => {
          const tok = o.tokenData ? ` + ${o.tokenData.amount} FOLD` : '';
          const addr = (o.scriptPubKey?.addresses || ['?'])[0];
          return `<li>${esc(addr)} — ${esc(o.value)} BCH${tok}</li>`;
        }).join('');
        $('verify-out').innerHTML = `<br>Confirmations: <strong>${esc(tx.confirmations ?? 0)}</strong><ul>${outs}</ul>`;
      } catch (e) { $('verify-out').textContent = `verify failed: ${e.message}`; }
    });
  } catch (e) {
    show(els.submitResult, `<p class="err">Submit failed: ${esc(e.message)}</p>`);
    els.btnSubmit.disabled = false;
  } finally {
    els.btnSubmit.textContent = 'Submit claim on-chain';
  }
});

function renderHistory() {
  const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  const total = hist.reduce((a, h) => a + BigInt(h.amount || 0), 0n);
  els.histTotal.textContent = `${total.toLocaleString('en-US')} FOLD`;
  if (!hist.length) { els.histList.innerHTML = '<p class="hint">No claims yet in this browser.</p>'; return; }
  els.histList.innerHTML = hist.map((h) => `
    <div class="hist-item">
      <div><strong>${esc(h.username)}</strong> — ${fmtScore(h.amount)} FOLD</div>
      <div class="hint">escrow <code>${short(h.escrowTxid)}</code> → claim <code>${short(h.claimTxid || '')}</code> · ${esc(h.at || '')}</div>
    </div>`).join('');
}

els.btnRefreshHist.addEventListener('click', async () => {
  if (!fah) { renderHistory(); return; }
  try {
    const r = await oracleGet(`/api/claims?username=${encodeURIComponent(fah.name)}`);
    const claims = r.claims || [];
    els.histList.innerHTML = claims.length
      ? claims.map((c) => `<div class="hist-item"><div><strong>${esc(c.username)}</strong> — ${fmtScore(c.amount || c.score)} ${c.amount ? 'FOLD' : 'points'}</div><div class="hint">escrow <code>${short(c.escrowTxid || '')}</code> · claim #${esc(c.claimIndex ?? '?')}</div></div>`).join('')
      : '<p class="hint">No claims recorded for this user at the oracle.</p>';
  } catch (e) {
    renderHistory();
  }
});

els.inUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.btnLookup.click(); });

init();
