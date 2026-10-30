import dns from "node:dns/promises";
import { isIP } from "node:net";

export const AI_ENDPOINT_TRUST_LEVELS = Object.freeze([
  "local_private",
  "private_managed",
  "external_trusted",
  "external_unverified"
]);

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export function parseAIConfigBoolean(value, name, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

function isPrivateIPv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127;
}

function isPrivateIPv6(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::1") return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00;
}

function isLoopbackAddress(address) {
  const version = isIP(address);
  if (version === 4) return address.startsWith("127.");
  if (version === 6) {
    const value = address.toLowerCase().split("%")[0];
    if (value === "::1") return true;
    if (value.startsWith("::ffff:")) {
      const mapped = value.slice(7);
      return isIP(mapped) === 4 && mapped.startsWith("127.");
    }
  }
  return false;
}

export function isApprovedPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return false;
}

function endpointFromEnv(env) {
  return String(
    env.FELTUS_AI_ENDPOINT ||
    env.FELTUS_AI_BASE_URL ||
    env.FELTUS_OLLAMA_URL ||
    (env.FELTUS_ENV === "production" ? "" : "http://127.0.0.1:11434")
  ).trim();
}

function configuredHostSet(value) {
  return new Set(String(value || "")
    .split(",")
    .map(host => host.trim().toLowerCase().replace(/^\[|\]$/g, ""))
    .filter(Boolean));
}

export async function resolveAIEndpointPolicy(env = process.env, { lookup = dns.lookup } = {}) {
  const endpoint = endpointFromEnv(env);
  if (!endpoint) throw new Error("AI endpoint is not configured.");

  const trust = String(
    env.FELTUS_AI_ENDPOINT_TRUST ||
    (env.FELTUS_ENV === "production" ? "external_unverified" : "local_private")
  ).trim().toLowerCase();
  if (!AI_ENDPOINT_TRUST_LEVELS.includes(trust)) {
    throw new Error("FELTUS_AI_ENDPOINT_TRUST is not a supported trust classification.");
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("FELTUS_AI_ENDPOINT must be a valid absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("FELTUS_AI_ENDPOINT must use HTTP(S) and cannot contain credentials or a fragment.");
  }
  if (url.search) throw new Error("FELTUS_AI_ENDPOINT cannot contain a query string.");
  url.pathname = url.pathname.replace(/\/+$/, "");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literalIP = isIP(host);
  const loopback = host === "localhost" || isLoopbackAddress(host);
  let privateDestination = false;

  if (literalIP) {
    privateDestination = isApprovedPrivateAddress(host);
  } else {
    let addresses;
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error("FELTUS_AI_ENDPOINT hostname could not be resolved.");
    }
    privateDestination = Array.isArray(addresses) && addresses.length > 0 &&
      addresses.every(entry => isApprovedPrivateAddress(entry.address));
    if (host === "localhost") {
      privateDestination = Array.isArray(addresses) && addresses.length > 0 &&
        addresses.every(entry => isLoopbackAddress(entry.address));
    }
  }

  if ((trust === "local_private" || trust === "private_managed") && !privateDestination) {
    throw new Error(`${trust} AI endpoints must resolve only to loopback or private network addresses.`);
  }
  if (trust === "local_private" || trust === "private_managed") {
    const allowedPrivateHosts = configuredHostSet(env.FELTUS_AI_ALLOWED_PRIVATE_HOSTS);
    if (!loopback && !allowedPrivateHosts.has(host)) {
      throw new Error("Non-loopback private AI endpoints must be listed in FELTUS_AI_ALLOWED_PRIVATE_HOSTS.");
    }
  }
  if (trust === "external_trusted") {
    const trustedHosts = configuredHostSet(env.FELTUS_AI_TRUSTED_HOSTS);
    if (!trustedHosts.has(host)) {
      throw new Error("external_trusted endpoints must be listed in FELTUS_AI_TRUSTED_HOSTS.");
    }
  }
  if (!privateDestination && url.protocol !== "https:") {
    throw new Error("Non-private AI endpoints must use HTTPS.");
  }

  const maxHistoryMessages = Number(env.FELTUS_AI_MAX_HISTORY_MESSAGES || 20);
  if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages < 1 || maxHistoryMessages > 20) {
    throw new Error("FELTUS_AI_MAX_HISTORY_MESSAGES must be an integer from 1 to 20.");
  }

  const sendHistoryConfigured = parseAIConfigBoolean(
    env.FELTUS_AI_SEND_HISTORY,
    "FELTUS_AI_SEND_HISTORY",
    false
  );
  const sendProjectContextConfigured = parseAIConfigBoolean(
    env.FELTUS_AI_SEND_PROJECT_CONTEXT,
    "FELTUS_AI_SEND_PROJECT_CONTEXT",
    trust === "local_private" || trust === "private_managed"
  );

  return Object.freeze({
    endpoint: url.toString().replace(/\/$/, ""),
    trust,
    maxHistoryMessages,
    sendHistory: sendHistoryConfigured && trust !== "external_unverified",
    sendProjectContext: sendProjectContextConfigured
  });
}
