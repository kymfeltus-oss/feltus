import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 20_000;

function coolifyError(code, retryable) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function isPrivateHttpHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".lan")) return true;
  const family = isIP(host);
  if (family === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") ||
      host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }
  const parts = host.split(".").map(Number);
  if (family === 4 && parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return family === 0 && !host.includes(".");
}

/** A small server-side client for the Coolify v1 API. It never follows redirects. */
export function createCoolifyClient({
  baseUrl,
  apiToken,
  allowHttp = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const root = new URL(String(baseUrl || ""));
  if (!root.hostname || root.username || root.password || root.search || root.hash) {
    throw new Error("FELTUS_COOLIFY_URL must be a trusted Coolify origin without credentials or query data.");
  }
  if (root.protocol !== "https:" && !(allowHttp && root.protocol === "http:")) {
    throw new Error("FELTUS_COOLIFY_URL must use HTTPS unless explicit private-network HTTP access is enabled.");
  }
  if (root.protocol === "http:" && !isPrivateHttpHost(root.hostname)) {
    throw new Error("Unencrypted Coolify API access is limited to private-network hostnames and addresses.");
  }
  if (root.pathname !== "/" && root.pathname !== "") {
    throw new Error("FELTUS_COOLIFY_URL must be the Coolify origin without a path.");
  }
  if (!String(apiToken || "").trim()) throw new Error("FELTUS_COOLIFY_API_TOKEN is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  const apiRoot = `${root.origin}/api/v1`;

  async function request(path, { method = "GET", body, signal } = {}) {
    const controllerSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${apiRoot}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: controllerSignal
      });
    } catch (cause) {
      if (signal?.aborted) throw Object.assign(coolifyError("COOLIFY_REQUEST_ABORTED", true), { cause });
      throw Object.assign(coolifyError("COOLIFY_NETWORK_ERROR", true), { cause });
    }

    if (response.status >= 300 && response.status < 400) {
      throw coolifyError("COOLIFY_REDIRECT_BLOCKED", false);
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 ||
        response.status === 429 || response.status >= 500;
      throw coolifyError(`COOLIFY_HTTP_${response.status}`, retryable);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw coolifyError("COOLIFY_INVALID_RESPONSE", true);
    }
  }

  return Object.freeze({
    getApplication(uuid, options = {}) {
      return request(`/applications/${encodeURIComponent(uuid)}`, options);
    },
    updateApplication(uuid, body, options = {}) {
      return request(`/applications/${encodeURIComponent(uuid)}`, { ...options, method: "PATCH", body });
    },
    listApplicationDeployments(uuid, options = {}) {
      return request(`/deployments/applications/${encodeURIComponent(uuid)}?take=20`, options);
    },
    getDeployment(uuid, options = {}) {
      return request(`/deployments/${encodeURIComponent(uuid)}`, options);
    },
    async deployApplication(uuid, options = {}) {
      const query = new URLSearchParams({ uuid, cancel_previous: "queued" });
      return request(`/deploy?${query}`, { ...options, method: "POST" });
    },
    stopApplication(uuid, options = {}) {
      return request(`/applications/${encodeURIComponent(uuid)}/stop`, { ...options, method: "POST" });
    }
  });
}

export { coolifyError };
