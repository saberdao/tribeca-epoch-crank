import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, PublicKey, Signer, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const getCUsForTx = async (
    connection: Connection,
    latestBlockhash: Awaited<ReturnType<typeof connection.getLatestBlockhash>>,
    txs: TransactionInstruction[],
    payerKey: PublicKey,
    retryNum = 0,
) => {
    const messageV0 = new TransactionMessage({
        payerKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: txs,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    // replaceRecentBlockhash lets the RPC use its own current blockhash for sim,
    // so simulation never fails with BlockhashNotFound regardless of how stale
    // our blockhash is. sigVerify must be false to allow the unsigned tx.
    const simulation = await connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: true,
        sigVerify: false,
    });
    if (simulation.value.err) {
        console.log('Simulation error:', simulation.value.err);
        console.log('Simulation logs:', simulation.value.logs);
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    if (simulation.value.unitsConsumed === 0 || simulation.value.unitsConsumed == null) {
        if (retryNum >= 10) {
            console.log('Sim returned 0 CUs after retries, falling back to 1.4M');
            return 1.4e6;
        }
        console.log('CU zero, retrying...', retryNum);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return getCUsForTx(connection, latestBlockhash, txs, payerKey, retryNum + 1);
    }
    return simulation.value.unitsConsumed;
};

export const createVersionedTransaction = async (
    connection: Connection,
    txs: TransactionInstruction[],
    payerKey: PublicKey,
    addCUs: boolean,
    luts?: AddressLookupTableAccount[],
) => {
    const latestBlockhash = await connection.getLatestBlockhash('finalized');
    const CUs = await getCUsForTx(connection, latestBlockhash, txs, payerKey);
    console.log('CUs:', CUs);

    if (addCUs) {
        txs.unshift(ComputeBudgetProgram.setComputeUnitLimit({
            units: Math.round(CUs * 2) + 50000, // +1000 for safety and the CU limit ix itself
        }));

        const priorityFee = (0.0001 || 0) * LAMPORTS_PER_SOL * 1e6;
        txs.unshift(ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.ceil(priorityFee / (CUs)),
        }))
    }
    
    const messageV0 = new TransactionMessage({
        payerKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: txs,
    }).compileToV0Message(luts);
    const transaction = new VersionedTransaction(messageV0);
    return { transaction, latestBlockhash };
};

export const sendTransactionWithRetry = async (
    connection: Connection,
    txs: TransactionInstruction[],
    allSigners: Signer[],
    payerKey: Signer,
    luts?: AddressLookupTableAccount[],
    retryNum = 0,
): Promise<string | undefined> => {
    const vt = await createVersionedTransaction(connection, txs, payerKey.publicKey, retryNum === 0, luts);
    // Filter only the required signers
    const signerPubkeys = vt.transaction.message.staticAccountKeys.slice(
        0,
        vt.transaction.message.header.numRequiredSignatures,
    ).map(p => p.toString());

    const signers = allSigners.filter((s) => signerPubkeys.includes(s.publicKey.toString()));
    vt.transaction.sign([payerKey, ...signers]);

    try {
        const hash = await Promise.race([
            (async () => {
                const hash = await connection.sendTransaction(vt.transaction);
                await connection.confirmTransaction({
                    signature: hash,
                    ...vt.latestBlockhash,
                }, 'processed');
                return hash;
            })(),
            (async () => {
                await new Promise((resolve) => setTimeout(resolve, 120000));
                throw Error('Timeout');
            })(),
        ]);
        return hash;
    } catch (e: any) {
        console.log(e.message)
        const conditions = ['Timeout', 'Blockhash not found', 'block height exceeded'];
        if (conditions.some(condition => e.message.includes(condition) && retryNum < 100)) {
            console.log('Retrying...', retryNum, '-', e.message);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return sendTransactionWithRetry(connection, txs, allSigners, payerKey, luts, retryNum + 1);
        } else {
            console.log('TX failed. Retrying up to 10 times...',retryNum,' / 10');
            console.log(Buffer.from(vt.transaction.serialize()).toString('base64'));
            if (retryNum < 10) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                return sendTransactionWithRetry(connection, txs, allSigners, payerKey, luts, retryNum + 1);
            }
            throw e;
        }
    }
};
