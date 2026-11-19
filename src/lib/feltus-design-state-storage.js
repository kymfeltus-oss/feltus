export const DESIGN_STATE_STORAGE_CONTRACT = "feltus.design-state-storage/v1";

const ENCODED_KEY_PREFIX = "feltus_field_hex_";
const SENSITIVE_SETUP_KEY = /(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;

function mapSensitiveKeys(value, direction) {
  if (Array.isArray(value)) return value.map(item => mapSensitiveKeys(item, direction));
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value).map(([key, child]) => {
    if (direction === "encode" && SENSITIVE_SETUP_KEY.test(key)) {
      return [`${ENCODED_KEY_PREFIX}${Buffer.from(key, "utf8").toString("hex")}`, mapSensitiveKeys(child, direction)];
    }
    if (direction === "decode" && key.startsWith(ENCODED_KEY_PREFIX)) {
      const encoded = key.slice(ENCODED_KEY_PREFIX.length);
      if (!/^(?:[0-9a-f]{2})+$/i.test(encoded)) throw Object.assign(new Error("Stored Design State contains an invalid encoded field."), { code: "DESIGN_STATE_STORAGE_INVALID" });
      const decoded = Buffer.from(encoded, "hex").toString("utf8");
      if (!SENSITIVE_SETUP_KEY.test(decoded)) throw Object.assign(new Error("Stored Design State contains an unexpected encoded field."), { code: "DESIGN_STATE_STORAGE_INVALID" });
      return [decoded, mapSensitiveKeys(child, direction)];
    }
    return [key, mapSensitiveKeys(child, direction)];
  });
  return Object.fromEntries(entries);
}

export function serializeDesignStateForSetupData(designState) {
  if (!designState || typeof designState !== "object" || Array.isArray(designState)) throw new TypeError("Design State must be an object.");
  return {
    contract: DESIGN_STATE_STORAGE_CONTRACT,
    value: mapSensitiveKeys(designState, "encode")
  };
}

export function deserializeDesignStateFromSetupData(storedValue) {
  if (!storedValue || typeof storedValue !== "object" || Array.isArray(storedValue)) return storedValue;
  if (storedValue.contract !== DESIGN_STATE_STORAGE_CONTRACT) return storedValue;
  if (!storedValue.value || typeof storedValue.value !== "object" || Array.isArray(storedValue.value)) {
    throw Object.assign(new Error("Stored Design State has no valid serialized value."), { code: "DESIGN_STATE_STORAGE_INVALID" });
  }
  return mapSensitiveKeys(storedValue.value, "decode");
}
