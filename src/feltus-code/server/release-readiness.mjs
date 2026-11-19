import crypto from "node:crypto";
import { redactSecrets } from "./security.mjs";

export const RELEASE_READINESS_CONTRACT = "feltus.release-readiness/v1";
export const RELEASE_READINESS_EVALUATOR_VERSION = "phase-g-v1";
export const RELEASE_READINESS_STATES = Object.freeze([
  "READY", "NOT_READY", "REVIEW_REQUIRED", "VALIDATING", "STALE", "BLOCKED"
]);
export const RELEASE_GATES = Object.freeze(["BLOCKING", "REVIEW REQUIRED", "WARNING", "NOT APPLICABLE"]);
export const RELEASE_CATEGORIES = Object.freeze([
  "Code", "Tests", "Design", "Configuration", "Security", "Build", "Environment", "Infrastructure"
]);

const SOURCE_FIELDS = Object.freeze([
  "application_id",
  "workspace_id",
  "branch",
  "checkpoint",
  "source_commit",
  "source_snapshot_sha256",
  "classifier_version"
]);

const CHECK_RESULT = Object.freeze({
  PASSED: "PASSED",
  FAILED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_RUN: "NOT_RUN",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  WARNING: "WARNING",
  VALIDATING: "VALIDATING"
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function text(value, limit = 1600) {
  return redactSecrets(String(value ?? "")).replace(/\s+/g, " ").trim().slice(0, limit);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function sourceValue(value) {
  return value == null || value === "" ? null : String(value);
}

function normalizedCommit(value) {
  return sourceValue(value)?.toLowerCase() || null;
}

function sameSourceValue(field, left, right) {
  if (["checkpoint", "source_commit", "source_snapshot_sha256"].includes(field)) {
    return normalizedCommit(left) === normalizedCommit(right);
  }
  return sourceValue(left) === sourceValue(right);
}

export function normalizeSourceIdentity(value = {}) {
  return {
    application_id: sourceValue(value.application_id),
    workspace_id: sourceValue(value.workspace_id || value.source_workspace_id),
    branch: sourceValue(value.branch || value.source_branch),
    checkpoint: sourceValue(value.checkpoint || value.source_checkpoint || value.source_checkpoint_id),
    source_commit: sourceValue(value.source_commit || value.commit),
    source_snapshot_sha256: sourceValue(value.source_snapshot_sha256 || value.snapshot_sha256),
    source_snapshot_complete: value.source_snapshot_complete !== false,
    classifier_version: sourceValue(value.classifier_version)
  };
}

function sourceIdentityIssues(identity) {
  const issues = [];
  for (const field of SOURCE_FIELDS) {
    if (!identity[field]) issues.push({ field, expected: "present", observed: null });
  }
  if (identity.source_snapshot_complete !== true) {
    issues.push({ field: "source_snapshot_complete", expected: true, observed: identity.source_snapshot_complete });
  }
  if (identity.checkpoint && identity.source_commit && !sameSourceValue("checkpoint", identity.checkpoint, identity.source_commit)) {
    issues.push({ field: "checkpoint", expected: identity.source_commit, observed: identity.checkpoint });
  }
  return issues;
}

export function compareSourceIdentity(expectedValue, currentValue) {
  const expected = normalizeSourceIdentity(expectedValue);
  const current = normalizeSourceIdentity(currentValue);
  const mismatches = [];
  for (const field of SOURCE_FIELDS) {
    if (!sameSourceValue(field, expected[field], current[field])) {
      mismatches.push({ field, expected: expected[field], observed: current[field] });
    }
  }
  if (expected.source_snapshot_complete !== current.source_snapshot_complete) {
    mismatches.push({
      field: "source_snapshot_complete",
      expected: expected.source_snapshot_complete,
      observed: current.source_snapshot_complete
    });
  }
  return mismatches;
}

function sourceIdentityFromRun(run = {}) {
  return normalizeSourceIdentity({
    application_id: run.application_id,
    workspace_id: run.source_workspace_id,
    branch: run.source_branch,
    checkpoint: run.source_checkpoint_id,
    source_commit: run.source_commit,
    source_snapshot_sha256: run.source_snapshot_sha256,
    source_snapshot_complete: run.source_snapshot_complete,
    classifier_version: run.classifier_version
  });
}

function sourceIdentityFromClassification(classification = {}) {
  return normalizeSourceIdentity({
    application_id: classification.application_id,
    workspace_id: classification.source_workspace_id,
    branch: classification.source_branch,
    checkpoint: classification.source_checkpoint_id,
    source_commit: classification.source_commit,
    source_snapshot_sha256: classification.source_snapshot_sha256,
    source_snapshot_complete: classification.source_snapshot_complete,
    classifier_version: classification.classifier_version
  });
}

function categoryForValidationCheck(check = {}) {
  const id = String(check.id || "").toLowerCase();
  const tool = String(check.tool || "").toLowerCase();
  if (id.includes("test") || tool.includes("test") || tool.includes("pytest") || tool.includes("unittest")) return "Tests";
  if (id.includes("build") || tool.includes("build") || tool.includes("compile")) return "Build";
  return "Code";
}

function remediationForValidationCheck(check = {}) {
  const category = categoryForValidationCheck(check);
  if (check.status === "UNAVAILABLE") return `Configure or install the required ${check.tool || category.toLowerCase()} check, then evaluate this exact source again.`;
  if (category === "Tests") return "Fix the failing required test suite and reevaluate the exact source checkpoint.";
  if (category === "Build") return "Configure or fix the applicable build command and reevaluate the exact source checkpoint.";
  return `Fix the ${check.tool || "required code"} check and reevaluate the exact source checkpoint.`;
}

function checkStatus(check = {}) {
  if (check.status === "NOT_APPLICABLE" || check.applicable === false || check.required === false && !check.available && !check.command) return CHECK_RESULT.NOT_APPLICABLE;
  if (check.status === "PASSED" || check.exit_code === 0) return CHECK_RESULT.PASSED;
  if (check.status === "UNAVAILABLE" || check.available === false) return CHECK_RESULT.UNAVAILABLE;
  if (check.status === "NOT_RUN" || check.exit_code == null) return CHECK_RESULT.NOT_RUN;
  return CHECK_RESULT.FAILED;
}

function validationGate(check, result) {
  if (result === CHECK_RESULT.NOT_APPLICABLE) return "NOT APPLICABLE";
  if (result === CHECK_RESULT.PASSED) return "WARNING";
  if (result === CHECK_RESULT.UNAVAILABLE || result === CHECK_RESULT.NOT_RUN) return check.required ? "BLOCKING" : "WARNING";
  return check.required ? "BLOCKING" : "WARNING";
}

function checkDisposition(check, result) {
  if (result === CHECK_RESULT.UNAVAILABLE || result === CHECK_RESULT.NOT_RUN) return check.required ? "BLOCKED" : "WARNING";
  return result === CHECK_RESULT.FAILED && check.required ? "NOT_READY" : "WARNING";
}

function buildCheck({
  id,
  name,
  category,
  result = CHECK_RESULT.PASSED,
  gate = "WARNING",
  disposition = null,
  applicable = true,
  expected_state = null,
  observed_state = null,
  evidence = {},
  remediation = null,
  sourceIdentity,
  timestamp,
  severity = null
}) {
  const normalizedEvidence = {
    summary: text(evidence.summary || "No additional evidence was recorded."),
    references: array(evidence.references).filter(Boolean).slice(0, 40),
    ...(evidence.output_summary ? { output_summary: text(evidence.output_summary, 4000) } : {})
  };
  return {
    id,
    name,
    category,
    result,
    gate,
    severity: severity || gate,
    disposition,
    applicable,
    expected_state,
    observed_state,
    evidence: normalizedEvidence,
    remediation: remediation || null,
    source_identity: clone(sourceIdentity),
    evaluated_at: timestamp
  };
}

function requiredCheckEvidence(check) {
  return {
    summary: check.output_summary || check.reason || `${check.tool || "Repository"} validation result: ${check.status || "unknown"}.`,
    references: [
      check.evidence_ref,
      check.id ? `validation.check:${check.id}` : null
    ].filter(Boolean),
    output_summary: check.output_summary || null
  };
}

function collectValidationChecks({ validation = {}, sourceIdentity, timestamp }) {
  const run = validation.run || validation.productionization_run || validation;
  const checks = array(validation.checks).length ? validation.checks : array(run.checks);
  return checks.map((check, index) => {
    const result = checkStatus(check);
    const category = categoryForValidationCheck(check);
    return buildCheck({
      id: `validation.${check.id || index + 1}`,
      name: check.tool || check.id || "Repository validation",
      category,
      result,
      gate: validationGate(check, result),
      disposition: checkDisposition(check, result),
      applicable: result !== CHECK_RESULT.NOT_APPLICABLE,
      expected_state: check.required ? "Pass the configured required check" : "Check applies only when configured",
      observed_state: result,
      evidence: requiredCheckEvidence(check),
      remediation: result === CHECK_RESULT.PASSED || result === CHECK_RESULT.NOT_APPLICABLE ? null : remediationForValidationCheck(check),
      sourceIdentity,
      timestamp
    });
  });
}

function checkById(checks, fragment) {
  return checks.find(check => String(check.id || "").toLowerCase().includes(fragment));
}

function executiveHeadline(state, summary) {
  if (state === "READY") return "Ready to Release";
  if (state === "VALIDATING") return "Release readiness is validating";
  if (state === "STALE") return "Release readiness is stale — reevaluate before building";
  if (state === "REVIEW_REQUIRED") return "Review required before release";
  if (summary.blocking_count > 0) return `${summary.blocking_count} issue${summary.blocking_count === 1 ? "" : "s"} blocking release`;
  return "Not ready to release";
}

function summarizeChecks(checks, state) {
  const categories = RELEASE_CATEGORIES.map(category => {
    const rows = checks.filter(check => check.category === category);
    const applicable = rows.filter(check => check.applicable !== false && check.gate !== "NOT APPLICABLE");
    const blocking = rows.filter(check => check.gate === "BLOCKING");
    const review = rows.filter(check => check.gate === "REVIEW REQUIRED");
    const warning = rows.filter(check => check.gate === "WARNING" && check.result !== CHECK_RESULT.PASSED);
    const passed = rows.filter(check => check.result === CHECK_RESULT.PASSED);
    const notApplicable = rows.filter(check => check.gate === "NOT APPLICABLE" || check.result === CHECK_RESULT.NOT_APPLICABLE);
    const categoryState = blocking.length ? "BLOCKING"
      : review.length ? "REVIEW REQUIRED"
        : applicable.length === 0 ? "NOT APPLICABLE"
          : warning.length ? "WARNING"
            : "READY";
    return {
      category,
      state: categoryState,
      check_count: rows.length,
      applicable_count: applicable.length,
      passed_count: passed.length,
      blocking_count: blocking.length,
      review_required_count: review.length,
      warning_count: warning.length,
      not_applicable_count: notApplicable.length,
      summary: blocking.length
        ? `${blocking.length} issue${blocking.length === 1 ? "" : "s"} blocks release.`
        : review.length
          ? `${review.length} item${review.length === 1 ? "" : "s"} needs review.`
          : applicable.length === 0
            ? "Not applicable to this application."
            : warning.length
              ? `${warning.length} warning${warning.length === 1 ? "" : "s"} recorded.`
              : "All applicable checks passed."
    };
  });
  const summary = {
    state,
    check_count: checks.length,
    applicable_count: checks.filter(check => check.applicable !== false && check.gate !== "NOT APPLICABLE").length,
    passed_count: checks.filter(check => check.result === CHECK_RESULT.PASSED).length,
    blocking_count: checks.filter(check => check.gate === "BLOCKING").length,
    review_required_count: checks.filter(check => check.gate === "REVIEW REQUIRED").length,
    warning_count: checks.filter(check => check.gate === "WARNING" && check.result !== CHECK_RESULT.PASSED).length,
    not_applicable_count: checks.filter(check => check.gate === "NOT APPLICABLE" || check.result === CHECK_RESULT.NOT_APPLICABLE).length
  };
  return { summary, categories };
}

function blockingState(checks) {
  const blockers = checks.filter(check => check.gate === "BLOCKING");
  if (!blockers.length) return null;
  return blockers.some(check => check.disposition === "BLOCKED") ? "BLOCKED" : "NOT_READY";
}

function readinessState({ checks, validating = false }) {
  if (validating) return "VALIDATING";
  const blocked = blockingState(checks);
  if (blocked) return blocked;
  if (checks.some(check => check.gate === "REVIEW REQUIRED")) return "REVIEW_REQUIRED";
  return "READY";
}

function valueNames(values) {
  return array(values).map(value => typeof value === "string" ? value : value?.name).filter(value => /^[A-Z][A-Z0-9_]*$/.test(String(value))).map(String);
}

function configurationChecks({ configuration = {}, sourceIdentity, timestamp }) {
  const checks = [];
  const requirements = array(configuration.required).map(item => typeof item === "string" ? { name: item } : item).filter(item => item?.name);
  const configured = new Set(valueNames(configuration.configured_names || configuration.configured || configuration.environment_variables));
  for (const requirement of requirements) {
    const name = String(requirement.name);
    const isConfigured = requirement.configured === true || configured.has(name);
    checks.push(buildCheck({
      id: `configuration.${name.toLowerCase()}`,
      name: `Required configuration: ${name}`,
      category: "Configuration",
      result: isConfigured ? CHECK_RESULT.PASSED : CHECK_RESULT.FAILED,
      gate: isConfigured ? "WARNING" : "BLOCKING",
      disposition: isConfigured ? null : "NOT_READY",
      expected_state: "Configured by name without exposing its value",
      observed_state: isConfigured ? "Configured" : "Missing",
      evidence: {
        summary: isConfigured ? `${name} is recorded as configured.` : `${name} is required but not recorded as configured.`,
        references: [requirement.evidence_ref, "application.configuration"].filter(Boolean)
      },
      remediation: isConfigured ? null : `Record the required ${name} configuration metadata without storing or exposing its value.`,
      sourceIdentity,
      timestamp
    }));
  }
  const detected = valueNames(configuration.detected_environment_variables);
  if (!requirements.length) {
    checks.push(buildCheck({
      id: "configuration.required",
      name: "Required application configuration",
      category: "Configuration",
      result: CHECK_RESULT.NOT_APPLICABLE,
      gate: "NOT APPLICABLE",
      applicable: false,
      expected_state: "A declared required application configuration contract",
      observed_state: detected.length ? `No declared requirement; ${detected.length} environment name(s) detected` : "No declared requirement",
      evidence: {
        summary: detected.length
          ? `Repository evidence references ${detected.join(", ")} by name only; no required configuration contract is declared.`
          : "No required application configuration contract is declared.",
        references: array(configuration.evidence_refs)
      },
      sourceIdentity,
      timestamp
    }));
  }
  return checks;
}

function environmentChecks({ environment = {}, sourceIdentity, timestamp }) {
  if (!environment.required) {
    return [buildCheck({
      id: "environment.metadata",
      name: "Required deployment environment metadata",
      category: "Environment",
      result: CHECK_RESULT.NOT_APPLICABLE,
      gate: "NOT APPLICABLE",
      applicable: false,
      expected_state: "Declared environment metadata when this application requires it",
      observed_state: "No environment metadata requirement declared",
      evidence: { summary: "No provider API was called; this application has no declared environment metadata requirement.", references: array(environment.evidence_refs) },
      sourceIdentity,
      timestamp
    })];
  }
  const validScope = environment.scope_valid !== false;
  const configured = environment.configured === true && Boolean(environment.environment_id || environment.environment_name);
  if (!validScope) {
    return [buildCheck({
      id: "environment.metadata",
      name: "Required deployment environment metadata",
      category: "Environment",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "Application-scoped environment and target metadata",
      observed_state: "Cross-scope or invalid environment metadata",
      evidence: { summary: "The declared environment metadata is not safely scoped to this application.", references: array(environment.evidence_refs) },
      remediation: "Correct the application-scoped environment metadata before reevaluating. No provider operation was attempted.",
      sourceIdentity,
      timestamp
    })];
  }
  return [buildCheck({
    id: "environment.metadata",
    name: "Required deployment environment metadata",
    category: "Environment",
    result: configured ? CHECK_RESULT.PASSED : CHECK_RESULT.FAILED,
    gate: configured ? "WARNING" : "BLOCKING",
    disposition: configured ? null : "NOT_READY",
    expected_state: "Required environment and target metadata recorded without provider verification",
    observed_state: configured ? "Recorded" : "Missing",
    evidence: { summary: configured ? "Required environment metadata is recorded; no provider API was called." : "Required environment metadata is missing.", references: array(environment.evidence_refs) },
    remediation: configured ? null : "Record the required environment metadata before reevaluating. This does not call a provider.",
    sourceIdentity,
    timestamp
  })];
}

function infrastructureChecks({ infrastructure = null, sourceIdentity, timestamp }) {
  const components = infrastructure?.components && typeof infrastructure.components === "object"
    ? Object.entries(infrastructure.components)
    : [];
  if (!components.length) return [buildCheck({
    id: "infrastructure.ownership",
    name: "Infrastructure ownership evidence",
    category: "Infrastructure",
    result: CHECK_RESULT.NOT_RUN,
    gate: "WARNING",
    disposition: "WARNING",
    expected_state: "Component ownership and verification evidence",
    observed_state: "Unavailable",
    evidence: { summary: "Infrastructure ownership could not be resolved; no external resource is assumed verified." },
    sourceIdentity,
    timestamp
  })];
  return components.map(([componentName, component]) => {
    const verification = component?.verification?.status || "UNVERIFIED";
    const configured = component?.status === "CONFIGURED";
    const verified = configured && verification === "VERIFIED";
    const owner = ["FELTUS", "CUSTOMER", "EXTERNAL_PROVIDER"].includes(component?.owner)
      ? component.owner
      : "UNKNOWN";
    return buildCheck({
      id: `infrastructure.${componentName}`,
      name: `Infrastructure ownership: ${componentName.replaceAll("_", " ")}`,
      category: "Infrastructure",
      result: verified ? CHECK_RESULT.PASSED : CHECK_RESULT.NOT_RUN,
      gate: "WARNING",
      disposition: verified ? null : "WARNING",
      expected_state: "Owner, management model, component status, and evidence are explicit",
      observed_state: `${owner} / ${component?.management || "UNKNOWN"} / ${component?.status || "UNKNOWN"} / ${verification}${component?.verification?.remote_status ? ` (${component.verification.remote_status})` : ""}`,
      evidence: {
        summary: component?.verification?.evidence ||
          "Ownership is reported, but independent configuration or health evidence is not available.",
        references: [component?.evidence_ref].filter(Boolean)
      },
      remediation: verified ? null : "Provide supported configuration and verification evidence for this component. Customer-managed ownership alone is not a release blocker.",
      sourceIdentity,
      timestamp
    });
  });
}

function designChecks({ design, sourceIdentity, timestamp }) {
  if (!design || design.applicable === false) {
    return [buildCheck({
      id: "design.state",
      name: "Design Studio state",
      category: "Design",
      result: CHECK_RESULT.NOT_APPLICABLE,
      gate: "NOT APPLICABLE",
      applicable: false,
      expected_state: "A persisted Design State when Design Studio is used",
      observed_state: "Design Studio is not applicable",
      evidence: { summary: "No persisted Design State applies to this application.", references: array(design?.evidence_refs) },
      sourceIdentity,
      timestamp
    })];
  }
  const checks = [];
  const stateHash = sourceValue(design.design_state_hash);
  const designIdentity = normalizeSourceIdentity(design.source_identity || design.sync || {});
  const identityMismatches = compareSourceIdentity(sourceIdentity, designIdentity);
  if (!stateHash || identityMismatches.length) {
    checks.push(buildCheck({
      id: "design.source-binding",
      name: "Design Studio source binding",
      category: "Design",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "Current Design State hash and exact source identity",
      observed_state: !stateHash ? "Design State hash is missing" : "Design State source identity differs from release source",
      evidence: {
        summary: !stateHash ? "A persisted Design State is missing its canonical hash." : "The Design State is bound to a different source identity.",
        references: array(design.evidence_refs),
        identity_mismatches: identityMismatches
      },
      remediation: "Reconcile Design Studio against the current source and create a new release evaluation.",
      sourceIdentity,
      timestamp
    }));
    return checks;
  }
  const components = array(design.components);
  const decisions = array(design.reconciliation);
  const syncSummary = design.sync_summary || {};
  const hasConflict = design.conflict === true || syncSummary.stylesheet_reconciliation_required > 0 || components.some(component => component.sync_state === "CONFLICT");
  if (hasConflict) {
    checks.push(buildCheck({
      id: "design.reconciliation",
      name: "Design Studio reconciliation",
      category: "Design",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "No unresolved managed stylesheet or source/design conflict",
      observed_state: "Managed stylesheet or Design Studio conflict requires resolution",
      evidence: { summary: "Design Studio reported an unresolved conflict that cannot safely authorize release.", references: array(design.evidence_refs).concat(decisions.map(item => item.component_id ? `design.component:${item.component_id}` : "design.stylesheet")) },
      remediation: "Resolve the Design Studio conflict through the existing CODE/Design Studio lifecycle, then reevaluate.",
      sourceIdentity,
      timestamp
    }));
    return checks;
  }
  const reconciliationRequired = components.filter(component => component.reconciliation_state === "REQUIRED" || component.sync_state === "RECONCILIATION_REQUIRED");
  const waitingValidation = components.filter(component => component.sync_state === "VALIDATING" || component.sync_state === "CANVAS_CHANGED" || component.sync_state === "CODE_CHANGED");
  if (reconciliationRequired.length) {
    checks.push(buildCheck({
      id: "design.reconciliation",
      name: "Design Studio reconciliation",
      category: "Design",
      result: CHECK_RESULT.REVIEW_REQUIRED,
      gate: "REVIEW REQUIRED",
      expected_state: "All applicable managed components reconciled or explicitly developer-owned without pending reconciliation",
      observed_state: `${reconciliationRequired.length} component${reconciliationRequired.length === 1 ? "" : "s"} require reconciliation`,
      evidence: { summary: "A component-scoped Design Studio reconciliation decision is required; source has not been overwritten.", references: array(design.evidence_refs).concat(reconciliationRequired.map(component => `design.component:${component.id}`)) },
      remediation: "Review the affected component reconciliation through Design Studio or keep it explicitly Developer Managed, then reevaluate.",
      sourceIdentity,
      timestamp
    }));
    return checks;
  }
  if (waitingValidation.length) {
    checks.push(buildCheck({
      id: "design.validation",
      name: "Design Studio validation",
      category: "Design",
      result: CHECK_RESULT.REVIEW_REQUIRED,
      gate: "REVIEW REQUIRED",
      expected_state: "A synchronized Design State after required validation",
      observed_state: `${waitingValidation.length} component${waitingValidation.length === 1 ? "" : "s"} are not synchronized`,
      evidence: { summary: "Design Studio has pending Canvas, source, or validation work.", references: array(design.evidence_refs).concat(waitingValidation.map(component => `design.component:${component.id}`)) },
      remediation: "Finish the existing Design Studio validation/reconciliation lifecycle, then reevaluate.",
      sourceIdentity,
      timestamp
    }));
    return checks;
  }
  const developerManaged = components.filter(component => component.ownership_state === "DEVELOPER_MANAGED");
  checks.push(buildCheck({
    id: "design.state",
    name: "Design Studio state",
    category: "Design",
    result: CHECK_RESULT.PASSED,
    gate: "WARNING",
    expected_state: "Current synchronized Design State",
    observed_state: developerManaged.length ? `${developerManaged.length} valid Developer Managed component${developerManaged.length === 1 ? "" : "s"}; no reconciliation pending` : "Synchronized",
    evidence: { summary: developerManaged.length ? "Developer Managed ownership is preserved and does not block release by itself." : "Design Studio is synchronized with the current source.", references: array(design.evidence_refs).concat(developerManaged.map(component => `design.component:${component.id}`)) },
    sourceIdentity,
    timestamp
  }));
  return checks;
}

function classificationChecks({ classification = {}, sourceIdentity, timestamp }) {
  const checks = [];
  const identity = sourceIdentityFromClassification(classification);
  const mismatch = compareSourceIdentity(sourceIdentity, identity);
  const identityInvalid = sourceIdentityIssues(sourceIdentity);
  if (identityInvalid.length || mismatch.length) {
    checks.push(buildCheck({
      id: "security.source-identity",
      name: "Exact release source identity",
      category: "Security",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "Complete matching application, workspace, branch, checkpoint, source hash, and classifier binding",
      observed_state: identityInvalid.length ? "Source identity is incomplete or internally inconsistent" : "Repository classification is bound to a different source identity",
      evidence: { summary: "Release readiness cannot be established without one complete, consistent source identity.", references: array(classification.evidence_refs), identity_issues: identityInvalid, identity_mismatches: mismatch },
      remediation: "Create a clean CODE checkpoint, classify the current source, and reevaluate.",
      sourceIdentity,
      timestamp
    }));
  } else {
    checks.push(buildCheck({
      id: "security.source-identity",
      name: "Exact release source identity",
      category: "Security",
      result: CHECK_RESULT.PASSED,
      gate: "WARNING",
      expected_state: "Complete matching application, workspace, branch, checkpoint, source hash, and classifier binding",
      observed_state: "Current and consistent",
      evidence: { summary: "Application, workspace, branch, checkpoint, source snapshot, and classifier binding match.", references: array(classification.evidence_refs) },
      sourceIdentity,
      timestamp
    }));
  }
  const current = classification.is_current !== false && classification.stale !== true;
  const safe = classification.productionization_safe === true && classification.classification_status === "CLASSIFIED";
  checks.push(buildCheck({
    id: "code.repository-classification",
    name: "Repository classification",
    category: "Code",
    result: current && safe ? CHECK_RESULT.PASSED : CHECK_RESULT.FAILED,
    gate: current && safe ? "WARNING" : "BLOCKING",
    disposition: current && safe ? null : "BLOCKED",
    expected_state: "Current CLASSIFIED and productionization-safe repository evidence",
    observed_state: current ? `${classification.classification_status || "UNKNOWN"}; productionization safe: ${classification.productionization_safe === true}` : "Stale classification",
    evidence: { summary: current && safe ? "Current repository classification is safe for stack-specific release checks." : classification.classification_message || "Repository classification is stale, incomplete, unsafe, mixed, or conflicting.", references: array(classification.evidence_refs) },
    remediation: current && safe ? null : "Reclassify the current source before release readiness can be established.",
    sourceIdentity,
    timestamp
  }));
  return checks;
}

function productionizationChecks({ productionization = {}, sourceIdentity, timestamp }) {
  const run = productionization.run || productionization.validation_run || null;
  const checks = [];
  if (!run) {
    checks.push(buildCheck({
      id: "security.productionization",
      name: "Current productionization validation",
      category: "Security",
      result: CHECK_RESULT.UNAVAILABLE,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "A current source-bound productionization validation run",
      observed_state: "No validation run is available",
      evidence: { summary: "Release readiness has no current productionization validation evidence.", references: array(productionization.evidence_refs) },
      remediation: "Run the existing productionization validation for the exact source checkpoint, then reevaluate.",
      sourceIdentity,
      timestamp
    }));
    return checks;
  }
  const runIdentity = sourceIdentityFromRun(run);
  const mismatch = compareSourceIdentity(sourceIdentity, runIdentity);
  const stale = productionization.stale === true || productionization.is_current === false || mismatch.length > 0;
  if (stale) {
    checks.push(buildCheck({
      id: "security.productionization",
      name: "Current productionization validation",
      category: "Security",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "Validation run bound to the current release source",
      observed_state: "Productionization plan or validation is stale",
      evidence: { summary: "The productionization validation does not match the current release source.", references: array(productionization.evidence_refs).concat(run.run_id ? [`productionization.run:${run.run_id}`] : []), identity_mismatches: mismatch },
      remediation: "Replan and validate productionization against the current source, then reevaluate.",
      sourceIdentity,
      timestamp
    }));
    return checks;
  }
  const protectedChanges = array(run.blocked_contract_changes).length || array(productionization.blocked_contract_changes).length;
  if (protectedChanges) {
    checks.push(buildCheck({
      id: "security.protected-contracts",
      name: "Protected contract integrity",
      category: "Security",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "BLOCKED",
      expected_state: "No protected-contract violation in release evidence",
      observed_state: "Protected contract change is blocked",
      evidence: { summary: "Protected contract changes require an authorized versioned compatibility or migration workflow.", references: array(productionization.evidence_refs).concat(run.run_id ? [`productionization.run:${run.run_id}`] : []) },
      remediation: "Use the separate authorized compatibility or migration workflow; do not release this source through productionization.",
      sourceIdentity,
      timestamp
    }));
  }
  const runReady = run.status === "READY_FOR_RELEASE";
  const checkpointRecorded = run.source_checkpoint_recorded === true;
  const validationNeedsRemediation = array(run.checks).some(check => {
    if (check.required !== true) return false;
    return [CHECK_RESULT.FAILED, CHECK_RESULT.UNAVAILABLE, CHECK_RESULT.NOT_RUN].includes(checkStatus(check));
  });
  const productionizationGate = runReady && checkpointRecorded
    ? "WARNING"
    : checkpointRecorded && validationNeedsRemediation
      ? "WARNING"
      : "BLOCKING";
  checks.push(buildCheck({
    id: "security.productionization",
    name: "Current productionization validation",
    category: "Security",
    result: runReady && checkpointRecorded && !protectedChanges ? CHECK_RESULT.PASSED : CHECK_RESULT.FAILED,
    gate: productionizationGate,
    disposition: productionizationGate === "BLOCKING" ? "BLOCKED" : null,
    expected_state: "READY_FOR_RELEASE validation with a recorded current CODE checkpoint",
    observed_state: `${run.status || "UNKNOWN"}; checkpoint recorded: ${checkpointRecorded}`,
    evidence: { summary: runReady && checkpointRecorded && !protectedChanges ? "Current productionization validation is bound to the release source." : validationNeedsRemediation && checkpointRecorded ? "The current productionization run is bound to this source; individual required validation evidence determines the remediable release state." : "Productionization validation is incomplete, blocked, or its checkpoint is not recorded.", references: array(productionization.evidence_refs).concat(run.run_id ? [`productionization.run:${run.run_id}`] : []) },
    remediation: runReady && checkpointRecorded && !protectedChanges ? null : validationNeedsRemediation && checkpointRecorded ? "Resolve the required validation checks below, then reevaluate this exact source." : "Complete required productionization validation and record the exact CODE checkpoint before reevaluating.",
    sourceIdentity,
    timestamp
  }));
  return checks;
}

function buildRequirementCheck({ classification = {}, validationChecks, sourceIdentity, timestamp }) {
  const buildSystems = array(classification.build_systems);
  const validatedBuildCheck = checkById(validationChecks, ".source.build") || validationChecks.find(check => check.category === "Build");
  if (!buildSystems.length && !validatedBuildCheck) {
    return [buildCheck({
      id: "build.requirement",
      name: "Applicable build requirement",
      category: "Build",
      result: CHECK_RESULT.NOT_APPLICABLE,
      gate: "NOT APPLICABLE",
      applicable: false,
      expected_state: "A build command only when the detected stack requires one",
      observed_state: "No build system detected",
      evidence: { summary: "The detected application stack has no build requirement.", references: array(classification.evidence_refs) },
      sourceIdentity,
      timestamp
    })];
  }
  if (!validatedBuildCheck) {
    return [buildCheck({
      id: "build.requirement",
      name: "Applicable build requirement",
      category: "Build",
      result: CHECK_RESULT.FAILED,
      gate: "BLOCKING",
      disposition: "NOT_READY",
      expected_state: "A configured and validated build command for the detected build system",
      observed_state: "Build system detected but no build validation command is configured",
      evidence: { summary: "The detected application stack requires a build command, but no applicable build validation ran.", references: array(classification.evidence_refs) },
      remediation: "Configure the required build command and validate it in the existing productionization lifecycle.",
      sourceIdentity,
      timestamp
    })];
  }
  return [];
}

function infrastructureBinding(infrastructure = null) {
  if (!infrastructure || typeof infrastructure !== "object") return null;
  const components = infrastructure.components && typeof infrastructure.components === "object"
    ? infrastructure.components
    : {};
  return {
    contract: infrastructure.contract || null,
    mode: infrastructure.mode || null,
    configuration_status: infrastructure.configuration_status || null,
    components: Object.fromEntries(Object.entries(components).sort(([left], [right]) => left.localeCompare(right)).map(([name, component]) => [
      name,
      {
        owner: component?.owner || null,
        management: component?.management || null,
        status: component?.status || null,
        provider: component?.provider || null,
        resource_reference: component?.resource_reference || null,
        verification: component?.verification?.status || "UNVERIFIED",
        remote_status: component?.verification?.remote_status || null,
        remote_commit: component?.verification?.remote_commit || null
      }
    ]))
  };
}

function buildReadinessBindings({ configuration = {}, environment = {}, design = null, infrastructure = null }) {
  const configurationBinding = {
    required: array(configuration.required).map(item => typeof item === "string" ? item : item?.name).filter(Boolean).sort(),
    configured: valueNames(configuration.configured_names || configuration.configured || configuration.environment_variables).sort(),
    detected_environment_variables: valueNames(configuration.detected_environment_variables).sort()
  };
  const environmentBinding = {
    required: environment.required === true,
    configured: environment.configured === true,
    environment_id: sourceValue(environment.environment_id),
    environment_name: sourceValue(environment.environment_name),
    target_id: sourceValue(environment.target_id),
    scope_valid: environment.scope_valid !== false
  };
  return {
    configuration: configurationBinding,
    environment: environmentBinding,
    design_state_hash: design?.applicable === false ? null : sourceValue(design?.design_state_hash),
    design_source_identity: design?.applicable === false ? null : normalizeSourceIdentity(design?.source_identity || design?.sync || {}),
    infrastructure: infrastructureBinding(infrastructure)
  };
}

export function evaluateReleaseReadiness({
  sourceIdentity: sourceIdentityValue,
  classification = {},
  productionization = {},
  validation = {},
  design = null,
  configuration = {},
  environment = {},
  infrastructure = null,
  evaluationId = crypto.randomUUID(),
  evaluatorVersion = RELEASE_READINESS_EVALUATOR_VERSION,
  evaluatedAt = new Date().toISOString(),
  validating = false
} = {}) {
  const sourceIdentity = normalizeSourceIdentity(sourceIdentityValue || sourceIdentityFromClassification(classification));
  const checks = [];
  checks.push(...classificationChecks({ classification, sourceIdentity, timestamp: evaluatedAt }));
  checks.push(...productionizationChecks({ productionization, sourceIdentity, timestamp: evaluatedAt }));
  const validationChecks = collectValidationChecks({ validation, sourceIdentity, timestamp: evaluatedAt });
  checks.push(...validationChecks);
  checks.push(...buildRequirementCheck({ classification, validationChecks, sourceIdentity, timestamp: evaluatedAt }));
  checks.push(...designChecks({ design, sourceIdentity, timestamp: evaluatedAt }));
  checks.push(...configurationChecks({ configuration, sourceIdentity, timestamp: evaluatedAt }));
  checks.push(...environmentChecks({ environment, sourceIdentity, timestamp: evaluatedAt }));
  checks.push(...infrastructureChecks({ infrastructure, sourceIdentity, timestamp: evaluatedAt }));
  const state = readinessState({ checks, validating });
  const { summary, categories } = summarizeChecks(checks, state);
  const bindings = buildReadinessBindings({ configuration, environment, design, infrastructure });
  const productionRun = productionization.run || productionization.validation_run || null;
  const readyForRelease = state === "READY";
  return {
    contract: RELEASE_READINESS_CONTRACT,
    evaluation_id: evaluationId,
    evaluator_version: evaluatorVersion,
    state,
    status: state,
    ready_for_release: readyForRelease,
    evaluated_at: evaluatedAt,
    source_identity: sourceIdentity,
    repository_intelligence: {
      classification_status: classification.classification_status || "UNKNOWN",
      productionization_safe: classification.productionization_safe === true,
      classification_evidence_ref: classification.evidence_ref || null
    },
    productionization: {
      plan_id: productionization.plan_id || productionization.plan?.id || null,
      run_id: productionRun?.run_id || productionization.run_id || null,
      status: productionRun?.status || productionization.status || null,
      source_snapshot_sha256: productionRun?.source_snapshot_sha256 || productionization.source_snapshot_sha256 || null,
      evidence_refs: array(productionization.evidence_refs)
    },
    design: {
      applicable: design?.applicable !== false,
      design_state_hash: bindings.design_state_hash,
      source_identity: bindings.design_source_identity,
      sync_summary: clone(design?.sync_summary || null),
      reconciliation_evidence_refs: array(design?.evidence_refs)
    },
    infrastructure: infrastructureBinding(infrastructure),
    bindings,
    checks,
    summary: {
      ...summary,
      executive_state: executiveHeadline(state, summary)
    },
    progressive_disclosure: {
      executive: {
        state,
        headline: executiveHeadline(state, summary),
        source_checkpoint: sourceIdentity.checkpoint,
        evaluated_at: evaluatedAt,
        blocking_count: summary.blocking_count,
        review_required_count: summary.review_required_count,
        warning_count: summary.warning_count,
        stale: false
      },
      categories,
      detailed_evidence: checks
    },
    build_eligibility: {
      eligible: readyForRelease,
      reason: readyForRelease
        ? "This exact source is eligible for the existing explicit build action."
        : state === "STALE"
          ? "Reevaluate the current source before requesting a build."
          : "Resolve release readiness gates before requesting a build.",
      requires_explicit_build_action: true
    }
  };
}

function bindingMismatches(evaluation, current = {}) {
  const mismatches = compareSourceIdentity(evaluation?.source_identity, current.source_identity || current.sourceIdentity);
  const storedBindings = evaluation?.bindings || {};
  const currentBindings = current.bindings || buildReadinessBindings({
    configuration: current.configuration || {},
    environment: current.environment || {},
    design: current.design || null,
    infrastructure: current.infrastructure || null
  });
  if ((storedBindings.design_state_hash || null) !== (currentBindings.design_state_hash || null)) {
    mismatches.push({ field: "design_state_hash", expected: storedBindings.design_state_hash || null, observed: currentBindings.design_state_hash || null });
  }
  if (storedBindings.design_source_identity || currentBindings.design_source_identity) {
    for (const mismatch of compareSourceIdentity(storedBindings.design_source_identity || {}, currentBindings.design_source_identity || {})) {
      mismatches.push({ field: `design.${mismatch.field}`, expected: mismatch.expected, observed: mismatch.observed });
    }
  }
  if (JSON.stringify(storedBindings.configuration || {}) !== JSON.stringify(currentBindings.configuration || {})) {
    mismatches.push({ field: "configuration", expected: storedBindings.configuration || {}, observed: currentBindings.configuration || {} });
  }
  if (JSON.stringify(storedBindings.environment || {}) !== JSON.stringify(currentBindings.environment || {})) {
    mismatches.push({ field: "environment", expected: storedBindings.environment || {}, observed: currentBindings.environment || {} });
  }
  if (JSON.stringify(storedBindings.infrastructure || null) !== JSON.stringify(currentBindings.infrastructure || null)) {
    mismatches.push({ field: "infrastructure", expected: storedBindings.infrastructure || null, observed: currentBindings.infrastructure || null });
  }
  return mismatches;
}

export function resolveStoredReleaseReadiness(evaluation, current = {}) {
  if (!evaluation || evaluation.contract !== RELEASE_READINESS_CONTRACT) {
    return {
      contract: RELEASE_READINESS_CONTRACT,
      state: "BLOCKED",
      status: "BLOCKED",
      ready_for_release: false,
      reason: "Evaluate release readiness for the exact current source before requesting a build.",
      build_eligibility: { eligible: false, reason: "No current readiness evaluation exists.", requires_explicit_build_action: true }
    };
  }
  const mismatches = bindingMismatches(evaluation, current);
  const requestedCommit = normalizedCommit(current.source_commit || current.sourceCommit);
  if (requestedCommit && requestedCommit !== normalizedCommit(evaluation.source_identity?.source_commit)) {
    mismatches.push({ field: "requested_source_commit", expected: evaluation.source_identity?.source_commit || null, observed: requestedCommit });
  }
  if (!mismatches.length) return clone(evaluation);
  const stale = clone(evaluation);
  stale.state = "STALE";
  stale.status = "STALE";
  stale.ready_for_release = false;
  stale.stale_reasons = mismatches;
  stale.summary = {
    ...(stale.summary || {}),
    state: "STALE",
    executive_state: executiveHeadline("STALE", stale.summary || {})
  };
  stale.progressive_disclosure = {
    ...(stale.progressive_disclosure || {}),
    executive: {
      ...(stale.progressive_disclosure?.executive || {}),
      state: "STALE",
      headline: executiveHeadline("STALE", stale.summary || {}),
      stale: true,
      stale_reason_count: mismatches.length
    }
  };
  stale.build_eligibility = {
    eligible: false,
    reason: "This readiness result is stale. Reevaluate the current source before requesting a build.",
    requires_explicit_build_action: true
  };
  return stale;
}

export function readinessBindings({ configuration = {}, environment = {}, design = null, infrastructure = null } = {}) {
  return buildReadinessBindings({ configuration, environment, design, infrastructure });
}
