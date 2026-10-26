const CAPABILITY_NAMES =
  [
    "general",
    "fast",
    "reasoning",
    "coding",
    "document-analysis",
    "structured-output",
    "vision"
  ];


export const AI_CAPABILITIES =
  Object.freeze(
    [...CAPABILITY_NAMES]
  );


const SPECIALIZED_PATTERNS =
  Object.freeze({

    reasoning:
      [
        /deepseek-r1/i,
        /\bqwq\b/i,
        /reason/i
      ],

    coding:
      [
        /coder/i,
        /codellama/i,
        /codegemma/i,
        /deepseek-coder/i
      ],

    vision:
      [
        /llava/i,
        /moondream/i,
        /minicpm-v/i,
        /\bvision\b/i,
        /qwen.*-vl/i
      ]
  });


function normalizeName(
  value
) {

  return String(
    value ||
    ""
  ).trim();
}


function normalizedModel(
  model
) {

  const name =
    normalizeName(
      model?.name ||
      model?.model
    );

  if (!name) {
    return null;
  }


  const size =
    Number.isFinite(
      Number(
        model?.size
      )
    )
      ? Number(
          model.size
        )
      : null;


  return {
    name,

    size,

    details:
      model?.details &&
      typeof model.details ===
        "object"
        ? model.details
        : null
  };
}


function matchesAny(
  value,
  patterns
) {

  return patterns.some(
    pattern =>
      pattern.test(value)
  );
}


function specializedCapabilities(
  modelName
) {

  const capabilities =
    new Set([
      "general",
      "document-analysis",
      "structured-output"
    ]);


  if (
    matchesAny(
      modelName,
      SPECIALIZED_PATTERNS.reasoning
    )
  ) {

    capabilities.add(
      "reasoning"
    );
  }


  if (
    matchesAny(
      modelName,
      SPECIALIZED_PATTERNS.coding
    )
  ) {

    capabilities.add(
      "coding"
    );
  }


  if (
    matchesAny(
      modelName,
      SPECIALIZED_PATTERNS.vision
    )
  ) {

    capabilities.add(
      "vision"
    );
  }


  return capabilities;
}


function findByName(
  registry,
  requestedName
) {

  const target =
    normalizeName(
      requestedName
    ).toLowerCase();


  if (!target) {
    return null;
  }


  return (
    registry.find(
      item =>
        item.name
          .toLowerCase() ===
        target
    ) ||
    null
  );
}


function defaultEntry(
  registry,
  defaultModel
) {

  const configured =
    findByName(
      registry,
      defaultModel
    );


  if (configured) {
    return configured;
  }


  return (
    registry[0] ||
    null
  );
}


function smallestEntry(
  registry
) {

  const withKnownSize =
    registry
      .filter(
        item =>
          Number.isFinite(
            item.size
          )
      )
      .sort(
        (left, right) =>
          left.size -
          right.size
      );


  if (
    withKnownSize.length
  ) {

    return withKnownSize[0];
  }


  return (
    registry[0] ||
    null
  );
}


export function buildModelRegistry(
  installedModels,
  {
    defaultModel =
      "llama3:8b"
  } = {}
) {

  const raw =
    Array.isArray(
      installedModels
    )
      ? installedModels
      : [];


  const unique =
    new Map();


  for (const item of raw) {

    const normalized =
      normalizedModel(
        item
      );


    if (!normalized) {
      continue;
    }


    const key =
      normalized.name
        .toLowerCase();


    if (
      unique.has(key)
    ) {
      continue;
    }


    const capabilities =
      specializedCapabilities(
        normalized.name
      );


    unique.set(
      key,
      {
        ...normalized,

        capabilities:
          [...capabilities]
      }
    );
  }


  const registry =
    [...unique.values()];


  const fastModel =
    smallestEntry(
      registry
    );


  if (fastModel) {

    fastModel.capabilities =
      Array.from(
        new Set([
          ...fastModel.capabilities,
          "fast"
        ])
      );
  }


  const configuredDefault =
    defaultEntry(
      registry,
      defaultModel
    );


  return registry.map(
    item => ({
      ...item,

      default:
        Boolean(
          configuredDefault &&
          configuredDefault.name ===
            item.name
        )
    })
  );
}


function capabilityEntry(
  registry,
  capability
) {

  return (
    registry.find(
      item =>
        item.capabilities
          .includes(
            capability
          )
    ) ||
    null
  );
}


function routeResult({
  capability,
  selected,
  reason,
  fallback,
  specialized
}) {

  return {
    capability,

    model:
      selected.name,

    reason,

    fallback:
      Boolean(
        fallback
      ),

    specialized:
      Boolean(
        specialized
      )
  };
}


function routerError(
  code,
  message
) {

  const error =
    new Error(
      message
    );

  error.code =
    code;

  return error;
}


export function routeModel({
  installedModels,
  defaultModel =
    "llama3:8b",
  capability =
    "general",
  requestedModel =
    ""
}) {

  const registry =
    buildModelRegistry(
      installedModels,
      {
        defaultModel
      }
    );


  if (!registry.length) {

    throw routerError(
      "FELTUS_AI_NO_MODELS",
      "No approved local AI models are installed."
    );
  }


  const normalizedCapability =
    normalizeName(
      capability
    ).toLowerCase() ||
    "general";


  if (
    !AI_CAPABILITIES.includes(
      normalizedCapability
    )
  ) {

    throw routerError(
      "FELTUS_AI_INVALID_CAPABILITY",
      `Unsupported AI capability: ${normalizedCapability}`
    );
  }


  if (
    normalizeName(
      requestedModel
    )
  ) {

    const explicit =
      findByName(
        registry,
        requestedModel
      );


    if (!explicit) {

      throw routerError(
        "FELTUS_AI_MODEL_NOT_INSTALLED",
        "Requested AI model is not installed."
      );
    }


    if (
      normalizedCapability ===
        "vision" &&
      !explicit.capabilities
        .includes(
          "vision"
        )
    ) {

      throw routerError(
        "FELTUS_AI_CAPABILITY_UNAVAILABLE",
        "Requested AI model does not provide the required vision capability."
      );
    }


    return routeResult({
      capability:
        normalizedCapability,

      selected:
        explicit,

      reason:
        "explicit-model-request",

      fallback:
        false,

      specialized:
        explicit.capabilities
          .includes(
            normalizedCapability
          )
    });
  }


  const configuredDefault =
    defaultEntry(
      registry,
      defaultModel
    );


  if (
    normalizedCapability ===
    "fast"
  ) {

    const selected =
      capabilityEntry(
        registry,
        "fast"
      ) ||
      configuredDefault;


    return routeResult({
      capability:
        normalizedCapability,

      selected,

      reason:
        "fastest-approved-local-model",

      fallback:
        false,

      specialized:
        true
    });
  }


  if (
    normalizedCapability ===
    "vision"
  ) {

    const selected =
      capabilityEntry(
        registry,
        "vision"
      );


    if (!selected) {

      throw routerError(
        "FELTUS_AI_CAPABILITY_UNAVAILABLE",
        "No installed approved model provides vision capability."
      );
    }


    return routeResult({
      capability:
        normalizedCapability,

      selected,

      reason:
        "specialized-capability-match",

      fallback:
        false,

      specialized:
        true
    });
  }


  if (
    normalizedCapability ===
      "reasoning" ||
    normalizedCapability ===
      "coding"
  ) {

    const specialized =
      capabilityEntry(
        registry,
        normalizedCapability
      );


    if (specialized) {

      return routeResult({
        capability:
          normalizedCapability,

        selected:
          specialized,

        reason:
          "specialized-capability-match",

        fallback:
          false,

        specialized:
          true
      });
    }


    return routeResult({
      capability:
        normalizedCapability,

      selected:
        configuredDefault,

      reason:
        "general-model-fallback",

      fallback:
        true,

      specialized:
        false
    });
  }


  return routeResult({
    capability:
      normalizedCapability,

    selected:
      configuredDefault,

    reason:
      "configured-default",

    fallback:
      false,

    specialized:
      configuredDefault.capabilities
        .includes(
          normalizedCapability
        )
  });
}
