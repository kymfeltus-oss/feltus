# Phase G — Release Readiness + Progressive Disclosure

**Status:** VERIFIED — Phase G Release Readiness baseline is implemented and the required acceptance/regression gates passed.

**Dependencies:** Phase F and Phase F.5 are verified inputs. Phase G must reuse their existing repository intelligence, productionization, validation, Design Studio, CODE, checkpoint, application-state, build-eligibility, activity, and provenance systems.

**Recovery note:** The requested search of `C:\Users\kymfe\OneDrive\Desktop\` and `C:\Users\kymfe\.codex\worktrees\` found no `phase-g-release-readiness-plan.md`. This document is a reconstruction from the verified current FELTUS architecture and the approved Phase G contract; it is not presented as a verbatim recovered copy.

## Implementation record

Phase G is implemented as a source-bound evaluator in `src/feltus-code/server/release-readiness.mjs`. It consumes existing Repository Intelligence classification, existing productionization validation checks, existing protected-contract results, CODE checkpoints/activity, existing application configuration metadata, and the verified Design Studio reconciliation model. It does not create a second lifecycle, a migration, an RLS change, a build record, or a deployment/provider action.

Terminal evaluation evidence is persisted through the existing `feltus_code_actions` activity stream as `release_readiness.evaluated`; it includes the full bounded state, source identity, category reductions, check evidence, Design State hash where applicable, and explicit build-eligibility result. The following existing CODE routes expose that evidence:

- `POST /api/code/release-readiness/evaluations` evaluates the current exact source;
- `GET /api/code/release-readiness` resolves the newest evaluation against current bindings and returns `STALE` when it no longer matches; and
- `GET /api/code/release-readiness/evaluations/:id` returns historical evidence with the same stale overlay.

The existing application-state build/deploy/promotion guard now uses the same current-readiness resolver. `READY` grants only `build_eligibility.eligible` for the exact source and still requires the pre-existing explicit build action and all of its own lifecycle gates. The evaluator never starts a build, creates an artifact, deploys, promotes, or calls a provider.

The existing CODE productionization panel now presents three levels of progressive disclosure: an executive release answer, visible category summaries, and collapsed detailed evidence. The Design Studio integration uses its actual `FELTUS_MANAGED`, `DEVELOPER_MANAGED`, reconciliation, sync, and conflict states. A synchronized Developer Managed component is positive evidence and does not block release merely due to ownership; unresolved conflicts block, while component reconciliation or validation work is review-required according to the bounded state.

## 1. Scope and outcome

Phase G answers one user-facing question:

> Is this application ready to release?

The lifecycle remains:

```text
Source
  -> Repository Intelligence
  -> Productionization
  -> Validation
  -> Release Readiness
  -> Build Eligibility
  -> Build
  -> Artifact
  -> Deployment
  -> Observed State
```

Release Readiness is a source-bound judgment between validation and build eligibility. It does not build, publish an artifact, deploy, promote, roll back, query a provider, or claim an observed runtime state. A `READY` result may make the exact source eligible for the existing build action; it must never initiate that action.

This preparation does not authorize product implementation, migrations, RLS changes, database writes, Production or shared Staging access, or provider/deployment API calls. Phase H and later phases remain out of scope.

## 2. Existing systems that Phase G must extend

Phase G is an integration layer, not a parallel lifecycle product.

### Repository Intelligence and productionization

`src/feltus-code/server/repository-productionization.mjs` is authoritative for the Phase E/F repository snapshot, classification, engineering standard, protected-contract map, source binding, and applicable check discovery. Its productionization run already binds:

- application ID;
- authorized workspace ID;
- branch;
- CODE checkpoint and commit;
- complete source snapshot SHA-256;
- classifier version;
- engineering-standard and protected-contract-map versions; and
- isolated validation results.

`src/feltus-code/server/routes.mjs` exposes the existing productionization overview, planning, validation, and source-context handlers. It already rejects changed source, mismatched plans, unsafe classifications, incomplete snapshots, protected changes, and unrecorded checkpoints. Phase G must call these existing capabilities rather than rescan or infer a second repository model.

The existing Phase F `evaluateReleaseReadiness` result is a validation aggregate with `READY_FOR_RELEASE` or `BLOCKED`. It is input evidence, not the Phase G user-facing readiness result. Phase G extends its evidence and build-gate use; it does not erase or reinterpret Phase F validation history.

### Application state, build eligibility, and provenance

`src/lib/feltus-application-state-api.js` already uses the host `releaseReadiness` callback to gate explicit build, deployment-readiness, and promotion requests. `src/server.js` currently resolves that callback from persisted productionization validation actions and CODE checkpoints. Phase G must replace that narrow lookup with one shared current-readiness resolver, then preserve the existing explicit lifecycle actions as the only way to request a build.

`feltus_code_actions`, `feltus_code_sessions`, `feltus_code_checkpoints`, application Blueprints, audit events, build records, artifacts, deployments, and observed-state records remain their current sources of truth. Phase G must reference them, not copy them into a new activity or provenance system.

### Design Studio

Phase F.5 stores one authoritative `feltus.design-state/v1` Design State in the application's existing setup data and binds visual work to application, workspace, branch, checkpoint, complete snapshot hash, and classifier version. The real Design Studio contracts include:

- component ownership: `FELTUS_MANAGED` and `DEVELOPER_MANAGED`;
- reconciliation state: `AVAILABLE`, `REQUIRED`, and `NOT_REQUIRED`;
- sync states: `SYNCED`, `CANVAS_CHANGED`, `CODE_CHANGED`, `RECONCILIATION_REQUIRED`, `CONFLICT`, and `VALIDATING`;
- component-scoped reconciliation decisions, including `AUTOMATIC_RECONCILIATION`, `RECONCILIATION_REQUIRED`, and `DEVELOPER_VERSION_PRESERVED`; and
- source-checkpoint, protected-contract, isolated-validation, exact-path checkpoint, and undo protections.

“Reconciliation Available” is the business presentation of the existing `reconciliation_state: AVAILABLE`; it is not a new persisted sync state. A valid Developer Managed component with `NOT_REQUIRED` reconciliation and a current source contract must not block release merely because FELTUS cannot edit it visually. An unresolved required reconciliation, source/design mismatch, or managed-stylesheet conflict must be surfaced according to the deterministic rules below.

Preview remains supporting validation evidence only. A local Preview is not a build, artifact, deployment, or runtime-observation claim.

## 3. Architecture decision

### 3.1 One source-bound readiness evaluator

Phase G will add a single pure evaluator and a host adapter around the existing systems. The evaluator normalizes actual repository, productionization, validation, Design Studio, configuration, build, and environment evidence into one `feltus.release-readiness/v1` evaluation. The host adapter resolves authorized application context, runs applicable isolated checks through the existing task runner, persists a bounded evidence envelope, and serves the current result.

The eventual implementation may add a focused `src/feltus-code/server/release-readiness.mjs` module, but it must not create a second scanner, validator, design-state store, checkpoint system, build system, or event stream. The existing `releaseReadiness` callback and explicit build endpoints must consume the same evaluator/resolver.

### 3.2 Persistence without a new Phase G migration

The Phase G baseline must use existing persistence:

- `feltus_code_actions` stores immutable, app-scoped readiness start and terminal-evaluation records;
- `feltus_code_sessions` supplies the existing actor/session ownership;
- existing productionization validation actions, checkpoints, Design Studio reconciliation actions, Blueprints, and application-state/build records remain referenced evidence; and
- existing audit/provenance infrastructure records the lifecycle action when it already does so.

The terminal action should use `action_type: release_readiness.evaluated`; a running action may use `release_readiness.started`. Its `details` payload contains only bounded, redacted structured evidence and references, not secrets, unbounded raw logs, source contents, or copied provider payloads. Existing validation output summaries are already bounded and must remain redacted.

No Phase G migration or RLS change is planned. If later implementation demonstrates that existing action details cannot safely retain the required bounded evidence or authorization semantics, that is a separate explicitly authorized architecture decision—not a reason to add a parallel table silently.

### 3.3 Readiness evaluation envelope

Every terminal evaluation must have this logical shape:

```json
{
  "contract": "feltus.release-readiness/v1",
  "evaluation_id": "UUID",
  "evaluator_version": "versioned evaluator identifier",
  "state": "READY | NOT_READY | REVIEW_REQUIRED | VALIDATING | STALE | BLOCKED",
  "evaluated_at": "ISO-8601 UTC",
  "source_identity": {
    "application_id": "existing application ID",
    "workspace_id": "authorized CODE workspace ID",
    "branch": "exact branch",
    "checkpoint": "recorded full CODE checkpoint/commit",
    "source_commit": "full commit",
    "source_snapshot_sha256": "complete snapshot hash",
    "source_snapshot_complete": true,
    "classifier_version": "Phase E/F classifier version"
  },
  "repository_intelligence": {
    "classification_status": "existing classifier status",
    "productionization_safe": true,
    "classification_evidence_ref": "existing evidence reference"
  },
  "productionization": {
    "plan_id": "existing plan ID or null",
    "run_id": "existing validation run ID or null",
    "status": "existing status",
    "source_snapshot_sha256": "bound hash"
  },
  "design": {
    "applicable": true,
    "design_state_hash": "canonical hash or null",
    "source_identity": "same bound identity or null",
    "sync_summary": "existing bounded summary or null",
    "reconciliation_evidence_refs": []
  },
  "checks": [],
  "summary": {},
  "build_eligibility": {
    "eligible": false,
    "reason": "bounded business-language reason",
    "requires_explicit_build_action": true
  }
}
```

The source identity is complete only when every required field is present, internally consistent, and equal across repository classification, contract map, productionization validation, checkpoint, and applicable Design State. A Design State that is not applicable is represented as `applicable: false`; it is not invented or treated as a passing design check.

## 4. Readiness states and deterministic transitions

The only global readiness states are `READY`, `NOT_READY`, `REVIEW_REQUIRED`, `VALIDATING`, `STALE`, and `BLOCKED`. Check result statuses and release gates are separate fields.

| State | Entry condition | Meaning | Build eligibility |
| --- | --- | --- | --- |
| `VALIDATING` | An authorized evaluation has started and no terminal evidence exists yet. | Checks are running against a captured source identity. This is never a passing result. | False |
| `READY` | All applicable checks have passed; no blocking or review-required gate remains; the source binding is current. | The exact source can proceed to the existing explicit build-eligibility boundary. | True only for the same identity |
| `NOT_READY` | Evaluation completed with a remediable failed or missing applicable requirement, such as syntax, required tests, required configuration, or a required build command. | The source is known and evaluated, but not ready to release. | False |
| `REVIEW_REQUIRED` | Evaluation completed with no blocking failure but at least one explicit human decision is required. | Evidence is current, but release cannot be treated as automatic. | False until a new evaluation resolves review |
| `STALE` | A previously stored evaluation is requested after any bound identity or required derived input changed. | Historical evidence remains viewable but cannot authorize release or build. | False |
| `BLOCKED` | Evaluation cannot safely establish readiness because an integrity, safety, or indispensable-evidence prerequisite is invalid, unavailable, or contradictory. | Reclassification, revalidation, restoration, or an authorized compatibility workflow is required. | False |

The resolver applies this precedence:

1. When reading a stored evaluation, compare its full binding with current authoritative context. Any mismatch returns `STALE` before its historic terminal state can be used.
2. An active, in-time evaluation is `VALIDATING`. A persisted start record that has no terminal record after its bounded execution deadline becomes `BLOCKED` with interrupted-evaluation evidence.
3. A new evaluation with an invalid source identity, stale classification, stale productionization plan, protected-contract violation, required unavailable evidence, unsafe repository condition, or unsafe design conflict is `BLOCKED`.
4. A completed evaluation with one or more failed or missing applicable release requirements is `NOT_READY`.
5. A completed evaluation with no blocking/missing failures but at least one review gate is `REVIEW_REQUIRED`.
6. Only a completed evaluation with all applicable requirements passed and no review gate is `READY`.

`STALE` is an overlay on the historical evaluation, not a rewrite of its stored evidence. The old action remains immutable; the current-readiness response exposes the changed binding and disables eligibility. A new evaluation is required to establish a new authoritative result.

## 5. Source binding and invalidation

### 5.1 Binding rules

Before checks run, the evaluator resolves current repository intelligence through the existing productionization context. It must verify:

- exact application and workspace identity;
- exact repository branch;
- full CODE checkpoint and commit, with a matching recorded checkpoint;
- a complete source snapshot and matching SHA-256 across classification and protected-contract map;
- current classifier version and `CLASSIFIED`/productionization-safe status;
- applicable productionization plan/run identity, validation status, source hash, and protected-contract evidence;
- applicable Design State hash, its component/reconciliation state, and its bound source identity; and
- the Blueprint/environment identity when an existing lifecycle operation requires it.

The evaluator must not accept a dirty workspace as a release source. It must not repair the source, create a checkpoint, reclassify, apply a Design Studio proposal, or modify a productionization plan as a side effect of evaluation.

### 5.2 Invalidation rules

The following invalidate a stored readiness result:

- application, workspace, branch, checkpoint, commit, snapshot hash, snapshot-completeness, or classifier-version change;
- repository classification no longer `CLASSIFIED` and productionization-safe for the current source;
- contract-map snapshot mismatch, a protected-contract result that no longer matches, or an unsafe/mixed repository result;
- productionization plan/run source mismatch, missing validation evidence, or changed validation basis;
- Design State hash, Design Studio source binding, managed stylesheet evidence, component sync/reconciliation state, or applicable reconciliation evidence change; and
- a changed required environment/configuration metadata binding.

On a fresh evaluation, stale classification and stale productionization evidence are blocking gates because the current source has not been safely evaluated. On retrieval of a previously current evaluation after a source change, the response is `STALE`; it must display the historic evidence but never silently continue to authorize a build.

## 6. Checks, categories, and release gates

Every check has a stable ID, name, category, applicability, result, gate, expected state, observed state, timestamp, source identity, redacted evidence, evidence references, and remediation. Phase G evaluates only checks applicable to the detected stack and declared application configuration. It must not invent a tool, command, passing output, environment variable value, or deployment fact.

### 6.1 Categories

| Category | Existing evidence to reuse | Required behavior |
| --- | --- | --- |
| Code | Current repository classification, engineering standard, isolated syntax/check/lint/format/type tasks | Run only detected and configured applicable commands. Stale classification is blocking. A failed applicable syntax, lint, formatting, or type check is `NOT_READY`; an indispensable unavailable task is `BLOCKED`. |
| Tests | Detected test runners, project scripts, productionization validation results, isolated task-runner evidence | Required applicable suites must pass. A failed required suite is `NOT_READY`; an unavailable required suite is `BLOCKED`. A genuinely non-applicable suite is `NOT APPLICABLE`, not a synthetic pass. |
| Design | Existing Design State, component sync summary, reconciliation decisions, source contract, Preview validation where applicable | Preserve component-level ownership. `SYNCED` current Design State can pass. A valid `DEVELOPER_MANAGED`/`NOT_REQUIRED`/`SYNCED` component does not block. Required reconciliation normally requires review; ambiguous source/design identity, protected impact, or managed-stylesheet conflict blocks. |
| Configuration | Existing app/setup configuration, repository-derived configuration contract, environment-variable names only | Report required names and metadata only; never read or expose values. Missing required application configuration is `NOT_READY`. Unknown configuration is not evidence of success. |
| Security | Protected-contract map/review, productionization safety, repository conditions | Any protected-contract violation, unsafe productionization state, invalid source identity, or blocked repository condition is `BLOCKED`. |
| Build | Detected build command, isolated build validation, existing build gate | A required build command must be configured and pass isolated validation. Missing or failed applicable build validation is `NOT_READY`. It does not create an artifact or start a build. |
| Environment | Existing environment and target metadata only | Verify required app/environment metadata is present and scope-consistent without provider calls. Missing required metadata is `NOT_READY`; cross-scope/invalid target identity is `BLOCKED`. |

### 6.2 Gate classifications

Every result must use exactly one gate:

| Gate | Effect |
| --- | --- |
| `BLOCKING` | Prevents readiness and build eligibility. The global state is `BLOCKED` for safety/identity/evidence failures or `NOT_READY` for completed remediable requirement failures. |
| `REVIEW REQUIRED` | Prevents automatic release/build eligibility until an explicit review produces a new current evaluation. |
| `WARNING` | Is recorded and disclosed but does not prevent `READY` when every applicable requirement passes. |
| `NOT APPLICABLE` | Is retained in detailed evidence and excluded from failure, pass, and blocking counts. |

Examples of mandatory blocking gates are protected-contract violations, stale repository classification during a new evaluation, stale productionization plans, invalid/dirty/incomplete source identity, unavailable required validation, and unsafe repository conditions.

### 6.3 Design Studio mapping

The mapping uses actual F.5 state, not older architecture language:

| F.5 evidence | Phase G gate and state |
| --- | --- |
| `FELTUS_MANAGED`, reconciliation `AVAILABLE`, `SYNCED`, current source identity | Passed Design evidence. |
| Supported `CODE_CHANGED` reconciled to `SYNCED` with `AUTOMATIC_RECONCILIATION` evidence | Passed only after current source identity and reconciliation evidence match. |
| `CANVAS_CHANGED` or `VALIDATING` | `REVIEW REQUIRED` or `VALIDATING`; neither is a release pass. |
| Component `RECONCILIATION_REQUIRED` / reconciliation `REQUIRED`, source otherwise scoped and safe | `REVIEW REQUIRED`; it must name the component and preserve source. |
| Required reconciliation with missing/ambiguous source identity, protected impact, or a managed stylesheet conflict / `CONFLICT` | `BLOCKING` and `BLOCKED`. |
| `DEVELOPER_MANAGED`, reconciliation `NOT_REQUIRED`, `SYNCED`, current source contract | Passed Design evidence; ownership alone does not affect readiness. |
| `DEVELOPER_MANAGED` with reconciliation `REQUIRED` or `RECONCILIATION_REQUIRED` | `REVIEW REQUIRED` because the unresolved reconciliation—not ownership alone—needs an explicit decision. |

No Phase G path may overwrite a Developer Managed component, reattach it, or normalize a managed stylesheet. Reconnection remains an explicit F.5 CODE/Design Studio lifecycle action followed by a new readiness evaluation.

## 7. Progressive disclosure

Release Readiness belongs in the existing application/CODE lifecycle surface, adjacent to productionization and explicit build eligibility. It is not a disconnected CI console.

### Level 1 — Executive state

Show business language first, for example:

- **Ready to Release**;
- **3 issues blocking release**;
- **Review required before release**;
- **Release readiness is validating**; or
- **Release readiness is stale — reevaluate before building**.

Show the evaluation time, the exact source checkpoint short identifier, and a short current/stale indicator. Do not show command output, raw logs, source contents, or secret-bearing configuration values at this level.

### Level 2 — Category summary

Show Code, Tests, Design, Configuration, Security, Build, and Environment with concise status, blocking/review/warning counts, and one business-language sentence. A category with only non-applicable checks shows `Not applicable` and does not reduce overall readiness.

Category counts are a pure reduction of detailed checks by category and gate. The executive blocking count is the number of unique detailed checks whose gate is `BLOCKING`; it must never be separately hand-maintained.

### Level 3 — Detailed evidence

For every check, disclose on demand:

- check name and stable ID;
- category, result, gate, and applicable/not-applicable state;
- expected state and observed state;
- evaluated timestamp and exact source identity;
- redacted evidence summary and authoritative evidence references;
- remediation guidance; and
- any Design Studio component IDs or source paths needed to make a scoped decision.

Evidence remains technical but bounded. Environment-variable evidence contains names, required/optional status, and expected shape only. The UI must never disclose values, tokens, credentials, raw provider responses, or unredacted source.

## 8. API and UI integration plan

The eventual implementation should extend the existing authenticated `/api/code` surface, with the current application resolved server-side. It must never accept an arbitrary filesystem path, app ID, or provider target from the browser.

Proposed internal route behavior:

- `POST /api/code/release-readiness/evaluations` starts an authorized source-bound evaluation and returns the bounded `VALIDATING` envelope or terminal result;
- `GET /api/code/release-readiness` resolves the latest terminal evaluation and overlays `STALE` when its binding no longer matches current authoritative context;
- `GET /api/code/release-readiness/evaluations/:id` returns historical evidence plus the same current-binding treatment; and
- the existing application-state build/deploy/promotion guards call one shared current-readiness resolver rather than duplicating readiness logic.

The UI should extend the existing FELTUS CODE productionization/readiness area in `src/feltus-code/web/`, using the existing app activity model. It needs an explicit **Evaluate release readiness** action and a separate existing **Build** action. A successful evaluation updates only readiness evidence and eligibility; it must not call a build, artifact, deployment, promotion, or provider route.

## 9. Build-eligibility boundary

`READY` is necessary but not sufficient to perform a build. The result may set `build_eligibility.eligible: true` only when all of the following are true:

- the evaluation is `READY`;
- its full source identity still equals the source identity currently requested for build;
- the build request passes the existing authorization, Blueprint, environment, and lifecycle gates; and
- the caller invokes the existing explicit build action.

The evaluator does not create a `feltus_builds` record, queue work, call the build worker, make an artifact, or change deployment state. A build request must recheck the current readiness binding immediately before it proceeds. If the source changed, it returns the current stale/not-ready condition and requires reevaluation.

## 10. Acceptance plan

Phase G must add a deterministic disposable acceptance suite, proposed as `scripts/release-readiness-tests.mjs`, using the real Phase F/F.5 handlers with temporary Git-backed fixtures. It must not call providers, Production, shared Staging, or a real deployment target.

### 1. Fully ready application

- **Setup:** Create a safe, classified, clean, checkpointed fixture with a complete snapshot, current productionization validation, all applicable checks passing, required configuration metadata present, and either synchronized Design State or Design not applicable.
- **Action:** Evaluate readiness.
- **Expected result:** `READY`, all applicable gates clear, and `build_eligibility.eligible` true for the exact source.
- **Evidence:** Evaluation source identity, check results, validation run reference, checkpoint reference, and detailed/count summaries.
- **Pass condition:** The evaluator records no blocking/review gate and starts no build/deployment activity.

### 2. Stale repository classification

- **Setup:** Create a valid classification, then change the fixture source or classifier version without reclassification.
- **Action:** Evaluate readiness and request the earlier evaluation.
- **Expected result:** The new evaluation is `BLOCKED` with reclassification required; the earlier result is `STALE`.
- **Evidence:** Old/new source hashes or classifier versions, classification evidence references, and stale reason.
- **Pass condition:** Neither result is build-eligible and the old classification cannot authorize readiness.

### 3. Stale productionization plan

- **Setup:** Create a source-bound productionization plan/validation, then change the source, checkpoint, snapshot, or plan binding.
- **Action:** Evaluate readiness using current context.
- **Expected result:** `BLOCKED` with stale productionization evidence.
- **Evidence:** Plan/run IDs, bound and observed source identities, and stale comparison.
- **Pass condition:** No old validation result can authorize the changed source.

### 4. Failing syntax

- **Setup:** Configure an applicable syntax/check task that exits nonzero in a classified fixture.
- **Action:** Evaluate readiness.
- **Expected result:** `NOT_READY` with a blocking Code check.
- **Evidence:** Actual isolated task result, exit code, bounded output summary, expected pass state, and remediation.
- **Pass condition:** The check is not converted to a warning or skipped, and build eligibility is false.

### 5. Failing tests

- **Setup:** Configure an applicable required test suite that exits nonzero.
- **Action:** Evaluate readiness.
- **Expected result:** `NOT_READY` with a blocking Tests check.
- **Evidence:** Actual test command metadata, isolated result, exit code, source identity, and validation reference.
- **Pass condition:** The suite remains required and no build is eligible.

### 6. Missing applicable build requirement

- **Setup:** Classify a stack that requires a build command but has no configured supported build command or build validation.
- **Action:** Evaluate readiness.
- **Expected result:** `NOT_READY` with a blocking Build check.
- **Evidence:** Classification/build-system evidence, absent command metadata, expected requirement, and remediation.
- **Pass condition:** The evaluator does not fabricate a build pass or artifact.

### 7. Protected-contract violation

- **Setup:** Produce a change set or validation result containing a protected-contract operation.
- **Action:** Evaluate readiness.
- **Expected result:** `BLOCKED`.
- **Evidence:** Protected-contract-map version, blocked operation/reference, source identity, and compatibility-workflow remediation.
- **Pass condition:** The violation remains blocking regardless of other passing checks.

### 8. Design Studio reconciliation required

- **Setup:** Use the real F.5 fixture to create an external structural component change or managed-stylesheet change that yields `RECONCILIATION_REQUIRED`.
- **Action:** Reconcile Design Studio, then evaluate readiness.
- **Expected result:** A safely scoped component reconciliation is `REVIEW_REQUIRED`; an unsafe/ambiguous source-design condition or stylesheet conflict is `BLOCKED`.
- **Evidence:** Design State hash, reconciliation decision, component/source path, sync summary, and matching source identity.
- **Pass condition:** The outcome follows real F.5 safety state, remains component-scoped, and never overwrites external source.

### 9. Valid Developer Managed component

- **Setup:** Use a current `DEVELOPER_MANAGED`, `NOT_REQUIRED`, `SYNCED` component with a valid source contract while every non-design applicable check passes.
- **Action:** Evaluate readiness.
- **Expected result:** `READY` if all other requirements pass; Design ownership alone is not a blocker.
- **Evidence:** Component ownership/reconciliation/sync state, source identity, and normal check evidence.
- **Pass condition:** No check treats `DEVELOPER_MANAGED` by itself as a warning, review gate, or blocker.

### 10. Source changed after evaluation

- **Setup:** Obtain a current readiness evaluation, then modify/commit source or change its snapshot.
- **Action:** Request the old readiness result and attempt build eligibility resolution.
- **Expected result:** `STALE` and ineligible.
- **Evidence:** Historic and observed source identities plus the changed fields.
- **Pass condition:** The old result is visible only as historical evidence and cannot authorize a build.

### 11. Successful reevaluation

- **Setup:** From test 10, reclassify, checkpoint, productionize/validate, and reconcile Design State as applicable for the changed source.
- **Action:** Run a new readiness evaluation.
- **Expected result:** A new terminal result binds to the new exact identity; the previous result remains stale.
- **Evidence:** Distinct evaluation IDs, timestamps, source hashes/checkpoints, and validation references.
- **Pass condition:** A passing new result never mutates or reauthorizes the old one.

### 12. Non-applicable check

- **Setup:** Use a stack with no detected TypeScript/type checker, formatter, Design State, or other selected capability.
- **Action:** Evaluate readiness.
- **Expected result:** The relevant detailed check is `NOT APPLICABLE` and overall readiness is determined only by applicable checks.
- **Evidence:** Classification applicability facts and the detailed check record.
- **Pass condition:** The check does not count as failed, passed, blocking, or silently omitted.

### 13. Progressive-disclosure summary accuracy

- **Setup:** Produce a fixture with multiple categories and a mix of blocking, review, warning, passed, and non-applicable detailed checks.
- **Action:** Render/serialize Level 1, Level 2, and Level 3 readiness data.
- **Expected result:** Executive and category counts exactly equal deterministic reductions of detailed checks.
- **Evidence:** Serialized summary, category reductions, detailed check IDs, and count assertions.
- **Pass condition:** No aggregate counter diverges from the evidence list, including non-applicable exclusions.

### 14. Evidence traceability

- **Setup:** Produce at least one critical Code/Security failure and one current successful result.
- **Action:** Inspect each readiness check and follow its references.
- **Expected result:** Every critical result reaches its underlying classification, source snapshot, checkpoint, productionization/validation, Design Studio, or configuration evidence without a fabricated pass.
- **Evidence:** Stable evidence references, hashes, timestamps, source identity, expected/observed state, and redaction assertions.
- **Pass condition:** Required trace fields exist and secret values/source contents are absent from readiness records.

### 15. Readiness to build-eligibility boundary

- **Setup:** Obtain a `READY` evaluation with a spy or disposable build-action adapter.
- **Action:** Evaluate readiness, then separately invoke the existing explicit build-eligibility/build path in controlled fixture mode.
- **Expected result:** Evaluation may report eligibility but creates no build, artifact, deployment, provider call, or execution record; only the explicit existing build action may proceed after its own recheck.
- **Evidence:** Evaluation action record, zero build/action side effects after evaluation, and explicit build-gate request evidence.
- **Pass condition:** `READY` never auto-starts a build and a changed source invalidates eligibility before build.

## 11. Verification after implementation

Before Phase G can be marked verified, run the new acceptance suite and all applicable established suites without weakening them:

```text
npm run check
npm run regression
npm run test:state-contract
npm run test:state-api
npm run test:code
npm run test:build-studio
npm run test:productionization
npm run test:design-studio
npm run test:release-readiness
git diff --check
```

Any unavailable required test is reported `BLOCKED`, not passed. Test fixtures must demonstrate actual handler/task evidence; simulated logs, UI labels, mocks, or documentation alone are not readiness evidence.

## 12. Known limitations and boundaries

- Phase G establishes release readiness and build eligibility only. It does not prove that a build, artifact, deployment, provider action, or observed runtime exists.
- Environment readiness uses existing metadata and configuration contracts without provider calls. It cannot claim provider-side health.
- Configuration evidence reports required names and safe metadata only; it never validates or displays secret values.
- A local Preview and isolated validation are useful source evidence, not deployment proof.
- Design Studio remains intentionally bounded to supported managed components. Unsupported developer source stays usable, but it cannot be silently represented as FELTUS-managed Canvas state.
- Phase G must not alter the separate immutable artifact-to-runtime diligence gap.

## 13. Implementation stop condition

This document restores the Phase G plan only. No Phase G implementation has been started by creating or updating this plan. The next authorized work, if requested, is Phase G implementation against this plan; Phase H must not begin automatically.
