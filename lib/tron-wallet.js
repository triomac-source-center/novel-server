import * as bip39 from "bip39";
import ethereumjsWallet from "ethereumjs-wallet";
import * as TronWebModule from "tronweb";

// The installed ethereumjs-wallet (v1.0.2, CJS) doesn't expose `hdkey` as a static-analyzable
// named ESM export — it only shows up nested under the default export.
const { hdkey } = ethereumjsWallet;

// tronweb's published shape varies: the named `TronWeb` export is the actual constructor; the
// `default` export is a namespace object (NOT constructible on its own) that happens to also
// carry a `.TronWeb` property. Pick whichever candidate is actually a function, in that order —
// checked against tronweb@6.4.0 (what's installed here), but this stays correct regardless of
// which of these three shapes a given version uses.
const TronWeb = [TronWebModule.TronWeb, TronWebModule.default?.TronWeb, TronWebModule.default].find(
  (candidate) => typeof candidate === "function"
);
if (!TronWeb) throw new Error("Could not locate the TronWeb constructor in the installed tronweb package");

const DERIVATION_BASE_PATH = "m/44'/195'/0'/0";
const TRON_FULL_HOST = process.env.TRON_FULL_HOST || "https://nile.trongrid.io";

function getSeedPhrase() {
  const seedPhrase = process.env.SEED_PHRASE;
  if (!seedPhrase) throw new Error("SEED_PHRASE environment variable is not set");
  return seedPhrase;
}

// Derives the TRON account at m/44'/195'/0'/0/{index} from the root seed phrase. The private key
// only ever exists in memory for the duration of this call — it is NEVER persisted anywhere. It
// is always re-derivable later from SEED_PHRASE + the same index, which is why only `address` and
// `derivationIndex` get saved to the database (see DepositAddress).
export function deriveTronAccount(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("index must be a non-negative integer");
  }

  const seed = bip39.mnemonicToSeedSync(getSeedPhrase());
  const root = hdkey.fromMasterSeed(seed);
  const child = root.derivePath(`${DERIVATION_BASE_PATH}/${index}`);
  const privateKey = child.getWallet().getPrivateKeyString().replace(/^0x/, "");

  const tronWeb = new TronWeb({ fullHost: TRON_FULL_HOST });
  const address = tronWeb.address.fromPrivateKey(privateKey);

  return { address, privateKey };
}

// Index 0 on this same derivation path is permanently reserved for the consolidated hot wallet —
// getNextDerivationIndex() (lib/deposit-index-service.js) never hands this index out to a user.
export const HOT_WALLET_INDEX = 0;

const readOnlyTronWeb = new TronWeb({ fullHost: TRON_FULL_HOST });

export async function getTrxBalance(address) {
  const sun = await readOnlyTronWeb.trx.getBalance(address);
  return sun / 1_000_000;
}

async function getTrc20Contract(tronWeb, contractAddress) {
  return tronWeb.contract().at(contractAddress);
}

export async function getTrc20Balance(address, contractAddress) {
  const contract = await getTrc20Contract(readOnlyTronWeb, contractAddress);
  // A TronWeb instance with no address/privateKey of its own needs an explicit `from` context for
  // contract read calls (TronWeb quirk: "owner_address isn't set" otherwise) — the address whose
  // balance we're reading is a fine stand-in, it's a read-only call either way.
  const [rawBalance, decimals] = await Promise.all([
    contract.balanceOf(address).call({ from: address }),
    contract.decimals().call({ from: address }),
  ]);
  return Number(rawBalance) / 10 ** Number(decimals);
}

// Raw (smallest-unit) balance, with no decimals conversion — used when sweeping, so the exact
// on-chain integer balance is sent with zero floating-point round-trip risk, instead of converting
// to a human-readable amount and back.
export async function getTrc20RawBalance(address, contractAddress) {
  const contract = await getTrc20Contract(readOnlyTronWeb, contractAddress);
  const rawBalance = await contract.balanceOf(address).call({ from: address });
  return rawBalance.toString();
}

// TronWeb's own base58-check validity check (rejects malformed checksums, wrong prefix byte,
// wrong length) instead of a hand-rolled regex that would only catch shape, not validity.
export function isValidTronAddress(address) {
  if (typeof address !== "string" || !address) return false;
  return readOnlyTronWeb.isAddress(address);
}

// decimals() is immutable contract metadata (set once at deploy time), so it's safe to cache per
// contract address for the lifetime of the process instead of re-fetching on every withdrawal.
const decimalsCache = new Map();

async function getTrc20Decimals(contractAddress) {
  if (decimalsCache.has(contractAddress)) return decimalsCache.get(contractAddress);
  const contract = await getTrc20Contract(readOnlyTronWeb, contractAddress);
  const decimals = Number(await contract.decimals().call({ from: contractAddress }));
  decimalsCache.set(contractAddress, decimals);
  return decimals;
}

// Converts a human-readable amount (e.g. 12.5 USDT) into the token's smallest-unit integer string
// expected by sendTrc20 — mirrors the raw-balance approach already used for sweeps, to avoid the
// same floating-point round-trip risk on the withdrawal side.
export async function toRawTrc20Amount(humanAmount, contractAddress) {
  const decimals = await getTrc20Decimals(contractAddress);
  const raw = BigInt(Math.round(humanAmount * 10 ** decimals));
  return raw.toString();
}

// Sends native TRX from the given private key's account. Returns the broadcast txid — the caller
// decides whether/how long to wait for confirmation via waitForConfirmation() below.
export async function sendTrx(fromPrivateKey, toAddress, amountTrx) {
  const tronWeb = new TronWeb({ fullHost: TRON_FULL_HOST, privateKey: fromPrivateKey });
  const result = await tronWeb.trx.sendTransaction(toAddress, Math.round(amountTrx * 1_000_000));
  if (!result?.result) throw new Error(`TRX transfer broadcast failed: ${JSON.stringify(result)}`);
  return result.txid;
}

// Sends the given amount (already in the token's smallest unit, e.g. 6-decimal USDT) of a TRC20
// token from the given private key's account.
export async function sendTrc20(fromPrivateKey, toAddress, contractAddress, rawAmount) {
  const tronWeb = new TronWeb({ fullHost: TRON_FULL_HOST, privateKey: fromPrivateKey });
  const contract = await getTrc20Contract(tronWeb, contractAddress);
  const txid = await contract.transfer(toAddress, rawAmount).send({ shouldPollResponse: false });
  return txid;
}

// One-shot lookup, no polling — exposed separately from waitForConfirmation so a caller that
// already knows a specific txid (because it just broadcast it) can do a single direct check
// instead of a fresh multi-attempt poll when waitForConfirmation's own poll window times out.
export async function getTransactionInfo(txid) {
  return readOnlyTronWeb.trx.getTransactionInfo(txid);
}

// Polls until a transaction is mined. For a plain TRX transfer, being mined is enough. For a
// contract call (TRC20 transfer), a transaction can be mined but still REVERT (e.g. it ran out of
// energy/bandwidth) — pass requireContractSuccess to also check receipt.result === "SUCCESS".
export async function waitForConfirmation(txid, { timeoutMs = 60_000, intervalMs = 3_000, requireContractSuccess = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readOnlyTronWeb.trx.getTransactionInfo(txid);
    if (info && info.id) {
      if (requireContractSuccess && info.receipt?.result !== "SUCCESS") {
        throw new Error(`Transaction ${txid} was mined but reverted (receipt.result=${info.receipt?.result})`);
      }
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for confirmation of ${txid}`);
}
