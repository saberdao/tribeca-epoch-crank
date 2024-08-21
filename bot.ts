import bs58 from 'bs58';
import throat from 'throat';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { parsers } from "./helpers/parsers";
import { findEpochGaugeAddress, findGaugeAddress, GaugeData, GaugeSDK } from "@quarryprotocol/gauge";
import { SolanaProvider, TransactionEnvelope } from "@saberhq/solana-contrib";
import { chunk } from 'lodash';
import { sendTransactionWithRetry } from './helpers/transaction';
import { findQuarryAddress, findRegistryAddress, QuarryData, QuarrySDK } from '@quarryprotocol/quarry-sdk';

const gaugemeisterKey = new PublicKey('28ZDtf6d2wsYhBvabTxUHTRT6MDxqjmqR7RMCp348tyU')
const rewarderKey = new PublicKey('rXhAofQCT7NN9TUqigyEAUzV1uLL4boeD8CRkNBSkYk')

const getProvider = (wallet: Keypair, connection: Connection) => {
    const anchorWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => {
            if (tx instanceof VersionedTransaction) {
                tx.sign([wallet]);
                return tx;
            }
            return tx;
        },
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
            txs.map(tx => {
                if (tx instanceof VersionedTransaction) {
                    return tx.sign([wallet]);
                }
                return tx.sign(wallet)
            });
            return txs;
        },
    };

    const provider = SolanaProvider.init({
        connection,
        wallet: anchorWallet,
    });
    return provider;
}

const run = async () => {
    const connection = new Connection(process.env.RPC_URL!);
    const pk = process.env.BOT_PK;
    if (!pk) {
        throw new Error('BOT_PK is not set');
    }

    const secret = bs58.decode(pk);
    const wallet = Keypair.fromSecretKey(secret);

    const gaugemeister = await connection.getAccountInfo(gaugemeisterKey)
    if (!gaugemeister) {
        console.log('no gaugemeister')
        return
    }

    const gm = parsers.gaugemeister(gaugemeister.data)

    const nextEpochStartsAt = gm.nextEpochStartsAt.toNumber();
    if (nextEpochStartsAt > Date.now() / 1000) {
        console.log('Next epoch not yet started');
        return
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
        wallet,
    )
    console.log(tx)

    // Sync rewards
    const registryInfo = await connection.getAccountInfo((await findRegistryAddress(rewarderKey))[0])
    if (!registryInfo) {
        throw new Error('Registry not found')
    }
    const registry = parsers.registry(registryInfo.data)
    

    const rewarderConfig = await (await fetch(`https://raw.githubusercontent.com/QuarryProtocol/rewarder-list-build/master/mainnet-beta/rewarders/rXhAofQCT7NN9TUqigyEAUzV1uLL4boeD8CRkNBSkYk/full.json`)).json();
    const configMints: PublicKey[] = rewarderConfig?.quarries.map((q: any) => new PublicKey(q.stakedToken.mint));

    const mintsMinusConfig = [
      ...registry?.tokens ?? []
    ];
    const allStakedTokenMints = [
      ...mintsMinusConfig,
      ...(configMints ?? []).filter(
        (m) => !mintsMinusConfig.find((k) => k.equals(m))
      ),
    ];

    const gaugeKeys = await Promise.all(
        allStakedTokenMints.map(throat(2, async (stakedTokenMint) => {
          const [quarryKey] = await findQuarryAddress(
            rewarderKey,
            stakedTokenMint
          );
          const [key] = await findGaugeAddress(gaugemeisterKey, quarryKey);
          return key;
        }) ?? []
    ));
    const gaugeData: (GaugeData | null)[] =
      (await gaugeSDK.programs.Gauge.account.gauge.fetchMultiple(
        gaugeKeys
      )) as (GaugeData | null)[];

    const gmData = await gaugeSDK.gauge.fetchGaugemeister(gaugemeisterKey);
    if (!gmData) {
      throw new Error("gaugemeister data not found");
    }
    const syncTXs = (await Promise.all(
      gaugeKeys.map(throat(2, async (gauge, i) => {
        if (!gaugeData[i]) {
          return null;
        }
        const [epochGauge] = await findEpochGaugeAddress(
          gauge,
          gmData.currentRewardsEpoch
        );
        // skip over null epochs
        if (!(await gaugeSDK.provider.connection.getAccountInfo(epochGauge))) {
          return null;
        }
        return await gaugeSDK.gauge.syncGauge({ gauge });
      }) ?? []
    ))).filter(Boolean);

    console.log(syncTXs);
    
    const tx1 = await Promise.all(syncTXs.map(throat(2, syncTX => sendTransactionWithRetry(
        connection,
        syncTX?.instructions ?? [],
        [wallet],
        wallet,
    ))));

    console.log(tx1);

    if (!tx1) {
      return;
    }

    const quarrySDK = QuarrySDK.load({ provider });
    const rewarderW = await quarrySDK.mine.loadRewarderWrapper(gmData.rewarder);

    const quarryData: QuarryData[] =
      (await quarrySDK.programs.Mine.account.quarry.fetchMultiple(
        gaugeData.filter((g): g is GaugeData => !!g).map((g) => g.quarry)
      )) as QuarryData[];

    const quarrySyncTXs = await Promise.all(
      chunk(
        quarryData.map((q) => q.tokenMintKey),
        10
      ).map(throat(2, async (mints) => {
        return await rewarderW.syncQuarryRewards(mints);
      }))
    );

    const tx2 = await Promise.all(quarrySyncTXs.map(throat(2, syncTX => sendTransactionWithRetry(
      connection,
      syncTX?.instructions ?? [],
      [wallet],
      wallet,
    ))));

    console.log(tx2);
    process.exit()
};

run();