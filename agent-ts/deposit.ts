/**
 * One-off: deposit USDC from the agent wallet into Circle Gateway.
 *
 * The Gateway balance is what funds all subsequent nanopayments — without a
 * deposit, every `client.pay()` call will fail with insufficient balance.
 *
 * Usage:
 *   npm run deposit            # defaults to 1 USDC (covers ~1000 paid calls)
 *   npm run deposit -- 5       # deposit 5 USDC
 */
import { getAgentPrivateKey } from "./env.js";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const amount = process.argv[2] ?? "1";
const skipApproval = process.argv.includes("--skip-approval");
const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

console.log(`Agent address:  ${client.address}`);
console.log(`Depositing:     ${amount} USDC into Circle Gateway on Arc testnet…\n`);

const before = await client.getBalances();
console.log("BEFORE:");
console.log(`  Wallet USDC:  ${before.wallet.formatted}`);
console.log(`  Gateway:      ${before.gateway.formattedTotal} (available ${before.gateway.formattedAvailable})\n`);

const result = await client.deposit(amount, { skipApprovalCheck: skipApproval });

console.log("Deposit submitted:");
if (result.approvalTxHash) console.log(`  Approval tx:  ${result.approvalTxHash}`);
console.log(`  Deposit tx:   ${result.depositTxHash}`);
console.log(`  Amount:       ${result.formattedAmount} USDC\n`);

const after = await client.getBalances();
console.log("AFTER:");
console.log(`  Wallet USDC:  ${after.wallet.formatted}`);
console.log(`  Gateway:      ${after.gateway.formattedTotal} (available ${after.gateway.formattedAvailable})`);
console.log("\nReady. You can now run paid calls against the TS server.");
