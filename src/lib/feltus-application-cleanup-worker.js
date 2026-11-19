const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

function cleanupError(code, retryable, status = null) {
  return Object.assign(new Error(code), { code, retryable, status });
}

export function createApplicationCleanupClient({ apiUrl, serviceKey, fetchImpl = fetch }) {
  const baseUrl = String(apiUrl || "").replace(/\/+$/, "");

  return async function runApplicationCleanup(job) {
    const appId = String(job?.app_id || "");
    const requestId = String(job?.payload?.request_id || "");
    if (!UUID.test(appId) || !UUID.test(requestId)) {
      throw cleanupError("APP_CLEANUP_INVALID_JOB", false);
    }
    if (!baseUrl || !serviceKey) {
      throw cleanupError("APP_CLEANUP_WORKER_NOT_CONFIGURED", false);
    }

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/internal/application-cleanup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ app_id: appId, request_id: requestId }),
        signal: AbortSignal.timeout(15 * 60 * 1000)
      });
    } catch {
      throw cleanupError("APP_CLEANUP_API_UNREACHABLE", true);
    }

    let result = {};
    try {
      result = await response.json();
    } catch {}
    if (!response.ok) {
      const code = ERROR_CODE.test(String(result?.code || ""))
        ? String(result.code)
        : `APP_CLEANUP_HTTP_${Number(response.status) || 0}`;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw cleanupError(code, retryable, response.status);
    }
    if (result?.status !== "cleanup_complete") {
      throw cleanupError("APP_CLEANUP_INCOMPLETE", true, response.status);
    }
    return result;
  };
}
