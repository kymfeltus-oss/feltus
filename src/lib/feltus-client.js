/**
 * FELTUS LABS
 * Authenticated REST Data Client
 *
 * Authentication: FELTUS Auth
 * Authorization: PostgreSQL Row-Level Security
 */

export class FeltusBaseClient {
  constructor(apiUrl, jwtToken = null, publishableKey = null) {
    if (!apiUrl || !/^https?:\/\//.test(apiUrl)) {
      throw new Error("A valid FELTUS API URL is required.");
    }

    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.jwtToken = jwtToken;
    this.publishableKey = publishableKey;
  }

  setAuth(token) {
    this.jwtToken = token || null;
  }

  setPublishableKey(key) {
    this.publishableKey = key || null;
  }

  _getHeaders(customHeaders = {}) {
    if (!this.jwtToken) {
      throw new Error("FELTUS authentication is required.");
    }

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${this.jwtToken}`,
      ...customHeaders
    };

    if (this.publishableKey) {
      headers["apikey"] = this.publishableKey;
    }

    return headers;
  }

  from(table) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error("Invalid database table name.");
    }

    const tableUrl = `${this.apiUrl}/${table}`;

    return {
      select: async (selectColumns = "*", filters = {}) => {
        const params = new URLSearchParams();
        params.set("select", selectColumns);

        for (const [key, value] of Object.entries(filters)) {
          params.set(key, `eq.${value}`);
        }

        const response = await fetch(
          `${tableUrl}?${params.toString()}`,
          {
            method: "GET",
            headers: this._getHeaders()
          }
        );

        if (!response.ok) {
          throw new Error(
            `[FeltusBase Read Failure]: HTTP ${response.status}`
          );
        }

        return response.json();
      },

      insert: async (recordsArray) => {
        const response = await fetch(tableUrl, {
          method: "POST",
          headers: this._getHeaders({
            Prefer: "return=representation"
          }),
          body: JSON.stringify(recordsArray)
        });

        if (!response.ok) {
          throw new Error(
            `[FeltusBase Write Failure]: HTTP ${response.status}`
          );
        }

        return response.json();
      }
    };
  }
}