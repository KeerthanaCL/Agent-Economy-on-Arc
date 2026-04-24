/**
 * Quick utility: print the agent's wallet + Gateway USDC balances.
 *   npm run balance
 */
import { getAgentPrivateKey } from "./env.js";
import { GatewayClient } from "@circle-fin/x402-batching/client";

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: getAgentPrivateKey(),
  rpcUrl: process.env.ARC_RPC_URL,
});

const b = await client.getBalances();
console.log(`Agent:        ${client.address}`);
console.log(`Wallet USDC:  ${b.wallet.formatted}`);
console.log(`Gateway total: ${b.gateway.formattedTotal}`);
console.log(`  available:   ${b.gateway.formattedAvailable}`);
console.log(`  withdrawing: ${b.gateway.formattedWithdrawing}`);
console.log(`  withdrawable: ${b.gateway.formattedWithdrawable}`);
