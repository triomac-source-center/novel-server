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
