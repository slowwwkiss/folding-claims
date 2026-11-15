// RestProvider — a CashScript NetworkProvider backed by the mainnet-js REST
// server (rest-unstable.mainnet.cash, chipnet). The VM blocks Electrum over
// WebSocket and raw TCP, so this is the only chain-access path that works here.
//
// What it can do:
//   - sendRawTransaction(txHex): POST /wallet/submit_transaction (needs any
//     mainnet-js walletId as the broadcaster identity; the tx itself is fully
//     signed already, so the walletId spends nothing).
//   - getRawTransaction(txid): POST /wallet/util/get_raw_transaction.
//   - getBlockHeight(): best-effort (not used by the claim flow — no locktimes).
// What it CANNOT do (REST server has no address-scoped UTXO endpoint):
//   - getUtxos(address) / getUtxosForLockingBytecode(): the claim flow always
//     passes explicit UTXOs, so these are never called. They throw honestly.
import { restPost } from './claim-lib.mjs';

export class RestProvider {
  network = 'chipnet';
  constructor(walletId) {
    this.walletId = walletId;
  }

  async getUtxos(_address) {
    throw new Error(
      'RestProvider.getUtxos: the mainnet-js REST server has no address-scoped UTXO endpoint. Pass explicit UTXOs to the TransactionBuilder.',
    );
  }

  async getUtxosForLockingBytecode(_lockingBytecode) {
    throw new Error(
      'RestProvider.getUtxosForLockingBytecode: not supported by the REST server. Pass explicit UTXOs.',
    );
  }

  async getBlockHeight() {
    // Not used by the claim flow (no locktimes). Best effort via the faucet
    // tx trick is unnecessary; return the height of the last known block if
    // cached, else 0. Callers that need a real height should use an explorer.
    if (this._height) return this._height;
    return 0;
  }

  async getRawTransaction(txid) {
    const r = await restPost('/wallet/util/get_raw_transaction', {
      txHash: txid,
      network: 'testnet',
      verbose: false,
    });
    if (typeof r === 'string') return r;
    if (r?.hex) return r.hex;
    throw new Error(`getRawTransaction: unexpected response for ${txid}: ${JSON.stringify(r).slice(0, 200)}`);
  }

  async getRawTransactionVerbose(txid) {
    return restPost('/wallet/util/get_raw_transaction', {
      txHash: txid,
      network: 'testnet',
      verbose: true,
    });
  }

  async sendRawTransaction(txHex) {
    const r = await restPost('/wallet/submit_transaction', {
      walletId: this.walletId,
      transactionHex: txHex,
      awaitPropagation: true,
    });
    const txid = r?.txId || r?.txid || r?.hash;
    if (!txid) {
      throw new Error(`submit_transaction: no txid in response: ${JSON.stringify(r).slice(0, 300)}`);
    }
    return txid;
  }
}
