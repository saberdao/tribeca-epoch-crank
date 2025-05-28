import bs58 from "bs58";
import throat from "throat";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { parsers } from "./helpers/parsers";
import {
  findEpochGaugeAddress,
  findGaugeAddress,
  GaugeData,
  GaugeSDK,
} from "@quarryprotocol/gauge";
import { SolanaProvider, TransactionEnvelope } from "@saberhq/solana-contrib";
import { chunk } from "lodash";
import { sendTransactionWithRetry } from "./helpers/transaction";
import {
  findQuarryAddress,
  findRegistryAddress,
  QuarryData,
  QuarrySDK,
} from "@quarryprotocol/quarry-sdk";

const gaugemeisterKey = new PublicKey(
  "28ZDtf6d2wsYhBvabTxUHTRT6MDxqjmqR7RMCp348tyU"
);
const rewarderKey = new PublicKey(
  "rXhAofQCT7NN9TUqigyEAUzV1uLL4boeD8CRkNBSkYk"
);

const getProvider = (wallet: Keypair, connection: Connection) => {
  const anchorWallet = {
    publicKey: wallet.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T
    ) => {
      if (tx instanceof VersionedTransaction) {
        tx.sign([wallet]);
        return tx;
      }
      return tx;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[]
    ) => {
      txs.map((tx) => {
        if (tx instanceof VersionedTransaction) {
          return tx.sign([wallet]);
        }
        return tx.sign(wallet);
      });
      return txs;
    },
  };

  const provider = SolanaProvider.init({
    connection,
    wallet: anchorWallet,
  });
  return provider;
};

const run = async () => {
  const connection = new Connection(process.env.RPC_URL!);
  const pk = process.env.BOT_PK;
  if (!pk) {
    throw new Error("BOT_PK is not set");
  }

  const secret = bs58.decode(pk);
  const wallet = Keypair.fromSecretKey(secret);

  const gaugemeister = await connection.getAccountInfo(gaugemeisterKey);
  if (!gaugemeister) {
    console.log("no gaugemeister");
    return;
  }

  const gm = parsers.gaugemeister(gaugemeister.data);

  const nextEpochStartsAt = gm.nextEpochStartsAt.toNumber();
  if (nextEpochStartsAt > Date.now() / 1000) {
    console.log("Next epoch not yet started");
    return;
  }

  // Trigger next epoch
  const provider = getProvider(wallet, connection);
  const gaugeSDK = GaugeSDK.load({
    provider,
  });
  const triggerTX = gaugeSDK.gauge.triggerNextEpoch({
    gaugemeister: gaugemeisterKey,
  });

  const tx = await sendTransactionWithRetry(
    connection,
    triggerTX.instructions,
    [wallet],
    wallet
  );
  console.log(tx);
  process.exit();
};

run();
