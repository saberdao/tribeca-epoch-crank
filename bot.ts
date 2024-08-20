import { Connection } from "@solana/web3.js";

const run = async () => {
    const connection = new Connection(process.env.RPC_URL!);
    
    const slot = await connection.getSlot();
    console.log(slot);
};

run();