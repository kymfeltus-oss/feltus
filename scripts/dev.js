import dotenv from "dotenv";
import { spawnSync } from "node:child_process";

dotenv.config();

if (process.env.NODE_ENV === "production") {
  throw new Error("npm run dev cannot run with NODE_ENV=production.");
}

process.env.FELTUS_ENV = "development";
process.env.NODE_ENV = "development";
process.env.FELTUS_LOCAL_DEV_MODE = "1";
process.env.FELTUS_HOST = "127.0.0.1";

const localPort = process.env.FELTUS_PORT || "8080";
process.env.FELTUS_PUBLIC_URL = `http://127.0.0.1:${localPort}`;
process.env.FELTUS_ALLOWED_ORIGINS = [
  `http://127.0.0.1:${localPort}`,
  `http://localhost:${localPort}`
].join(",");
process.env.FELTUS_STORAGE_ROOT =
  process.env.FELTUS_LOCAL_STORAGE_ROOT || ".feltus-storage";
process.env.FELTUS_GATEWAY_URL =
  process.env.FELTUS_LOCAL_GATEWAY_URL ||
  "http://127.0.0.1:54321";
process.env.FELTUS_AI_ENDPOINT =
  process.env.FELTUS_AI_ENDPOINT ||
  process.env.FELTUS_LOCAL_AI_BASE_URL ||
  process.env.FELTUS_AI_BASE_URL ||
  "http://127.0.0.1:11434";
process.env.FELTUS_AI_ENDPOINT_TRUST =
  process.env.FELTUS_AI_ENDPOINT_TRUST ||
  "local_private";
process.env.FELTUS_AI_SEND_HISTORY =
  process.env.FELTUS_AI_SEND_HISTORY ||
  "false";
process.env.FELTUS_AI_SEND_PROJECT_CONTEXT =
  process.env.FELTUS_AI_SEND_PROJECT_CONTEXT ||
  "true";
process.env.FELTUS_AI_MAX_HISTORY_MESSAGES =
  process.env.FELTUS_AI_MAX_HISTORY_MESSAGES ||
  "20";

let localPublishableKey = process.env.FELTUS_LOCAL_PUBLISHABLE_KEY || "";

if (!localPublishableKey) {
  const status = spawnSync(
    "supabase",
    ["status", "-o", "env"],
    {
      encoding: "utf8",
      windowsHide: true
    }
  );

  if (status.status === 0) {
    const match = status.stdout.match(
      /^(?:PUBLISHABLE_KEY|ANON_KEY)=(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/m
    );

    localPublishableKey = match?.[1] || match?.[2] || match?.[3]?.trim() || "";
  }
}

process.env.FELTUS_PUBLISHABLE_KEY = localPublishableKey;
process.env.FELTUS_API_KEY = "";

await import("../src/server.js");
