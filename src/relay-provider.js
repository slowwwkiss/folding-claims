// RelayProvider — a CashScript NetworkProvider for the browser.
// Broadcast goes through the oracle's /api/broadcast relay (the tx is fully
// signed before it leaves the browser, so the relay cannot alter it).
// Reads go through /api/tx/:txid. UTXO fetching is not supported: the claim
// flow always passes explicit UTXOs.
export class RelayProvider {
  network = 'chipnet';
  constructor(oracleUrl) {
    this.oracleUrl = oracleUrl.replace(/\/$/, '');
  }

  async getUtxos(_address) {
    throw new Error('RelayProvider.getUtxos: not supported — pass explicit UTXOs.');
  }

  async getUtxosForLockingBytecode(_lockingBytecode) {
    throw new Error('RelayProvider.getUtxosForLockingBytecode: not supported — pass explicit UTXOs.');
  }

  async getBlockHeight() {
    return 0; // not used by the claim flow (no locktimes)
  }

  async getRawTransaction(txid) {
    const res = await fetch(`${this.oracleUrl}/api/tx/${txid}`);
    if (!res.ok) throw new Error(`tx ${txid} not found (HTTP ${res.status})`);
    const j = await res.json();
    if (!j.hex) throw new Error(`tx ${txid}: no hex in oracle response`);
    return j.hex;
  }

  async sendRawTransaction(txHex) {
    const res = await fetch(`${this.oracleUrl}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHex }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.txid) throw new Error(j.error || `broadcast failed (HTTP ${res.status})`);
    return j.txid;
  }
}
