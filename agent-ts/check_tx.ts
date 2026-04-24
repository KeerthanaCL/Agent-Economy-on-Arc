/**
 * Check the on-chain status of a transaction hash on Arc testnet.
 *   npm run check -- 0xabc...
 */
import "./env.js";
import { createPublicClient, http } from "viem";

const rpcUrl = process.env.ARC_RPC_URL ?? "https://arc-testnet.drpc.org";

const client = createPublicClient({
  transport: http(rpcUrl),
});

const hashes = process.argv.slice(2).filter((a) => a.startsWith("0x"));
if (hashes.length === 0) {
  console.log("Usage: npm run check -- <txhash> [<txhash> ...]");
  process.exit(1);
}

for (const hash of hashes) {
  try {
    const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    console.log(`\n${hash}`);
    console.log(`  status:      ${r.status}`);
    console.log(`  block:       ${r.blockNumber}`);
    console.log(`  from:        ${r.from}`);
    console.log(`  to:          ${r.to}`);
    console.log(`  gas used:    ${r.gasUsed}`);
  } catch (e: any) {
    console.log(`\n${hash}`);
    console.log(`  NOT FOUND / PENDING — ${e.shortMessage ?? e.message}`);
  }
}
