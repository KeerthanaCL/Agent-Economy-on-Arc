import * as dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getAgentPrivateKey(): `0x${string}` {
  const raw = required("AGENT_PRIVATE_KEY").trim();
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  return hex as `0x${string}`;
}
