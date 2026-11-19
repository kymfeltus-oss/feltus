import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { normalizeInfrastructureEndpoint } from "./feltus-infrastructure-contract.js";

const DNS_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 3000;
const BLOCKED_IPV4_RANGES = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]);

function ipv4Number(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const value = ipv4Number(address);
  return value !== null && !BLOCKED_IPV4_RANGES.some(([base, prefix]) => {
    const baseValue = ipv4Number(base);
    const shift = BigInt(32 - prefix);
    return (value >> shift) === (baseValue >> shift);
  });
}

function result(status, failureCode = null, httpStatus = null) {
  return {
    method: "HTTP_HEAD",
    status,
    checked_at: new Date().toISOString(),
    http_status: httpStatus,
    failure_code: failureCode
  };
}

function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Timed out."), { code: "TIMEOUT" })), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function requestPinnedEndpoint(url, address) {
  const transport = url.protocol === "https:" ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise(resolve => {
    let settled = false;
    let timer;
    let request;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      request = transport.request({
        protocol: url.protocol,
        hostname: address,
        family: 4,
        path: url.pathname,
        method: "HEAD",
        headers: {
          Accept: "*/*",
          Host: url.host,
          "User-Agent": "FELTUS-Endpoint-Check/1"
        },
        ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {})
      }, response => {
        const status = response.statusCode || null;
        response.destroy();
        finish(status !== null && status >= 200 && status < 300
          ? result("REACHABLE", null, status)
          : result("NEEDS_ATTENTION", "HTTP_RESPONSE_ERROR", status));
      });
      timer = setTimeout(() => {
        request.destroy(Object.assign(new Error("Timed out."), { code: "TIMEOUT" }));
        finish(result("UNAVAILABLE", "TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);
      request.on("error", error => finish(result(
        "UNAVAILABLE",
        error?.code === "TIMEOUT" ? "TIMEOUT" : "CONNECTION_FAILED"
      )));
      request.end();
    } catch {
      finish(result("UNAVAILABLE", "CONNECTION_FAILED"));
    }
  });
}

export async function observePublicHttpEndpoint(value, { lookup = dns.lookup } = {}) {
  let normalized;
  try {
    normalized = normalizeInfrastructureEndpoint(value);
  } catch {
    return result("NOT_CHECKED", "ENDPOINT_NOT_PUBLIC");
  }
  if (!normalized) return result("NOT_CHECKED", "ENDPOINT_NOT_PUBLIC");

  const url = new URL(normalized);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(hostname);
  if (family === 6 || hostname === "localhost" ||
      [".localhost", ".local", ".internal", ".lan", ".test", ".invalid", ".example"].some(suffix => hostname.endsWith(suffix))) {
    return result("NOT_CHECKED", "ENDPOINT_NOT_PUBLIC");
  }

  let addresses;
  if (family === 4) {
    addresses = [{ address: hostname, family: 4 }];
  } else {
    try {
      addresses = await withTimeout(lookup(hostname, { all: true, verbatim: true, family: 4 }), DNS_TIMEOUT_MS);
    } catch (error) {
      return error?.code === "ENOTFOUND"
        ? result("UNAVAILABLE", "DNS_LOOKUP_FAILED")
        : result("NOT_CHECKED", error?.code === "TIMEOUT" ? "TIMEOUT" : "DNS_LOOKUP_FAILED");
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0 ||
      addresses.some(entry => !isPublicIPv4(entry.address))) {
    return result("NOT_CHECKED", "ENDPOINT_NOT_PUBLIC");
  }
  return requestPinnedEndpoint(url, addresses[0].address);
}

export { isPublicIPv4 };
