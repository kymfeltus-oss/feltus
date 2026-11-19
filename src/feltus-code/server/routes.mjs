import { createFileTools } from "./file-tools.mjs";
import { createGitTools } from "./git-tools.mjs";
import { createTaskRunner } from "./task-runner.mjs";
import { buildRepoMap } from "./repo-map.mjs";
import { createCodeAgent } from "./agent.mjs";
import { applyChangeSet, inspectChangeSetUndo, reviewChangeSet, undoChangeSet, updateDesignUndoMetadata } from "./change-set.mjs";
import {
  buildContractProtectionMap,
  classifyChangeSetContracts,
  classifyRepository,
  createProductionizationPlan,
  createProductionizationRun,
  evaluateReleaseReadiness,
  normalizeLowRiskSource,
  productionizationChangeSetFingerprint,
  repositorySnapshotHash,
  resolveEngineeringStandard,
  resolveRequiredReleaseChecks,
  scanRepository,
  validateDeterministicJsonChangeSet,
  simulateChangeSetFiles
} from "./repository-productionization.mjs";

/**
 * Framework-neutral FELTUS CODE handlers.
 *
 * FELTUS host requirements:
 * - authenticate before these handlers are called
 * - resolve repoRoot server-side from an authorized project
 * - never accept an absolute repo path from the browser
 */
export function createFeltusCodeHandlers({ repoRoot, aiGateway, approvedTasks, validationTempRoot }) {
  const files = createFileTools({ repoRoot });
  const git = createGitTools({ repoRoot });
  const tasks = createTaskRunner(
    approvedTasks ? { repoRoot, tasks: approvedTasks, validationTempRoot } : { repoRoot, validationTempRoot }
  );
  let agent = null;
  const getAgent = () => {
    if (!agent) agent = createCodeAgent({ repoRoot, aiGateway, fileTools: files });
    return agent;
  };

  async function productionizationContext(applicationId = null, sourceCheckpointId = null, sourceSnapshotSha256 = null, classifierVersion = null) {
    const [headResult, statusBefore, snapshot] = await Promise.all([
      git.head().catch(() => null),
      git.status().then(result => result.stdout).catch(() => ""),
      scanRepository(repoRoot)
    ]);
    const head = typeof headResult === "string" ? headResult : headResult?.stdout?.trim() || null;
    const [headAfterResult, status] = await Promise.all([
      git.head().catch(() => null),
      git.status().then(result => result.stdout).catch(() => "")
    ]);
    const headAfter = typeof headAfterResult === "string" ? headAfterResult : headAfterResult?.stdout?.trim() || null;
    const sourceStable = head === headAfter && statusBefore === status;
    if (!sourceStable) {
      const changedEvidence = [head !== headAfter && "commit", statusBefore !== status && "working-tree"].filter(Boolean).join(" and ");
      throw Object.assign(new Error(`The ${changedEvidence || "source"} changed during classification. Reclassify from the current checkpoint.`), {
        code: "SOURCE_SNAPSHOT_UNSTABLE",
        status: 409
      });
    }
    const dirty = !sourceStable || [statusBefore, status].some(value => String(value).split(/\r?\n/).slice(1).some(Boolean));
    const branchLine = String(status).split(/\r?\n/)[0] || "";
    const sourceBranch = branchLine.startsWith("## ") && !branchLine.includes("(no branch)")
      ? branchLine.slice(3).split("...")[0].trim() || null
      : null;
    if (sourceCheckpointId && head && sourceCheckpointId !== head) {
      throw Object.assign(new Error("The requested source checkpoint no longer matches the current CODE workspace checkpoint."), { code: "SOURCE_CHECKPOINT_STALE", status: 409 });
    }
    const classification = await classifyRepository(repoRoot, {
      applicationId,
      sourceWorkspaceId: applicationId,
      sourceBranch,
      sourceCommit: head,
      sourceCheckpointId: sourceCheckpointId || head,
      snapshot
    });
    if (sourceSnapshotSha256 && classification.source_snapshot_sha256 !== sourceSnapshotSha256) {
      throw Object.assign(new Error("The source snapshot changed after this productionization plan was created."), {
        code: "SOURCE_CLASSIFICATION_STALE",
        status: 409
      });
    }
    if (classifierVersion && classification.classifier_version !== classifierVersion) {
      throw Object.assign(new Error("The Phase E classifier changed after this productionization plan was created."), {
        code: "CLASSIFICATION_VERSION_STALE",
        status: 409
      });
    }
    const contractMap = await buildContractProtectionMap(repoRoot, { snapshot });
    const packageFile = snapshot.files.find(file => file.path === "package.json");
    let packageManifest = null;
    try { packageManifest = packageFile ? JSON.parse(packageFile.content) : null; } catch { packageManifest = null; }
    const engineeringStandard = resolveEngineeringStandard(classification);
    const requiredChecks = resolveRequiredReleaseChecks(classification, packageManifest);
    return { head, status, dirty, snapshot, classification, contractMap, engineeringStandard, requiredChecks };
  }

  async function validateProductionization({ applicationId = null, changeSet = null, sourceCheckpointId = null, sourceSnapshotSha256 = null, classifierVersion = null, signal, suppliedContext = null } = {}) {
    const metadata = changeSet?.productionization || null;
    if (changeSet && !metadata) {
      throw Object.assign(new Error("Productionization validation requires a source-bound plan."), { code: "PRODUCTIONIZATION_PLAN_REQUIRED", status: 409 });
    }
    if (metadata && productionizationChangeSetFingerprint(changeSet) !== metadata.change_set_sha256) {
      throw Object.assign(new Error("The proposed changes no longer match the validated productionization plan."), { code: "PRODUCTIONIZATION_PLAN_CHANGED", status: 409 });
    }
    const context = suppliedContext || await productionizationContext(
      applicationId,
      sourceCheckpointId || metadata?.source_checkpoint,
      sourceSnapshotSha256 || metadata?.source_snapshot_sha256,
      classifierVersion || metadata?.classifier_version
    );
    if (changeSet && (context.classification.productionization_safe !== true || context.classification.classification_status !== "CLASSIFIED")) {
      throw Object.assign(new Error("This repository is not classified as a safe single-stack productionization target."), { code: "PRODUCTIONIZATION_BLOCKED", status: 409 });
    }
    if (metadata && (metadata.source_application_id !== applicationId ||
        metadata.source_workspace_id !== context.classification.source_workspace_id ||
        metadata.source_branch !== context.classification.source_branch ||
        metadata.source_checkpoint !== context.classification.source_checkpoint_id)) {
      throw Object.assign(new Error("The productionization plan belongs to a different application, workspace, branch, or source checkpoint."), { code: "PRODUCTIONIZATION_SOURCE_MISMATCH", status: 409 });
    }
    if (changeSet && context.dirty) {
      throw Object.assign(new Error("The source workspace is not clean. Create a checkpoint and replan before validating changes."), { code: "SOURCE_CHECKPOINT_REQUIRED", status: 409 });
    }
    const run = createProductionizationRun({
      classification: context.classification,
      engineeringStandard: context.engineeringStandard,
      contractMap: context.contractMap,
      beforeCommit: context.head,
      runId: changeSet?.productionization?.run_id || undefined
    });
    const afterFiles = changeSet ? simulateChangeSetFiles(context.snapshot.files, changeSet) : context.snapshot.files;
    const contractReview = changeSet
      ? classifyChangeSetContracts(changeSet, context.contractMap, { beforeFiles: context.snapshot.files, afterFiles })
      : { safe_operations: [], blocked_operations: [] };
    run.blocked_contract_changes = contractReview.blocked_operations;
    run.review_required_changes = contractReview.review_required_operations;

    const taskDefinitions = Object.fromEntries(context.requiredChecks.map(check => [check.id, check.available
      ? { command: check.command, args: check.args, available: true }
      : { command: "node", args: ["--version"], available: false, reason: "Required check was detected but no supported project command is configured." }]));
    const releaseTasks = createTaskRunner({ repoRoot, tasks: taskDefinitions, timeoutMs: 180000, validationTempRoot });
    const results = [];
    const canRunChecks = Boolean(changeSet) || (
      context.classification.productionization_safe === true &&
      context.classification.classification_status === "CLASSIFIED" &&
      context.classification.source_binding_complete === true &&
      !context.dirty
    );
    for (const check of context.requiredChecks) {
      const startedAt = new Date().toISOString();
      let result = null;
      let error = null;
      if (!canRunChecks) {
        results.push({
          ...check,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          exit_code: null,
          status: "NOT_RUN",
          output_summary: "Checks were not run because the source is not a clean, source-bound single-stack workspace.",
          error_code: "PRODUCTIONIZATION_SOURCE_BLOCKED"
        });
        continue;
      }
      if (check.available) {
        try {
          result = changeSet
            ? await releaseTasks.runAgainstChangeSet(check.id, changeSet, { signal })
            : await releaseTasks.runIsolated(check.id, { signal });
        } catch (cause) {
          error = cause;
        }
      }
      const completedAt = new Date().toISOString();
      const unavailable = !check.available || error?.code === "TASK_UNAVAILABLE" || error?.code === "ENOENT";
      const output = [result?.stdout, result?.stderr, error?.message].filter(Boolean).join("\n").slice(-4000);
      const checkResult = {
        ...check,
        started_at: startedAt,
        completed_at: completedAt,
        exit_code: result?.code ?? (unavailable ? null : error ? 1 : null),
        status: unavailable ? "UNAVAILABLE" : result?.code === 0 ? "PASSED" : error || result?.code != null ? "FAILED" : "NOT_RUN",
        output_summary: output,
        error_code: error?.code || null
      };
      results.push(checkResult);
    }
    const deterministicCheck = changeSet
      ? validateDeterministicJsonChangeSet(changeSet, context.snapshot.files, context.contractMap)
      : null;
    if (deterministicCheck) results.push(deterministicCheck);
    const readiness = evaluateReleaseReadiness(results);
    const checkFailures = readiness.checks.some(check => check.blocking);
    const repositoryBehaviorCheckPassed = results.some(check => check.id !== "productionization.json_semantics" && check.required && check.available && check.exit_code === 0);
    const missingBehaviorValidation = changeSet?.productionization?.proposal_type === "AI_REVIEWED" && !repositoryBehaviorCheckPassed;
    if (missingBehaviorValidation) {
      readiness.status = "BLOCKED";
      readiness.ready_for_release = false;
      readiness.blocking_reasons = ["No configured repository test, build, type, lint, or format check ran against this AI proposal."];
    }
    const afterSnapshotHash = repositorySnapshotHash(afterFiles);
    const checkpointAvailable = Boolean(context.head);
    if (contractReview.blocked_operations.length) {
      readiness.status = "BLOCKED";
      readiness.ready_for_release = false;
      readiness.blocking_reasons = ["Protected contract changes must go through an authorized versioned migration workflow."];
    }
    if (!checkpointAvailable || context.dirty || changeSet) {
      readiness.ready_for_release = false;
      readiness.status = contractReview.blocked_operations.length || checkFailures || missingBehaviorValidation || !checkpointAvailable || context.dirty
        ? "BLOCKED"
        : "VALIDATED_FOR_REVIEW";
      readiness.blocking_reasons = [
        ...new Set([
          ...(readiness.blocking_reasons || []),
          !checkpointAvailable ? "A source checkpoint is required." : null,
          context.dirty ? "Checkpoint the current working changes before release validation." : null,
          changeSet ? "The proposed change set must be reviewed, applied and checkpointed before release." : null
        ].filter(Boolean))
      ];
    }
    if (changeSet) readiness.ready_for_review = true;
    run.status = readiness.status;
    run.completed_at = new Date().toISOString();
    run.after_source_commit = context.head;
    run.after_source_snapshot_sha256 = afterSnapshotHash;
    run.source_checkpoint_clean = !context.dirty;
    run.checks = readiness.checks;
    run.transformations = changeSet?.operations?.map(operation => ({
      id: operation.id,
      type: operation.type,
      path: operation.type === "rename" ? operation.to : operation.path,
      before_sha256: operation.before_sha256 || null
    })) || [];
    return {
      run,
      release_readiness: readiness,
      classification: context.classification,
      engineering_standard: context.engineeringStandard,
      contract_review: contractReview,
      behavioral_baseline: run.behavioral_baseline,
      reviewable: Boolean(changeSet),
      ready_for_review: Boolean(changeSet),
      ready_for_release: readiness.ready_for_release && contractReview.blocked_operations.length === 0,
      source_clean: !context.dirty
    };
  }

  async function reviewContracts(changeSet) {
    const { snapshot, contractMap } = await productionizationContext();
    const afterFiles = simulateChangeSetFiles(snapshot.files, changeSet);
    const contractReview = classifyChangeSetContracts(changeSet, contractMap, {
      beforeFiles: snapshot.files,
      afterFiles
    });
    contractReview.blocked_operations = contractReview.blocked_operations.map(item => ({
      ...item,
      affected_contracts: contractMap.contracts.filter(contract => contract.path === item.path).map(contract => ({ kind: contract.kind, value: contract.value })),
      impact: "This path contains a public or persisted contract and is excluded from productionization."
    }));
    contractReview.review_required_operations = contractReview.review_required_operations.map(item => ({
      ...item,
      affected_contracts: contractMap.contracts.filter(contract => contract.path === item.path).map(contract => ({ kind: contract.kind, value: contract.value })),
      impact: "Review the complete diff and compatibility impact before applying this medium-risk change."
    }));
    return contractReview;
  }

  return {
    listTree: async ({ path = "." }) => ({ ok: true, items: await files.list(path) }),
    readFile: async ({ path }) => ({ ok: true, path, ...(await files.inspect(path)) }),
    writeFile: async ({ path, content, expected_sha256 }) => ({ ok: true, ...(await files.write(path, content, { expectedSha256: expected_sha256 })) }),
    createFile: async ({ path, content }) => ({ ok: true, ...(await files.createFile(path, content)) }),
    createDirectory: async ({ path }) => ({ ok: true, ...(await files.createDirectory(path)) }),
    rename: async ({ from, to }) => ({ ok: true, ...(await files.rename(from, to)) }),
    remove: async ({ path, confirm }) => ({ ok: true, ...(await files.remove(path, { confirm })) }),
    search: async ({ q, limit }) => ({ ok: true, results: await files.search(q, { limit }) }),
    repoMap: async () => ({ ok: true, map: await buildRepoMap(repoRoot) }),
    gitStatus: async () => ({ ok: true, ...(await git.status()) }),
    gitStagedPaths: async () => ({ ok: true, paths: await git.stagedPaths() }),
    gitChangedPaths: async () => ({ ok: true, paths: await git.statusPaths() }),
    gitHead: async () => {
      const result = await git.head();
      return { ok: true, commit: (typeof result === "string" ? result : result?.stdout || "").trim() };
    },
    gitInitialize: async () => ({ ok: true, ...(await git.initialize()) }),
    gitDiff: async ({ staged = false }) => ({ ok: true, ...(await git.diff({ staged })) }),
    gitLog: async ({ limit = 20 }) => ({ ok: true, ...(await git.log(limit)) }),
    checkpointCompare: async ({ commit }) => ({ ok: true, ...(await git.compare(commit)) }),
    checkpointRestore: async ({ commit, paths, confirm }) => ({ ok: true, ...(await git.restore({ commit, paths, confirm })) }),
    gitStage: async ({ paths }) => ({ ok: true, ...(await git.stage(paths)) }),
    gitUnstage: async ({ paths }) => ({ ok: true, ...(await git.unstage(paths)) }),
    checkpoint: async ({ message, confirm }) => ({ ok: true, ...(await git.checkpoint({ message, confirm })) }),
    listTasks: async () => ({ ok: true, tasks: tasks.list(), unavailable: tasks.unavailable(), default_task: tasks.defaultTask() }),
    runTask: async ({ task }, { signal } = {}) => ({ ok: true, result: await tasks.run(task, { signal }) }),
    validateTask: async ({ task, files }, { signal } = {}) => ({ ok: true, result: await tasks.runAgainstProposed(task, files, { signal }) }),
    validateChangeSet: async ({ task, changeSet }, { signal } = {}) => ({ ok: true, result: await tasks.runAgainstChangeSet(task, changeSet, { signal }) }),
    productionizationOverview: async ({ applicationId = null } = {}) => {
      const { head, dirty, classification, contractMap, engineeringStandard, requiredChecks } = await productionizationContext(applicationId);
      return { ok: true, result: {
        classification,
        engineering_standard: engineeringStandard,
        contract_protection: {
          version: contractMap.version,
          source_snapshot_sha256: contractMap.source_snapshot_sha256,
          source_snapshot_complete: contractMap.source_snapshot_complete,
          low_risk_file_count: contractMap.low_risk_files.length,
          medium_risk_file_count: contractMap.medium_risk_files.length,
          protected_file_count: contractMap.protected_files.length,
          contract_marker_count: contractMap.contracts.length
        },
        required_checks: requiredChecks,
        source_checkpoint: head,
        source_branch: classification.source_branch,
        source_workspace_id: classification.source_workspace_id,
        source_snapshot_sha256: contractMap.source_snapshot_sha256,
        classification_status: classification.classification_status,
        source_clean: !dirty,
        environment_variable_names: [...new Set(contractMap.contracts
          .filter(contract => contract.kind === "environment_variable")
          .map(contract => contract.value)
          .filter(name => /^[A-Z][A-Z0-9_]*$/.test(String(name))))].sort()
      } };
    },
    designSourceContext: async ({ applicationId = null, sourceIdentity = null } = {}) => {
      const context = await productionizationContext(
        applicationId,
        sourceIdentity?.checkpoint || null,
        sourceIdentity?.snapshot_sha256 || null,
        sourceIdentity?.classifier_version || null
      );
      if (!context.snapshot.complete) throw Object.assign(new Error("Design Studio needs a complete source snapshot before creating a synchronized visual proposal."), { code: "DESIGN_SOURCE_SNAPSHOT_INCOMPLETE", status: 409 });
      return { ok: true, result: {
        files: context.snapshot.files.filter(file => /\.html?$/i.test(file.path) || file.path === "src/feltus-design.css"),
        snapshot: context.snapshot,
        classification: context.classification,
        contract_map: context.contractMap,
        source_identity: {
          application_id: applicationId,
          workspace_id: context.classification.source_workspace_id,
          branch: context.classification.source_branch,
          checkpoint: context.head,
          snapshot_sha256: context.snapshot.snapshot_sha256,
          classifier_version: context.classification.classifier_version,
          source_clean: !context.dirty
        }
      } };
    },
    designContractReview: async ({ applicationId = null, changeSet, sourceIdentity } = {}) => {
      const context = await productionizationContext(
        applicationId,
        sourceIdentity?.checkpoint || null,
        sourceIdentity?.snapshot_sha256 || null,
        sourceIdentity?.classifier_version || null
      );
      if (context.dirty) throw Object.assign(new Error("The Design Studio source changed after this proposal. Reconcile and create a new proposal."), { code: "DESIGN_SOURCE_STALE", status: 409 });
      const afterFiles = simulateChangeSetFiles(context.snapshot.files, changeSet);
      const review = classifyChangeSetContracts(changeSet, context.contractMap, { beforeFiles: context.snapshot.files, afterFiles });
      review.blocked_operations = review.blocked_operations.map(item => ({
        ...item,
        affected_contracts: context.contractMap.contracts.filter(contract => contract.path === item.path).map(contract => ({ kind: contract.kind, value: contract.value })),
        impact: "This visual change would alter a protected application contract and is blocked."
      }));
      review.review_required_operations = review.review_required_operations.map(item => ({
        ...item,
        affected_contracts: context.contractMap.contracts.filter(contract => contract.path === item.path).map(contract => ({ kind: contract.kind, value: contract.value })),
        impact: "Review the complete visual source diff and compatibility impact before applying this change."
      }));
      return { ok: true, result: { review, source_identity: {
        application_id: applicationId,
        workspace_id: context.classification.source_workspace_id,
        branch: context.classification.source_branch,
        checkpoint: context.head,
        snapshot_sha256: context.snapshot.snapshot_sha256,
        classifier_version: context.classification.classifier_version,
        source_clean: !context.dirty
      } } };
    },
    productionizationPlan: async ({ applicationId = null }, { signal } = {}) => {
      const context = await productionizationContext(applicationId);
      const baseline = await validateProductionization({ applicationId, suppliedContext: context, signal });
      const current = await productionizationContext(
        applicationId,
        context.head,
        context.snapshot.snapshot_sha256,
        context.classification.classifier_version
      );
      const plan = createProductionizationPlan({
        classification: current.classification,
        engineeringStandard: current.engineeringStandard,
        contractMap: current.contractMap,
        snapshot: current.snapshot,
        sourceClean: !current.dirty,
        baseline: {
          status: baseline.run.status,
          source_snapshot_sha256: baseline.run.source_snapshot_sha256,
          evidence_status: baseline.run.checks.some(check => check.required && check.available) ? "EXISTING_CHECKS_RUN" : "NO_CONFIGURED_CHECKS",
          checks: baseline.run.checks
        }
      });
      return { ok: true, result: plan };
    },
    productionizationValidate: async ({ applicationId = null, changeSet = null, sourceCheckpointId = null, sourceSnapshotSha256 = null, classifierVersion = null }, { signal } = {}) => ({
      ok: true,
      result: await validateProductionization({ applicationId, changeSet, sourceCheckpointId, sourceSnapshotSha256, classifierVersion, signal })
    }),
    aiProductionize: async ({ prompt, context, model, applicationId }, { signal } = {}) => {
      const production = await productionizationContext(applicationId);
      if (production.classification.productionization_safe !== true || production.classification.classification_status !== "CLASSIFIED") {
        throw Object.assign(new Error("This repository is not a safe single-stack productionization target."), { code: "PRODUCTIONIZATION_BLOCKED", status: 409 });
      }
      if (!production.classification.application_id || !production.classification.source_binding_complete || !production.classification.source_branch || !production.head) {
        throw Object.assign(new Error("Productionization requires an application identity and a complete branch and checkpoint binding."), { code: "PRODUCTIONIZATION_SOURCE_REQUIRED", status: 409 });
      }
      if (production.dirty) {
        throw Object.assign(new Error("Create a source checkpoint before requesting productionization changes."), { code: "SOURCE_CHECKPOINT_REQUIRED", status: 409 });
      }
      const baseline = await validateProductionization({ applicationId, suppliedContext: production, signal });
      const policyContext = {
        ...context,
        repository_productionization: {
          source_checkpoint: production.head,
          source_snapshot_sha256: production.snapshot.snapshot_sha256,
          classification: {
            classifier_version: production.classification.classifier_version,
            languages: production.classification.languages,
            frameworks: production.classification.frameworks,
            runtimes: production.classification.runtimes,
            package_managers: production.classification.package_managers,
            build_systems: production.classification.build_systems,
            formatters: production.classification.formatters,
            linters: production.classification.linters,
            type_checkers: production.classification.type_checkers,
            test_runners: production.classification.test_runners,
            databases: production.classification.databases,
            migration_tools: production.classification.migration_tools
          },
          engineering_standard: production.engineeringStandard,
          required_checks: production.requiredChecks,
          contract_protection: {
            version: production.contractMap.version,
            protected_files: production.contractMap.protected_files
              .filter(item => (context?.editor?.selected_files || []).some(file => file.path === item.path))
              .slice(0, 12),
            contracts: production.contractMap.contracts
              .filter(item => (context?.editor?.selected_files || []).some(file => file.path === item.path))
              .slice(0, 300)
          }
        }
      };
      const safeNormalization = normalizeLowRiskSource(
        production.snapshot.files,
        production.contractMap,
        (context?.editor?.selected_files || []).map(file => file.path)
      );
      const proposed = safeNormalization || await getAgent().proposeChangeSet({
        prompt: `${prompt}\n\nProductionization requirements: make only safe, idiomatic improvements for the detected repository stack; preserve runtime behavior and all mapped contracts. Do not edit contract-protected paths or alter API routes, database schema, environment variable names, persisted values, or serialized state. Prefer existing native formatters and repository conventions when selected file context shows them. Return a reviewable change set only.`,
        context: policyContext,
        model,
        mode: "productionize",
        signal
      });
      const afterFiles = simulateChangeSetFiles(production.snapshot.files, proposed);
      const contractReview = classifyChangeSetContracts(proposed, production.contractMap, {
        beforeFiles: production.snapshot.files,
        afterFiles
      });
      const run = createProductionizationRun({
        classification: production.classification,
        engineeringStandard: production.engineeringStandard,
        contractMap: production.contractMap,
        beforeCommit: production.head
      });
      run.status = "READY_FOR_REVIEW";
      run.behavioral_baseline = {
        status: baseline.run.status,
        source_snapshot_sha256: baseline.run.source_snapshot_sha256,
        evidence_status: baseline.run.checks.some(check => check.required && check.available) ? "EXISTING_CHECKS_RUN" : "NO_CONFIGURED_CHECKS",
        checks: baseline.run.checks
      };
      run.after_source_snapshot_sha256 = repositorySnapshotHash(afterFiles);
      run.transformations = proposed.operations.map(operation => ({
        id: operation.id,
        type: operation.type,
        path: operation.type === "rename" ? operation.to : operation.path,
        before_sha256: operation.before_sha256 || null
      }));
      run.blocked_contract_changes = contractReview.blocked_operations;
      run.review_required_changes = contractReview.review_required_operations;
      if (contractReview.blocked_operations.length) run.status = "BLOCKED";
      const changeSetSha256 = productionizationChangeSetFingerprint(proposed);
      return {
        ok: true,
        result: {
          ...proposed,
          productionization: {
            source_checkpoint: production.head,
            source_snapshot_sha256: production.snapshot.snapshot_sha256,
            after_source_snapshot_sha256: run.after_source_snapshot_sha256,
            classifier_version: production.classification.classifier_version,
            run_id: run.run_id,
            run,
            plan_id: crypto.randomUUID(),
            source_application_id: applicationId,
            source_workspace_id: production.classification.source_workspace_id,
            source_branch: production.classification.source_branch,
            classifier_version: production.classification.classifier_version,
            change_set_sha256: changeSetSha256,
            proposal_type: "AI_REVIEWED",
            contract_review: contractReview,
            blocked_contract_changes: contractReview.blocked_operations
          }
        }
      };
    },
    aiPlan: async ({ prompt, paths, model }, { signal, onToken } = {}) => ({
      ok: true,
      result: await getAgent().plan({ prompt, paths, model, signal, onToken })
    }),
    aiEdit: async ({ prompt, paths, model }, { signal } = {}) => ({
      ok: true,
      result: await getAgent().proposeEdit({ prompt, paths, model, signal })
    }),
    aiArchitect: async ({ prompt, context, model }, { signal } = {}) => ({
      ok: true,
      result: await getAgent().architectPlan({ prompt, context, model, signal })
    }),
    aiDesignProposal: async input => ({ ok: true, result: await getAgent().proposeDesignChanges(input) }),
    aiChangeSet: async ({ prompt, context, plan, model, mode }, { signal } = {}) => ({
      ok: true,
      result: await getAgent().proposeChangeSet({ prompt, context, plan, model, mode, signal })
    }),
    reviewChangeSet: async ({ changeSet, selectedIds }) => ({
      ok: true,
      result: {
        ...(await reviewChangeSet({ repoRoot, changeSet, selectedIds })),
        contract_review: await reviewContracts(changeSet)
      }
    }),
    classifyChangeSetContracts: async ({ changeSet }) => ({ ok: true, result: await reviewContracts(changeSet) }),
    applyChangeSet: async ({ changeSet, selectedIds, confirmDestructive }, { signal } = {}) => {
      if (signal?.aborted) throw Object.assign(new Error("Change set request was cancelled."), { code: "REQUEST_CANCELLED" });
      if (changeSet?.productionization) {
        const metadata = changeSet.productionization;
        if (metadata.release_readiness?.status !== "VALIDATED_FOR_REVIEW" || metadata.release_readiness?.checks?.some(check => check.blocking)) {
          throw Object.assign(new Error("Productionization changes can be applied only after all required isolated checks pass."), { code: "PRODUCTIONIZATION_VALIDATION_REQUIRED", status: 409 });
        }
        if (productionizationChangeSetFingerprint(changeSet) !== metadata.change_set_sha256) {
          throw Object.assign(new Error("The proposed changes no longer match the productionization plan."), { code: "PRODUCTIONIZATION_PLAN_CHANGED", status: 409 });
        }
        const context = await productionizationContext(
          metadata.source_application_id,
          metadata.source_checkpoint,
          metadata.source_snapshot_sha256,
          metadata.classifier_version
        );
        if (context.dirty || context.classification.productionization_safe !== true || context.classification.classification_status !== "CLASSIFIED") {
          throw Object.assign(new Error("The source workspace changed or is not safe for productionization."), { code: "PRODUCTIONIZATION_SOURCE_STALE", status: 409 });
        }
        if (metadata.source_application_id !== context.classification.application_id ||
            metadata.source_workspace_id !== context.classification.source_workspace_id ||
            metadata.source_branch !== context.classification.source_branch ||
            metadata.source_checkpoint !== context.classification.source_checkpoint_id) {
          throw Object.assign(new Error("The productionization plan no longer matches this workspace."), { code: "PRODUCTIONIZATION_SOURCE_MISMATCH", status: 409 });
        }
        const afterFiles = simulateChangeSetFiles(context.snapshot.files, changeSet);
        const contractReview = classifyChangeSetContracts(changeSet, context.contractMap, { beforeFiles: context.snapshot.files, afterFiles });
        if (contractReview.blocked_operations.length) {
          throw Object.assign(new Error("Protected contract changes cannot be applied by repository productionization."), { code: "PRODUCTIONIZATION_CONTRACT_CHANGE_BLOCKED", status: 409 });
        }
      }
      return {
        ok: true,
        result: await applyChangeSet({ repoRoot, changeSet, selectedIds, confirmDestructive })
      };
    },
    undoChangeSet: async ({ token, confirm }, { signal } = {}) => {
      if (signal?.aborted) throw Object.assign(new Error("Undo request was cancelled."), { code: "REQUEST_CANCELLED" });
      return { ok: true, result: await undoChangeSet({ repoRoot, token, confirm }) };
    },
    inspectUndoChangeSet: async ({ token }) => ({ ok: true, result: await inspectChangeSetUndo({ repoRoot, token }) }),
    updateDesignUndoMetadata: async ({ token, metadata }) => {
      await updateDesignUndoMetadata({ repoRoot, token, metadata });
      return { ok: true };
    },
    applyEdit: async ({ files: proposedFiles, allowedPaths }, { signal } = {}) => {
      if (!Array.isArray(proposedFiles) || proposedFiles.length < 1 || proposedFiles.length > 12) {
        throw Object.assign(new Error("Accept between 1 and 12 proposed files."), { code: "INVALID_EDIT_PROPOSAL" });
      }
      const allowed = new Set(Array.isArray(allowedPaths) ? allowedPaths : []);
      const pending = [];
      const seen = new Set();
      for (const file of proposedFiles) {
        if (signal?.aborted) throw Object.assign(new Error("Edit request was cancelled."), { code: "REQUEST_CANCELLED" });
        if (!allowed.has(file?.path) || typeof file?.content !== "string" || seen.has(file.path)) {
          throw Object.assign(new Error("Edit proposal contains an unselected path."), { code: "INVALID_EDIT_PROPOSAL" });
        }
        const currentFile = await files.inspect(file.path, { forAI: true });
        if (currentFile.sha256 !== file.before_sha256) {
          throw Object.assign(new Error(`File changed since the proposal was generated: ${file.path}`), { code: "EDIT_CONFLICT" });
        }
        seen.add(file.path);
        if (currentFile.content !== file.content) pending.push(file);
      }
      const applied = [];
      for (const file of pending) applied.push(await files.write(file.path, file.content, { expectedSha256: file.before_sha256 }));
      return { ok: true, files: applied };
    }
  };
}
