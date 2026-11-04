import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const MAX_SECRET_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/i;

export function isGithubIntegrationConfigured(env = process.env) {
  if (!env.FELTUS_GITHUB_CLIENT_ID || !env.FELTUS_GITHUB_CLIENT_SECRET ||
      typeof env.FELTUS_SECRET_ENCRYPTION_KEY !== "string" || Buffer.byteLength(env.FELTUS_SECRET_ENCRYPTION_KEY, "utf8") < 32) return false;
  let publicUrl;
  try { publicUrl = new URL(env.FELTUS_PUBLIC_URL || ""); } catch { return false; }
  const production = String(env.FELTUS_ENV || "").toLowerCase() === "production";
  return !publicUrl.username && !publicUrl.password && !publicUrl.search && !publicUrl.hash &&
    (production ? publicUrl.protocol === "https:" : ["http:", "https:"].includes(publicUrl.protocol));
}

function deriveKey(masterKey, purpose) {
  if (typeof masterKey !== "string" || Buffer.byteLength(masterKey, "utf8") < 32) {
    throw new TypeError("FELTUS_SECRET_ENCRYPTION_KEY must contain at least 32 bytes.");
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "utf8"), Buffer.from("feltus-labs", "utf8"), Buffer.from(purpose, "utf8"), 32));
}

export function encryptGithubSecret(value, masterKey, purpose = "github-secret:v1") {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new TypeError("GitHub secret is missing or too large.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const envelope = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  return `\\x${envelope.toString("hex")}`;
}

export function decryptGithubSecret(value, masterKey, purpose = "github-secret:v1") {
  let envelope;
  if (Buffer.isBuffer(value)) envelope = value;
  else if (value && typeof value === "object" && Array.isArray(value.data)) envelope = Buffer.from(value.data);
  else if (typeof value === "string") {
    const encoded = value.startsWith("\\x") ? value.slice(2) : value.startsWith("0x") ? value.slice(2) : value;
    if (!/^(?:[0-9a-f]{2})+$/i.test(encoded)) throw new TypeError("Stored GitHub secret has an invalid encoding.");
    envelope = Buffer.from(encoded, "hex");
  } else throw new TypeError("Stored GitHub secret is unavailable.");

  if (envelope.length < 30 || envelope[0] !== 1) throw new TypeError("Stored GitHub secret has an unsupported format.");
  const iv = envelope.subarray(1, 13);
  const tag = envelope.subarray(13, 29);
  const ciphertext = envelope.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey, purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function createGithubOAuthState({ appId, userId, masterKey, now = Date.now(), ttlMs = 10 * 60_000 } = {}) {
  if (!UUID.test(String(appId || "")) || !UUID.test(String(userId || ""))) throw new TypeError("GitHub authorization requires a valid app and user.");
  if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 10 * 60_000) throw new TypeError("GitHub authorization lifetime is invalid.");
  const nonce = randomBytes(32).toString("base64url");
  const claims = { app_id: appId, user_id: userId, nonce, issued_at: now, expires_at: now + ttlMs };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", deriveKey(masterKey, "github-oauth-state:v1")).update(payload).digest("base64url");
  return { state: `${payload}.${signature}`, nonce };
}

export function verifyGithubOAuthState(state, cookieNonce, { masterKey, userId, now = Date.now() } = {}) {
  if (typeof state !== "string" || typeof cookieNonce !== "string") throw new TypeError("GitHub authorization state is invalid or expired.");
  const parts = state.split(".");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new TypeError("GitHub authorization state is invalid or expired.");
  const expected = createHmac("sha256", deriveKey(masterKey, "github-oauth-state:v1")).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], "base64url"); } catch { throw new TypeError("GitHub authorization state is invalid or expired."); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new TypeError("GitHub authorization state is invalid or expired.");
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { throw new TypeError("GitHub authorization state is invalid or expired."); }
  if (!UUID.test(String(claims?.app_id || "")) || claims.user_id !== userId ||
      typeof claims.nonce !== "string" || claims.nonce.length < 32 || claims.nonce !== cookieNonce ||
      !Number.isFinite(claims.issued_at) || !Number.isFinite(claims.expires_at) ||
      claims.issued_at > now + 60_000 || claims.expires_at <= now || claims.expires_at - claims.issued_at > 10 * 60_000) {
    throw new TypeError("GitHub authorization state is invalid or expired.");
  }
  return { app_id: claims.app_id, user_id: claims.user_id };
}

export function verifyGithubWebhookSignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signatureHeader !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader) ||
      typeof secret !== "string" || !secret.length) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(signatureHeader.slice(7), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function parseGithubWebhookEvent(eventName, payload) {
  const event = String(eventName || "").trim().toLowerCase();
  if (!/^[a-z_]{1,64}$/.test(event) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("GitHub webhook event is invalid.");
  }

  if (event === "push") {
    const fullRef = typeof payload.ref === "string" ? payload.ref : "";
    const isBranch = fullRef.startsWith("refs/heads/");
    const isTag = fullRef.startsWith("refs/tags/");
    const ref = isBranch
      ? fullRef.slice("refs/heads/".length)
      : isTag ? fullRef.slice("refs/tags/".length) : "";
    const branch = normalizeGithubBranch(ref);
    const sha = typeof payload.after === "string" && !/^0+$/.test(payload.after) && COMMIT_SHA.test(payload.after) ? payload.after.toLowerCase() : null;
    const deleted = payload.deleted === true || (typeof payload.after === "string" && /^0+$/.test(payload.after));
    if (!branch || (!sha && !deleted) || (!isBranch && !isTag)) throw new TypeError("GitHub push event is missing a valid branch, tag, or commit.");
    return {
      event_name: event,
      action_name: isTag ? (deleted ? "tag_delete" : "tag_push") : null,
      branch_name: isBranch ? branch : null,
      commit_sha: deleted ? null : sha,
      pull_request_number: null
    };
  }

  if (event === "pull_request") {
    const action = String(payload.action || "").trim().toLowerCase();
    const pull = payload.pull_request;
    const branch = normalizeGithubBranch(pull?.head?.ref);
    const sha = typeof pull?.head?.sha === "string" && COMMIT_SHA.test(pull.head.sha) ? pull.head.sha.toLowerCase() : null;
    const number = Number(payload.number);
    if (!/^[a-z_]{1,64}$/.test(action) || !branch || !sha || !Number.isSafeInteger(number) || number < 1) {
      throw new TypeError("GitHub pull request event is missing a valid branch, commit, action, or number.");
    }
    return { event_name: event, action_name: action, branch_name: branch, commit_sha: sha, pull_request_number: number };
  }

  const action = payload.action === undefined ? null : String(payload.action).trim().toLowerCase().slice(0, 64);
  return { event_name: event, action_name: action, branch_name: null, commit_sha: null, pull_request_number: null };
}

export function normalizeGithubBranch(value) {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  const components = branch.split("/");
  if (!branch || branch.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      branch.includes("..") || branch.includes("//") || branch.includes("@{") ||
      branch.endsWith("/") || branch.endsWith(".") || branch === "@" ||
      components.some(component => !component || component.startsWith(".") || component.endsWith(".lock"))) return null;
  return branch;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
