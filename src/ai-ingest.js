"use strict";

import { FeltusAI } from "./lib/feltus-ai.js";

const FELTUS_URL =
  process.env.FELTUS_LOCAL_URL ||
  "http://127.0.0.1:8080";

async function requestFeltus(path) {
  const response = await fetch(
    `${FELTUS_URL}${path}`,
    {
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(30000)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `FELTUS HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function verifyFeltusBackend() {
  const health =
    await requestFeltus("/api/health");

  if (
    health.status !== "online" ||
    health.authenticated !== true
  ) {
    throw new Error(
      "Authenticated FELTUS backend is unavailable."
    );
  }

  return health;
}

async function loadContext() {
  const assets =
    await requestFeltus("/api/assets");

  if (!Array.isArray(assets)) {
    throw new Error(
      "FELTUS assets response is invalid."
    );
  }

  return assets;
}

function buildPrompt(assets) {
  if (assets.length === 0) {
    return [
      "You are FELTUS AI.",
      "You are operating entirely inside the private FELTUS LABS environment.",
      "",
      "No infrastructure assets are currently available.",
      "",
      "Respond with exactly:",
      "FELTUS CONTEXT ONLINE | NO ASSETS"
    ].join("\n");
  }

  const latest = assets[0];

  return [
    "You are FELTUS AI.",
    "You are operating entirely inside the private FELTUS LABS environment.",
    "",
    "This infrastructure record was retrieved through the authenticated FELTUS backend:",
    "",
    JSON.stringify(
      {
        id: latest.id,
        asset_name: latest.asset_name,
        payload: latest.payload,
        created_at: latest.created_at
      },
      null,
      2
    ),
    "",
    "Respond with exactly:",
    `FELTUS CONTEXT ONLINE | ${latest.asset_name}`
  ].join("\n");
}

async function main() {
  console.log("");
  console.log(
    "=== FELTUS LABS PRIVATE AI PIPELINE ==="
  );

  const health =
    await verifyFeltusBackend();

  console.log(
    "FELTUS BACKEND:",
    health.status
  );

  console.log(
    "INTERNAL AUTH:",
    health.authenticated
  );

  const assets =
    await loadContext();

  console.log(
    "CONTEXT RECORDS:",
    assets.length
  );

  if (assets.length > 0) {
    console.log(
      "LATEST ASSET:",
      assets[0].asset_name
    );
  }

  const ai =
    new FeltusAI();

  const models =
    await ai.listModels();

  const available =
    models.some(
      item =>
        item.name === ai.model ||
        item.model === ai.model
    );

  if (!available) {
    throw new Error(
      `Required Ollama model is not installed: ${ai.model}`
    );
  }

  console.log(
    "AI MODEL:",
    ai.model
  );

  console.log(
    "INFERENCE: RUNNING"
  );

  const result =
    await ai.generate(
      buildPrompt(assets)
    );

  const response =
    String(result.response || "").trim();

  if (!response) {
    throw new Error(
      "AI returned an empty response."
    );
  }

  console.log("");
  console.log(
    "=== FELTUS AI RESPONSE ==="
  );

  console.log(response);

  console.log("");
  console.log(
    "MODEL:",
    result.model
  );

  console.log(
    "DONE:",
    result.done
  );

  console.log(
    "FELTUS AI PIPELINE: PASS"
  );
}

main().catch(error => {
  console.error("");
  console.error(
    "FELTUS AI PIPELINE: FAIL"
  );

  console.error(
    error.message
  );

  process.exitCode = 1;
});
