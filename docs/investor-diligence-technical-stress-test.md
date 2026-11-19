# FELTUS Investor Diligence Live Technical Stress Test

**Run date:** 2026-11-08
**Scope:** Isolated Phase F technical diligence only. No Phase F.5 or Phase G work was started.

## Environment and source identity

- **Repository:** `C:\Users\kymfe\OneDrive\Desktop\FELTUS`
- **Branch / HEAD:** `codex/feltus-phase3-state-delivery-engine` / `2974048649273628c5086d434c5180d972120c0e`
- **Runtime:** Node.js `v24.18.0`; Git `2.52.0.windows.1`
- **Worktree:** Already contained unrelated modifications before this run. Its complete porcelain-status SHA-256 was `3459a0a6166c10560d1325a6bb467555e99f5e411ac4d0c31ff919a0e6fd0b63` before and after fixture execution; branch and HEAD also remained unchanged.
- **Fixture:** Ten synthetic JavaScript application repositories, each initialized as an independent local Git repository on `main`, with synthetic application IDs and disposable source files. The real `createFeltusCodeHandlers` routes and task runner were used for classification, validation, review, apply, Git stage/checkpoint/compare, and undo. Fixtures and machine-readable results are outside the repository at `C:\Users\kymfe\.codex\visualizations\2026\11\07\01a1b778-eaa7-7af3-8de7-6adb249a8408\d`.
- **State boundary:** No database records, migrations, RLS policies, Production, shared Staging, provider APIs, or unrelated repository files were touched. Synthetic application IDs were not persisted to FELTUS.
- **Evidence bundle:** `C:\Users\kymfe\.codex\visualizations\2026\11\07\01a1b778-eaa7-7af3-8de7-6adb249a8408\d\stress-test-evidence.json`; it contains per-case source identities, full commit and snapshot hashes, check results, rejection codes, and recovery evidence. Fixture Git history remains available beside it.

The first harness attempt placed isolated validation workspaces under a long Windows path and Git returned `Filename too long` for two source-only validations. The fixtures were relocated to a shorter directory within the same permitted external temp root and the full ten-case run was repeated. All executable cases then produced the results below; no product code or safety control was changed to accommodate the harness.

## Test results

### TEST 1 â€” Compatible external code change

**ACTION**
Captured a classified source identity, appended a behavior-preserving comment to `src/index.js` outside CODE, committed it with local Git, refreshed the overview, submitted the old checkpoint, and validated the refreshed source.

**EXPECTED**
The source checkpoint and snapshot change; the previous classification cannot authorize current validation; reclassification and checks complete without losing the external edit.

**ACTUAL**
The new commit was recognized and the old checkpoint was rejected with `SOURCE_CHECKPOINT_STALE`. The refreshed repository remained `CLASSIFIED` and `productionization_safe: true`; validation reached `READY_FOR_RELEASE` and both `source.check` and `source.tests` passed.

**EVIDENCE**
Fixture app `diligence-compatible-app`; previous commit `b6dc5e1f8ba7fffeb6c51a3cce425b50cdfd16d1`, snapshot `f5272f0ca1ad500b2c3a650d3c69d8361df016770ef26d227d3df3d68bf74263`; external/current commit `d4a12b03903e0dbef39bc9c936e2580061477f23`, snapshot `182564d7424f570551f8a03460cbcc3daba5bf1efe5ad4a212ef9e3e24b5934e`; classifier `feltus.repository-classifier/v2`; retained source SHA-256 `8a600816eed1d2b59ebc11dfb774f93ca0c768752ed71115b0b677b2a291e9f7`.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None.

### TEST 2 â€” Low-risk repository change and CODE lifecycle

**ACTION**
Generated the deterministic low-risk JSON proposal, validated its isolated snapshot, reviewed and applied it through CODE, staged only `config/settings.json`, created a checkpoint, compared it with baseline, and used the change-set undo token.

**EXPECTED**
The plan is bound to the exact app/workspace/branch/checkpoint/snapshot/classifier; the bounded proposal preserves parsed JSON values; validation, review, apply, checkpoint, compare, and undo all complete.

**ACTUAL**
All six plan bindings matched the fixture. One `DETERMINISTIC` operation formatted `config/settings.json`; source check, test suite, and `productionization.json_semantics` passed. Review found no blocked contracts. Apply returned an undo token; checkpoint creation returned code `0`; compare showed only the JSON formatting diff; undo restored the original bytes and SHA-256. Git history retained both the baseline and checkpoint. After undo, the fixture has the expected modified working-tree file because HEAD remains the formatting checkpoint while undo restores the pre-apply bytes.

**EVIDENCE**
Baseline commit `061bcaf3ecc8063be820157d4c678736c5e887cc`; snapshot `f5272f0ca1ad500b2c3a650d3c69d8361df016770ef26d227d3df3d68bf74263`; classifier `feltus.repository-classifier/v2`; change-set SHA-256 `09bb89e555d43958817e7f4d6a6eb6415d210cea20c57e985678e3bdbf8bdbba`; operation before/after SHA-256 `cb2e90ab2373058b6ad21c10632ade299047517e4c1cfa4d1b5399918e388e0e` / `d6cbf761c85662a9766e15177a5df31cf87e394cff9eaf10067d770d5c07a293`; checkpoint `ec862e50e4af23396532d9086f1c0e37d7c0f1e7`; undo restored the original SHA-256. History: `ec862e5 Diligence fixture validated JSON checkpoint` above `061bcaf isolated diligence fixture baseline`.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None.

### TEST 3 â€” Stale repository classification

**ACTION**
Classified a clean fixture, made and committed an external source edit, submitted the old source checkpoint to validation, then refreshed classification and validated again.

**EXPECTED**
The stale classification is rejected; the new classification binds to the new source and validation can complete.

**ACTUAL**
The old identity was rejected with `SOURCE_CHECKPOINT_STALE`. Reclassification captured the new commit and changed snapshot hash; validation reached `READY_FOR_RELEASE`.

**EVIDENCE**
Old commit `04fad0fbd7bfc63ce4cc5f735a6b1126f89e1d73` / snapshot `f5272f0ca1ad500b2c3a650d3c69d8361df016770ef26d227d3df3d68bf74263`; refreshed commit `bc7dff55053430cfbdd6832e71a5e47ae3a7be4b` / snapshot `e3801062712e741dc79c3dcefd0d615e2336de5df21a7afecf0a01e4e49817e8`.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None.

### TEST 4 â€” Stale productionization plan

**ACTION**
Created and validated a source-bound plan, externally committed another source change, and attempted to apply the old plan.

**EXPECTED**
The plan is rejected before mutation; the external change and proposed target remain intact.

**ACTUAL**
Apply returned `SOURCE_CHECKPOINT_STALE`. The proposal target hash did not change; the external source commit remained present and the fixture working tree was clean.

**EVIDENCE**
Plan commit `326d29e527ac0e986d67919bcc4703557316aa9c`, snapshot `f5272f0ca1ad500b2c3a650d3c69d8361df016770ef26d227d3df3d68bf74263`; later external commit `a27b2e007a847ee9a8b629ffeae6120ed5e1eef8`; proposal target `config/settings.json` retained SHA-256 `cb2e90ab2373058b6ad21c10632ade299047517e4c1cfa4d1b5399918e388e0e`.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None.

### TEST 5 â€” Protected contract

**ACTION**
Proposed a change to `src/api/routes.js` in an isolated fixture, requested CODE contract classification and isolated validation, then attempted apply.

**EXPECTED**
The API route is identified as protected and cannot be silently productionized or applied.

**ACTUAL**
The operation was classified `CONTRACT_PROTECTED` for route/authorization/serialized-contract evidence. Review found one blocked operation and zero review-only operations. Validation returned `BLOCKED`; apply returned `PRODUCTIONIZATION_VALIDATION_REQUIRED`. The fixture route remained byte-for-byte unchanged.

**EVIDENCE**
The contract diff identified `http_route:/api/status` and proposed `http_route:/api/unsafe`; source route SHA-256 remained `8462ff48b4f16c0a75f39b5582db9797313b036b98b5d80a0aa4f18aee67385e`. The blocking reason required a versioned migration workflow.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None for the tested API-route contract.

### TEST 6 â€” External developer workflow

**ACTION**
Changed and committed source with ordinary filesystem and Git operations outside CODE, then queried CODE Git HEAD, refreshed the repository overview, and validated.

**EXPECTED**
FELTUS detects the new source identity without requiring edits through its own editor and can reassess the current source.

**ACTUAL**
CODE Git HEAD and refreshed classification agreed with the external commit. The classifier remained safe and validation reached `READY_FOR_RELEASE`; both required JavaScript checks passed.

**EVIDENCE**
Initial commit/snapshot `e9e293b60f916c67cc6424e7e5ac22e846ed0260` / `f5272f0ca1ad500b2c3a650d3c69d8361df016770ef26d227d3df3d68bf74263`; refreshed commit/snapshot `ca0beecf4c60dec0616132b135bb82ce99304990` / `c2910f6743330ecda23d87c62773d9355adeca90a0840eaa37ad3abe38746626`.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None for source identity refresh. This does not establish a provider webhook or automated external Git integration.

### TEST 7 â€” Component-scoped reconciliation

**ACTION**
Queried the real CODE handler set, `productionizationOverview`, and repository map for the disposable application, looking for ownership and reconciliation state at component scope.

**EXPECTED**
Demonstrate actual `FELTUS Managed`, `Developer Managed`, `Reconciliation Available`, and `Reconciliation Required` status per component, or record the gap.

**ACTUAL**
The CODE overview exposed source classification, engineering standards, and repository-level low/medium/protected file counts. No component ownership fields or component reconciliation handlers/state were returned. The product does contain application desired/observed-state reconciliation and environment restore controls in the Studio UI, but those are application/deployment-state operations, not component-scoped source ownership or reconciliation.

**EVIDENCE**
Fixture app `diligence-component-app`; overview fields were `classification`, `engineering_standard`, `contract_protection`, `required_checks`, `source_checkpoint`, `source_branch`, `source_workspace_id`, `source_snapshot_sha256`, `classification_status`, and `source_clean`. Relevant CODE handlers: `src/feltus-code/server/routes.mjs`; application-level observed-state controls: `src/feltus-code/web/feltus-code.js` (observed deltas and accept/restore actions around lines 1134 and 1380â€“1396).

**PHASE F RESULT:** BLOCKED (historical result; Design Studio component reconciliation was not available during the original stress test).
**CURRENT STATUS:** RESOLVED FOR THE TESTED SUPPORTED AND UNSUPPORTED COMPONENT CHANGES; see the dated Phase F.5 follow-up below.

**PHASE F.5 FOLLOW-UP â€” 2026-11-09**

The original handler-surface observation above predates Design Studio. The separate Phase F.5 disposable Git/CODE acceptance now demonstrates component-scoped reconciliation through the real Design Studio lifecycle: a supported external hero variant edit reconciles only that component; an unsupported structural change preserves the edited source and marks only that component Developer Managed, while its unaffected sibling remains FELTUS Managed and editable. See acceptance cases 6â€“8 in scripts/design-studio-tests.mjs. The earlier historical observation is retained; this follow-up closes the component-scoped reconciliation gap for the tested supported and unsupported cases.

The live Docker Preview follow-up rendered the exact Design Studio HTML/CSS produced by the reviewed CODE change set after isolated validation and checkpoint. Container snapshot hash matched the source identity; the application was served from the isolated Docker container, and teardown verified removal of both containers, both networks, and the copied snapshot. Evidence: fixture application 2c25df08-81cf-41d1-8ba7-ac13b6fe4c74, branch main, checkpoint daf2f1090e834f155796140978dbc7c35ec5ff68, Design State hash f142d610fc1037dcd91f533edd60076c4b7d3acf3bd8b58704c13f9a814614dc, source snapshot hash d513512e89756327016a2cd446182bebcecd1d39f8ff84f9fc3e05a4551245e0, container f17c258ef7ae0d20deca64ee08efcaa4b3ccceba14f6d476bddb7cb66270ffb3, and Node 22 Alpine digest node@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202. Served HTML SHA-256 was c69f25aa92161ae152736d921e42992e3dc147463c9abf0d9e658ed105337549; CSS SHA-256 was ae45a1d76126f8635ef3b724a6fc54db1453a4f65d9e55fb49d483e262eec7a1. See scripts/design-studio-preview-integration.mjs. This is local Preview evidence only and does not change the separate artifact-to-runtime result below.

### TEST 8 â€” Application remains usable

**ACTION**
After an external source commit, loaded CODE Git status, source tree, repository map, and source file; performed a create/read/remove probe through CODE; then reran validation and productionization planning.

**EXPECTED**
The external source remains intact; CODE can continue to read and edit the workspace; classification, validation, and planning can rerun.

**ACTUAL**
CODE file operations completed and the temporary probe was removed. The repository remained clean and `CLASSIFIED`; the external source checkpoint remained unchanged. Validation reached `READY_FOR_RELEASE` and planning returned `READY_FOR_REVIEW`.

**EVIDENCE**
External commit `d830b1c4ce75bf9100dfb833765b07c88e1b538b`; source SHA-256 `56ea6f19526211900409eec5aafce8ae9321829c91d7cf4baa723742895ffa51`; snapshot `872357c68350c1a401bfe25e2e4d58affbfdb0e9d37abef5605a2e9bad858f99`; both `source.check` and `source.tests` exited `0`; CODE create/read/remove completed and final fixture status was `## main`.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** No visual/UI behavior was claimed or tested.

### TEST 9 â€” Source-to-build evidence boundary

**ACTION**
Validated a clean, exact fixture source checkpoint and inspected the isolated CODE handlers for build, artifact, deployment, and runtime-observation operations. No provider or database calls were made.

**EXPECTED**
Prove source-bound validation/readiness separately from a real immutable artifact, isolated deployment, and observed runtime with matching lineage and digest.

**ACTUAL**
The fixture classification was safe and source validation reached `READY_FOR_RELEASE` with `ready_for_release: true`; this is validation readiness, not proof that an artifact build was run or a deployment was eligible/executed. No build/artifact/deploy/runtime-observation operation was available in the exercised CODE handler surface, so no artifact or running target was created. `docs/go-live-status.md` also states that no Git provider webhook, build runner, OCI registry publisher, or artifact promotion flow has been implemented, and that the Coolify adapter has not been run against Coolify.

**EVIDENCE**
Fixture commit `d13380ebed57f19c1507943c9bec2331c12eb186`, snapshot `f5272f0ca1ad500b2c3a650d3c69d8361df016770ef26d227d3df3d68bf74263`; `source.check` and `source.tests` exited `0`; `build_deploy_artifact_handlers` was empty. See `docs/go-live-status.md` around line 92. No provider calls or database writes occurred.

**PASS / FAIL / BLOCKED:** BLOCKED for artifact-to-runtime proof; source validation passed.
**GAP, IF ANY:** **DILIGENCE GAP â€” ARTIFACT-TO-RUNTIME PROOF NOT EXECUTED IN THIS ISOLATED TEST**

### TEST 10 â€” Recovery

**ACTION**
Used the test-2 fixture to verify checkpoint creation, Git compare, change-set undo, commit history, restored file hash, and the main checkoutâ€™s branch/HEAD/status before and after fixture execution.

**EXPECTED**
Checkpoint and compare are real Git operations; undo restores the original fixture bytes; history remains valid; unrelated checkout state is untouched.

**ACTUAL**
The fixture retained both commits and the compare contained the JSON diff. Undo restored the original settings SHA-256. Main FELTUS branch and HEAD were identical before and after, and complete porcelain-status SHA-256 matched exactly.

**EVIDENCE**
Fixture baseline `061bcaf3ecc8063be820157d4c678736c5e887cc`; checkpoint `ec862e50e4af23396532d9086f1c0e37d7c0f1e7`; original file SHA-256 restored to `cb2e90ab2373058b6ad21c10632ade299047517e4c1cfa4d1b5399918e388e0e`; main checkout remained at `2974048649273628c5086d434c5180d972120c0e` on `codex/feltus-phase3-state-delivery-engine`, with status hash `3459a0a6166c10560d1325a6bb467555e99f5e411ac4d0c31ff919a0e6fd0b63` before and after.

**PASS / FAIL / BLOCKED:** PASS
**GAP, IF ANY:** None for the local checkpoint/undo lifecycle.

## Confirmed current capabilities

- External local Git changes update the source checkpoint and snapshot identity; stale classification and stale plan use `SOURCE_CHECKPOINT_STALE` and reject before overwriting external work.
- A deterministic JSON-only proposal can be validated in isolation, with parsed values preserved, then reviewed, applied, staged, checkpointed, compared, and undone through CODE.
- Protected route contracts are classified and fail closed before apply.
- CODE remains usable after external changes for source browsing, file operations, reclassification, validation, and planning.
- In the tested clean fixture, source validation can report `READY_FOR_RELEASE`. This should not be described as a completed build, immutable artifact, deployment, or observed runtime.

## Diligence gaps and risks exposed

1. **Component ownership/reconciliation:** no demonstrated per-component ownership state or reconciliation decision. Application-level observed-state reconciliation exists, but does not close this source-component ownership gap.
2. **Artifact-to-runtime lineage:** the isolated test did not build an immutable artifact, deploy it, or observe a runtime. Current go-live documentation says build-runner, OCI publishing, and artifact promotion are not implemented; the Coolify adapter remains unexercised. A `ready_for_release` validation result cannot substitute for matching commit-to-artifact-to-deployment-to-observation evidence.
3. **Verification boundary:** these were synthetic local JavaScript fixtures and direct CODE handlers, not authenticated browser journeys, live application-state records, shared Staging, Production, or provider deployment tests.
4. **Harness portability:** long Windows temp paths can cause Git validation-copy failures. Short-path fixtures completed the full run without changing FELTUS code; future Windows diligence automation should keep validation roots short.

## Investor result matrix

| Test | Result | Evidence | Investor Meaning |
|---|---|---|---|
| 1. Compatible external change | PASS | Old commit/hash rejected; new source validated | External source edits are detected and can be reclassified. |
| 2. Low-risk change | PASS | Bound deterministic plan, checks, review, checkpoint, compare, undo | A narrow low-risk CODE lifecycle is demonstrated end to end. |
| 3. Stale classification | PASS | `SOURCE_CHECKPOINT_STALE` | Prior repository understanding cannot authorize a changed checkpoint. |
| 4. Stale plan | PASS | Apply rejected before proposal target mutation | Plans are bound to their source identity. |
| 5. Protected contract | PASS | `CONTRACT_PROTECTED`, blocked validation/apply | Tested route contracts are excluded from silent automation. |
| 6. External developer workflow | PASS | External Git HEAD matched refreshed classification | CODE does not require source edits to originate in its editor. |
| 7. Component reconciliation | PASS â€” Phase F.5 follow-up | Cases 6â€“8 in scripts/design-studio-tests.mjs: supported variant reconciled; unsupported structure preserved and isolated as Developer Managed; sibling remained FELTUS Managed | Component-scoped ownership and reconciliation are demonstrated for the tested cases. |
| 8. Application usability | PASS | CODE read/write probe, validation, and plan completed | Repository use continued after external changes in the local fixture. |
| 9. Artifact to runtime | BLOCKED | Source validation only; no artifact/deployment/observation | End-to-end build and runtime lineage remains unproven. |
| 10. Recovery | PASS | Git history, diff, undo hash, checkout state hash | Local checkpoint and undo worked without changing unrelated checkout state. |

## Overall technical diligence conclusion

The live isolated stress test passed the source identity, stale-state, bounded low-risk change, protected-contract, CODE usability, and recovery cases. The Phase F.5 follow-up also demonstrated component-scoped reconciliation for the tested supported and unsupported changes and verified the actual Design Studio source-to-local-Docker-Preview path. FELTUS demonstrated a real local repository lifecycle while preserving external edits and keeping the main worktree untouched. Immutable artifact-to-runtime evidence remains an open diligence gate; local Preview is not deployment proof.

LIVE TECHNICAL DILIGENCE RESULT: PASS WITH GAPS
