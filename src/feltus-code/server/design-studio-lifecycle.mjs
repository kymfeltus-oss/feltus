import {
  componentSyncSummary,
  createDesignState,
  DESIGN_RECIPES,
  designStateHash,
  managedDesignSourceSnippets,
  prepareDesignProposal,
  recommendDesignRecipes,
  reconcileDesignSource,
  validateDesignState
} from "./design-studio.mjs";

const proposals = new Map();
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const BROAD_SCOPE = /\b(global|application[- ]wide|entire app|whole app|all components|every component)\b/i;

function fail(message, code, status = 409, extra = {}) {
  return Object.assign(new Error(message), { code, status, ...extra });
}

function stateIdentity(identity = {}) {
  return {
    workspace_id: identity.workspace_id || null,
    branch: identity.branch || null,
    commit: identity.checkpoint || null,
    snapshot_sha256: identity.snapshot_sha256 || null,
    classifier_version: identity.classifier_version || null,
    clean: identity.source_clean === true
  };
}

function sameIdentity(left = {}, right = {}) {
  return ["application_id", "workspace_id", "branch", "checkpoint", "snapshot_sha256", "classifier_version"]
    .every(key => (left[key] || null) === (right[key] || null));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function pruneProposals(now = Date.now()) {
  for (const [id, proposal] of proposals) if (now - proposal.created_at > PROPOSAL_TTL_MS) proposals.delete(id);
  while (proposals.size >= 100) proposals.delete(proposals.keys().next().value);
}

export function createDesignStudioLifecycle({ app, code, userId, readState, saveState, recordAction }) {
  if (!app?.id || !code || typeof readState !== "function" || typeof saveState !== "function") throw new TypeError("Design Studio requires an authorized app, CODE handlers, and state persistence.");

  async function sourceContext(sourceIdentity = null) {
    const value = await code.designSourceContext({ applicationId: app.id, sourceIdentity });
    if (!value?.ok || !value.result) throw fail("Design source context could not be read.", "DESIGN_SOURCE_UNAVAILABLE", 500);
    return value.result;
  }

  async function get() {
    const [stored, source] = await Promise.all([readState(), sourceContext()]);
    const intelligence = stored.setup_data?.intelligence || stored.setup_data?.application_intelligence || {};
    const schema = await code.loadDesignCapabilities?.({ applicationId: app.id }) || {};
    const capabilities = {
      ...(stored.setup_data?.capability_graph || stored.setup_data?.capabilities || {}),
      data_models: Boolean(schema.models?.length),
      relationships: Boolean(schema.relationships?.length),
      knowledge_documents: Boolean(schema.knowledge_documents || stored.setup_data?.knowledge?.documents?.length || stored.setup_data?.knowledge_documents?.length)
    };
    const storedState = stored.setup_data?.code?.design
      ? validateDesignState(stored.setup_data.code.design)
      : null;
    const initial = storedState || createDesignState({
      application: { id: app.id, name: app.app_name, type: app.app_type },
      intelligence,
      capabilities,
      files: source.files,
      sourceIdentity: stateIdentity(source.source_identity)
    });
    const observed = reconcileDesignSource(initial, source.files, stateIdentity(source.source_identity));
    return {
      ok: true,
      initialized: Boolean(storedState),
      design_state: storedState || initial,
      design_state_hash: designStateHash(storedState || initial),
      observed_state: observed.state,
      reconciliation: observed.decisions,
      sync_summary: componentSyncSummary(observed.state),
      recommendations: recommendDesignRecipes({ application: { id: app.id, name: app.app_name, type: app.app_type }, intelligence, capabilities }),
      recipes: DESIGN_RECIPES.map(({ id, name, family, direction }) => ({ id, name, family, direction })),
      source_identity: source.source_identity,
      source_clean: source.source_identity.source_clean,
      undo_available: Boolean(stored.setup_data?.code?.design_undo?.undo_ref)
    };
  }

  async function initialize() {
    const stored = await readState();
    if (stored.setup_data?.code?.design) return get();
    const source = await sourceContext();
    const schema = await code.loadDesignCapabilities?.({ applicationId: app.id }) || {};
    const state = createDesignState({
      application: { id: app.id, name: app.app_name, type: app.app_type },
      intelligence: stored.setup_data?.intelligence || stored.setup_data?.application_intelligence || {},
      capabilities: {
        ...(stored.setup_data?.capability_graph || stored.setup_data?.capabilities || {}),
        data_models: Boolean(schema.models?.length),
        relationships: Boolean(schema.relationships?.length),
        knowledge_documents: Boolean(schema.knowledge_documents || stored.setup_data?.knowledge?.documents?.length || stored.setup_data?.knowledge_documents?.length)
      },
      files: source.files,
      sourceIdentity: stateIdentity(source.source_identity)
    });
    const saved = await saveState({ expectedStateHash: null, designState: state, undoRecord: null });
    await recordAction?.({ actionType: "design.initialize", summary: "Initialized the application's FELTUS Design State", details: { design_state_hash: designStateHash(state), component_count: state.components.length } });
    return { ok: true, initialized: true, design_state: state, design_state_hash: designStateHash(state), source_identity: source.source_identity, sync_summary: componentSyncSummary(state), setup_updated_at: saved.setup_updated_at };
  }

  async function reconcile() {
    const stored = await readState();
    const current = stored.setup_data?.code?.design;
    if (!current) throw fail("Initialize Design Studio before reconciling source changes.", "DESIGN_STATE_REQUIRED", 409);
    const before = validateDesignState(current);
    const source = await sourceContext();
    const result = reconcileDesignSource(before, source.files, stateIdentity(source.source_identity));
    const saved = await saveState({ expectedStateHash: designStateHash(before), designState: result.state, undoRecord: stored.setup_data?.code?.design_undo || null });
    await recordAction?.({ actionType: "design.reconcile", summary: "Reconciled component-scoped Design Studio source state", resultStatus: result.decisions.some(item => item.outcome === "RECONCILIATION_REQUIRED") ? "review_required" : "complete", details: { source_identity: source.source_identity, decisions: result.decisions, sync_summary: result.summary } });
    return { ok: true, design_state: result.state, design_state_hash: designStateHash(result.state), reconciliation: result.decisions, sync_summary: result.summary, source_identity: source.source_identity, setup_updated_at: saved.setup_updated_at };
  }

  async function makeProposal({ actions, base_state_hash, summary = null, model = null, usage = null }) {
    const stored = await readState();
    const current = stored.setup_data?.code?.design;
    if (!current) throw fail("Initialize Design Studio before making visual changes.", "DESIGN_STATE_REQUIRED", 409);
    const before = validateDesignState(current);
    const currentHash = designStateHash(before);
    if (base_state_hash !== currentHash) throw fail("Design State changed while this request was open. Refresh Design Studio and try again.", "DESIGN_STATE_STALE", 409);
    const source = await sourceContext();
    const identity = source.source_identity;
    if (!identity.source_clean) throw fail("Create a CODE checkpoint and reconcile current source changes before proposing a visual edit.", "DESIGN_SOURCE_CHECKPOINT_REQUIRED", 409);
    if (!identity.checkpoint || !identity.branch || !identity.classifier_version || !identity.snapshot_sha256) throw fail("A branch, checkpoint, classifier version, and complete source snapshot are required for visual changes.", "DESIGN_SOURCE_IDENTITY_REQUIRED", 409);
    const proposal = prepareDesignProposal({
      currentState: before,
      actions,
      files: source.files,
      applicationId: app.id,
      sourceIdentity: stateIdentity(identity)
    });
    proposal.summary = String(summary || "Review these bounded visual changes").slice(0, 1000);
    proposal.model = model;
    proposal.usage = usage || null;
    pruneProposals();
    proposals.set(proposal.id, {
      proposal,
      app_id: app.id,
      user_id: userId,
      reviewed: false,
      created_at: Date.now()
    });
    return { ok: true, proposal: {
      id: proposal.id,
      summary: proposal.summary,
      scope: proposal.scope,
      base_state_hash: proposal.base_state_hash,
      after_state_hash: proposal.after_state_hash,
      after_state: proposal.after_state,
      preview_css: proposal.preview_css,
      operations: proposal.change_set.operations.map(operation => ({ id: operation.id, type: operation.type, path: operation.path, reason: operation.reason }))
    } };
  }

  async function propose(input) {
    return makeProposal(input);
  }

  async function proposeAI({ prompt, base_state_hash, selected_page_id = null, selected_component_id = null, responsive_target = "desktop", aiProposal }) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 3000) throw fail("Describe a design change in 1 to 3000 characters.", "DESIGN_PROMPT_INVALID", 400);
    const stateData = await readState();
    const state = stateData.setup_data?.code?.design ? validateDesignState(stateData.setup_data.code.design) : null;
    if (!state) throw fail("Initialize Design Studio before using AI Design Chat.", "DESIGN_STATE_REQUIRED", 409);
    if (designStateHash(state) !== base_state_hash) throw fail("Design State changed while this chat was open. Refresh Design Studio and try again.", "DESIGN_STATE_STALE", 409);
    const component = selected_component_id ? state.components.find(item => item.id === selected_component_id) : null;
    const page = selected_page_id ? state.pages.find(item => item.id === selected_page_id) : null;
    if (selected_component_id && !component) throw fail("The selected component is no longer available.", "DESIGN_COMPONENT_NOT_FOUND", 409);
    if (component && component.ownership_state !== "FELTUS_MANAGED") return { ok: true, blocked: true, message: "This component is Developer Managed. Reconnect visual editing before asking Design Studio AI to change it." };
    if (selected_page_id && !page) throw fail("The selected page is no longer available.", "DESIGN_PAGE_NOT_FOUND", 409);
    if (!component && selected_page_id && state.components.some(item => item.page_id === selected_page_id && item.ownership_state === "FELTUS_MANAGED") === false) throw fail("The selected page has no FELTUS managed components to edit.", "DESIGN_PAGE_UNMANAGED", 409);
    if (!["desktop", "tablet", "mobile"].includes(responsive_target)) throw fail("Choose Desktop, Tablet, or Mobile.", "DESIGN_RESPONSIVE_TARGET_INVALID", 400);
    const source = await sourceContext();
    const intelligence = stateData.setup_data?.intelligence || stateData.setup_data?.application_intelligence || {};
    const schema = await code.loadDesignCapabilities?.({ applicationId: app.id }) || {};
    const capabilities = {
      ...(stateData.setup_data?.capability_graph || stateData.setup_data?.capabilities || {}),
      data_models: Boolean(schema.models?.length),
      relationships: Boolean(schema.relationships?.length),
      knowledge_documents: Boolean(schema.knowledge_documents || stateData.setup_data?.knowledge?.documents?.length || stateData.setup_data?.knowledge_documents?.length)
    };
    const ai = await aiProposal({
      prompt,
      designState: state,
      application: { id: app.id, name: app.app_name, type: app.app_type },
      intelligence,
      capabilities,
      selectedPage: page,
      selectedComponent: component,
      guardrails: state.brand_guardrails,
      responsiveTarget: responsive_target,
      sourceContext: managedDesignSourceSnippets(source.files, state.components, { pageId: page?.id || null, componentId: component?.id || null })
    });
    if (!Array.isArray(ai?.actions) || !ai.actions.length) return { ok: true, blocked: true, message: ai?.summary || "The request needs a change outside the supported Design Studio contract." };
    const requestedBroadScope = BROAD_SCOPE.test(prompt);
    const scopedActions = ai.actions.map(action => {
      if (action.type !== "edit") {
        if ((component || page) && !requestedBroadScope) throw fail("AI Design Chat may change only the selected scope unless the request explicitly asks for a broader design.", "DESIGN_AI_SCOPE_BLOCKED", 409);
        return action;
      }
      return { ...action, changes: action.changes.map(change => {
        if (change.target !== "component") {
          if ((component || page) && !requestedBroadScope) throw fail("AI Design Chat may change only the selected scope unless the request explicitly asks for a broader design.", "DESIGN_AI_SCOPE_BLOCKED", 409);
          return change;
        }
        const target = state.components.find(item => item.id === change.component_id);
        if (component && !requestedBroadScope && change.component_id !== component.id) throw fail("AI Design Chat may change only the selected component unless the request explicitly asks for a broader design.", "DESIGN_AI_SCOPE_BLOCKED", 409);
        if (!component && page && !requestedBroadScope && target?.page_id !== page.id) throw fail("AI Design Chat may change only the selected page unless the request explicitly asks for a broader design.", "DESIGN_AI_SCOPE_BLOCKED", 409);
        return { ...change, responsive_target: change.responsive_target || responsive_target };
      }) };
    });
    const proposal = await makeProposal({ actions: scopedActions, base_state_hash, summary: ai.summary, model: ai.model, usage: ai.usage });
    return { ...proposal, prompt };
  }

  async function ownedProposal(id) {
    const entry = proposals.get(String(id));
    if (!entry || entry.app_id !== app.id || entry.user_id !== userId || Date.now() - entry.created_at > PROPOSAL_TTL_MS) throw fail("This Design Studio proposal expired or belongs to another application session. Create a new proposal.", "DESIGN_PROPOSAL_EXPIRED", 409);
    return entry;
  }

  async function review({ proposal_id }) {
    const entry = await ownedProposal(proposal_id);
    const { proposal } = entry;
    const stored = await readState();
    const current = stored.setup_data?.code?.design;
    if (!current || designStateHash(validateDesignState(current)) !== proposal.base_state_hash) throw fail("Design State changed after this proposal was created.", "DESIGN_STATE_STALE", 409);
    const source = await sourceContext(proposal.source_identity);
    if (!source.source_identity.source_clean || !sameIdentity(proposal.source_identity, { ...source.source_identity, application_id: app.id })) throw fail("The source checkpoint, branch, classifier, or snapshot changed. Reconcile and create a new proposal.", "DESIGN_SOURCE_STALE", 409);
    const review = await code.reviewChangeSet({ changeSet: proposal.change_set });
    const contracts = await code.designContractReview({ applicationId: app.id, changeSet: proposal.change_set, sourceIdentity: proposal.source_identity });
    if (contracts.result.review.blocked_operations.length) throw fail("This visual proposal changes a protected application contract and is blocked.", "DESIGN_PROTECTED_CONTRACT_BLOCKED", 409, { contract_review: contracts.result.review });
    entry.reviewed = true;
    entry.review_result = { changes: review.result, contract_review: contracts.result.review, source_identity: source.source_identity };
    return { ok: true, proposal_id, summary: proposal.summary, changes: review.result, contract_review: contracts.result.review, source_identity: source.source_identity };
  }

  async function apply({ proposal_id, confirm_review = false, signal }) {
    const entry = await ownedProposal(proposal_id);
    if (entry.applying) throw fail("This proposal is already being applied.", "DESIGN_PROPOSAL_BUSY", 409);
    if (!entry.reviewed || !confirm_review) throw fail("Review the complete change set and confirm before applying it.", "DESIGN_REVIEW_REQUIRED", 409);
    entry.applying = true;
    const { proposal } = entry;
    let applied = null;
    let staged = false;
    let checkpointed = false;
    let stateSaved = false;
    const paths = sortedUnique(proposal.change_set.operations.map(operation => operation.path));
    try {
      if (signal?.aborted) throw fail("Design apply was cancelled before validation.", "REQUEST_CANCELLED", 499);
      const stored = await readState();
      const current = stored.setup_data?.code?.design;
      if (!current || designStateHash(validateDesignState(current)) !== proposal.base_state_hash) throw fail("Design State changed after review.", "DESIGN_STATE_STALE", 409);
      const source = await sourceContext(proposal.source_identity);
      if (!source.source_identity.source_clean || !sameIdentity(proposal.source_identity, { ...source.source_identity, application_id: app.id })) throw fail("The source checkpoint, branch, classifier, or snapshot changed after review.", "DESIGN_SOURCE_STALE", 409);
      const [changedBefore, stagedBefore] = await Promise.all([code.gitChangedPaths(), code.gitStagedPaths()]);
      if (changedBefore.paths.length || stagedBefore.paths.length) throw fail("The CODE workspace changed after the design checkpoint. Preserve those edits, checkpoint them, and create a new visual proposal.", "DESIGN_SOURCE_STALE", 409);
      await code.reviewChangeSet({ changeSet: proposal.change_set });
      const contracts = await code.designContractReview({ applicationId: app.id, changeSet: proposal.change_set, sourceIdentity: proposal.source_identity });
      if (contracts.result.review.blocked_operations.length) throw fail("This visual proposal changes a protected application contract and is blocked.", "DESIGN_PROTECTED_CONTRACT_BLOCKED", 409, { contract_review: contracts.result.review });
      const taskCatalog = await code.listTasks();
      const task = taskCatalog.default_task;
      if (!task || !(taskCatalog.tasks || []).includes(task)) throw fail("This CODE workspace has no available allowlisted validation task for Design Studio changes.", "DESIGN_VALIDATION_UNAVAILABLE", 409);
      const validation = await code.validateChangeSet({ task, changeSet: proposal.change_set }, { signal });
      if (validation.result?.code !== 0) throw fail("The Design Studio change set did not pass isolated CODE validation.", "DESIGN_VALIDATION_FAILED", 422, { validation: validation.result });
      if (signal?.aborted) throw fail("Design apply was cancelled before source changes were written.", "REQUEST_CANCELLED", 499);
      const result = await code.applyChangeSet({ changeSet: proposal.change_set, selectedIds: proposal.change_set.operations.map(operation => operation.id), confirmDestructive: false }, { signal });
      applied = result.result;
      const changedAfterApply = sortedUnique((await code.gitChangedPaths()).paths);
      if (JSON.stringify(changedAfterApply) !== JSON.stringify(paths)) throw fail("The Design Studio write touched unexpected source paths. CODE undo will restore only this proposal.", "DESIGN_APPLY_SCOPE_MISMATCH", 409);
      await code.gitStage({ paths });
      staged = true;
      const [stagedAfter, changedAfterStage] = await Promise.all([code.gitStagedPaths(), code.gitChangedPaths()]);
      if (JSON.stringify(sortedUnique(stagedAfter.paths)) !== JSON.stringify(paths) || JSON.stringify(sortedUnique(changedAfterStage.paths)) !== JSON.stringify(paths)) throw fail("The staged Design Studio paths changed unexpectedly. CODE undo will restore only this proposal.", "DESIGN_STAGE_SCOPE_MISMATCH", 409);
      await code.checkpoint({ message: `Design Studio · ${proposal.summary}`.slice(0, 190), confirm: true });
      checkpointed = true;
      const head = await code.gitHead();
      const afterSource = await sourceContext();
      if (!afterSource.source_identity.source_clean) throw fail("The source changed after the Design Studio checkpoint. Reconcile it before saving the visual state.", "DESIGN_SOURCE_STALE", 409);
      const nextState = reconcileDesignSource(proposal.after_state, afterSource.files, stateIdentity(afterSource.source_identity), { allowManagedStylesheetUpdate: true }).state;
      nextState.sync.status = "SYNCED";
      nextState.sync.source_clean = true;
      const undoRecord = { undo_ref: applied.undo_token, change_set_id: applied.change_set_id, source_checkpoint: head.commit, source_snapshot_sha256: afterSource.source_identity.snapshot_sha256, created_at: new Date().toISOString() };
      await code.updateDesignUndoMetadata({
        token: applied.undo_token,
        metadata: {
          ...proposal.change_set.feltus_design,
          source_checkpoint: head.commit,
          source_snapshot_sha256: afterSource.source_identity.snapshot_sha256,
          after_state_hash: designStateHash(nextState),
          after_state: nextState
        }
      });
      await saveState({ expectedStateHash: proposal.base_state_hash, designState: nextState, undoRecord });
      stateSaved = true;
      await recordAction?.({ actionType: "design.apply", summary: proposal.summary, details: { proposal_id, change_set_id: applied.change_set_id, paths, before_state_hash: proposal.base_state_hash, after_state_hash: designStateHash(nextState), source_identity_before: proposal.source_identity, source_identity_after: afterSource.source_identity, contract_review: contracts.result.review, validation: { task, code: validation.result.code } } });
      proposals.delete(proposal_id);
      return { ok: true, design_state: nextState, design_state_hash: designStateHash(nextState), source_identity: afterSource.source_identity, sync_summary: componentSyncSummary(nextState), checkpoint: head.commit, paths, undo_available: true };
    } catch (error) {
      if (applied && !stateSaved) {
        try {
          if (staged) await code.gitUnstage({ paths });
          const restored = await code.undoChangeSet({ token: applied.undo_token, confirm: true });
          const restoredPaths = sortedUnique(restored.result?.restored || []);
          if (JSON.stringify(restoredPaths) !== JSON.stringify(paths)) throw fail("CODE undo restored an unexpected set of paths while rolling back the failed Design Studio save.", "DESIGN_ROLLBACK_SCOPE_MISMATCH");
          if (checkpointed) {
            const changed = sortedUnique((await code.gitChangedPaths()).paths);
            if (JSON.stringify(changed) !== JSON.stringify(paths)) throw fail("The failed Design Studio change could not be rolled back with exact path scope.", "DESIGN_ROLLBACK_SCOPE_MISMATCH");
            await code.gitStage({ paths });
            const [stagedPaths, changedAfterStage] = await Promise.all([code.gitStagedPaths(), code.gitChangedPaths()]);
            if (JSON.stringify(sortedUnique(stagedPaths.paths)) !== JSON.stringify(paths) || JSON.stringify(sortedUnique(changedAfterStage.paths)) !== JSON.stringify(paths)) throw fail("Rollback staging contains unexpected project paths.", "DESIGN_ROLLBACK_SCOPE_MISMATCH");
            await code.checkpoint({ message: "Design Studio · rollback failed state save", confirm: true });
            const rollbackHead = await code.gitHead();
            const rollbackSource = await sourceContext();
            const rollbackState = reconcileDesignSource(proposal.before_state, rollbackSource.files, stateIdentity(rollbackSource.source_identity)).state;
            rollbackState.sync.status = "SYNCED";
            rollbackState.sync.source_clean = true;
            await saveState({ expectedStateHash: proposal.base_state_hash, designState: rollbackState, undoRecord: null });
            error.rollback_checkpoint = rollbackHead.commit;
          }
          error.source_rollback = "complete";
        } catch (undoError) {
          error.rollback_error = undoError.message;
        }
      }
      entry.applying = false;
      throw error;
    }
  }

  async function undo({ signal } = {}) {
    if (signal?.aborted) throw fail("Design undo was cancelled.", "REQUEST_CANCELLED", 499);
    const stored = await readState();
    const current = stored.setup_data?.code?.design;
    const undoRecord = stored.setup_data?.code?.design_undo;
    if (!current || !undoRecord?.undo_ref) throw fail("There is no available Design Studio change to undo.", "DESIGN_UNDO_UNAVAILABLE", 409);
    const currentState = validateDesignState(current);
    const source = await sourceContext({ checkpoint: undoRecord.source_checkpoint, snapshot_sha256: undoRecord.source_snapshot_sha256, classifier_version: currentState.sync.classifier_version });
    if (!source.source_identity.source_clean || source.source_identity.checkpoint !== undoRecord.source_checkpoint || source.source_identity.snapshot_sha256 !== undoRecord.source_snapshot_sha256) throw fail("The source changed after the Design Studio checkpoint. Reconcile it before undoing.", "DESIGN_UNDO_SOURCE_STALE", 409);
    const inspected = await code.inspectUndoChangeSet({ token: undoRecord.undo_ref });
    const metadata = inspected.result?.feltus_design;
    if (metadata?.contract !== "feltus.design-change/v1" || metadata.application_id !== app.id || metadata.after_state_hash !== designStateHash(currentState) || !metadata.before_state || metadata.before_state_hash !== designStateHash(validateDesignState(metadata.before_state))) throw fail("The CODE undo record does not match this application's Design State.", "DESIGN_UNDO_STATE_MISMATCH", 409);
    const result = await code.undoChangeSet({ token: undoRecord.undo_ref, confirm: true }, { signal });
    const paths = sortedUnique(result.result.restored || []);
    const changed = sortedUnique((await code.gitChangedPaths()).paths);
    if (JSON.stringify(changed) !== JSON.stringify(paths)) throw fail("Undo restored unexpected project paths; no unrelated paths were staged.", "DESIGN_UNDO_SCOPE_MISMATCH", 409);
    await code.gitStage({ paths });
    const [staged, changedStaged] = await Promise.all([code.gitStagedPaths(), code.gitChangedPaths()]);
    if (JSON.stringify(sortedUnique(staged.paths)) !== JSON.stringify(paths) || JSON.stringify(sortedUnique(changedStaged.paths)) !== JSON.stringify(paths)) throw fail("Undo staging contains unexpected project paths.", "DESIGN_UNDO_SCOPE_MISMATCH", 409);
    await code.checkpoint({ message: `Design Studio undo · ${result.result.summary}`.slice(0, 190), confirm: true });
    const head = await code.gitHead();
    const afterSource = await sourceContext();
    const beforeState = validateDesignState(metadata.before_state);
    if (!afterSource.source_identity.source_clean) throw fail("The source changed after Design Studio undo. Reconcile it before saving the restored visual state.", "DESIGN_SOURCE_STALE", 409);
    const restoredState = reconcileDesignSource(beforeState, afterSource.files, stateIdentity(afterSource.source_identity), { allowManagedStylesheetUpdate: true }).state;
    restoredState.sync.status = "SYNCED";
    restoredState.sync.source_clean = true;
    await saveState({ expectedStateHash: designStateHash(currentState), designState: restoredState, undoRecord: null });
    await recordAction?.({ actionType: "design.undo", summary: "Undid the last Design Studio change through FELTUS CODE", details: { change_set_id: metadata.change_set_id, paths, restored_state_hash: designStateHash(restoredState), checkpoint: head.commit, source_identity: afterSource.source_identity } });
    return { ok: true, design_state: restoredState, design_state_hash: designStateHash(restoredState), source_identity: afterSource.source_identity, sync_summary: componentSyncSummary(restoredState), checkpoint: head.commit, undo_available: false };
  }

  return { get, initialize, reconcile, propose, proposeAI, review, apply, undo };
}
