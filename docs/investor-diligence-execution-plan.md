# FELTUS Investor Diligence Execution Plan

**Purpose:** sequence and define evidence for three investor diligence workstreams: technical resilience, cohort economics, and reduction of founder dependency.

**Scope:** planning and diligence design only. This document does not authorize product changes, Production or shared Staging access, provider API calls, database writes, or the start of Phase F.5 or Phase G.

**Evidence status:** Phase F has been verified in local acceptance tests. No real customer cohort dataset or live external-developer stress test was supplied for this plan. Missing evidence is marked as such; no commercial values or test outcomes are inferred.

## 1. Objective

Prove FELTUS's operating claims through observable outcomes rather than architecture descriptions:

1. A normal developer can change an application repository outside FELTUS and FELTUS can identify the exact change, reject stale decisions, preserve the developer's work, and continue safely where policy allows.
2. Commercial cohorts can be measured from acquisition through retained production use and contribution margin, with costs attributed to the infrastructure model that incurred them.
3. Qualified people other than the founder can operate, troubleshoot, and own critical subsystems, demonstrated through repeatable tasks and evidence.

The workstreams can be prepared in parallel. Customer measurement must be instrumented before the first cohort is counted. Investment claims must wait for the relevant technical, retention, cost, and ownership evidence to mature.

## 2. Current verified baseline

### Phase F evidence

The Phase F verification recorded on 2026-11-08 passed `npm run check`, `npm run regression`, `npm run test:state-contract`, `npm run test:state-api`, `npm run test:code`, `npm run test:build-studio`, `npm run test:productionization` (52 cases), and `git diff --check`.

Relevant demonstrated capabilities include:

- Source-bound plans that carry application/workspace identity, branch, checkpoint, source snapshot hash, and classifier version.
- Rejection of stale checkpoints and stale productionization plans.
- Repository classification and protected-contract evaluation, including fail-closed behavior for mixed or unknown repositories.
- Isolated JavaScript, TypeScript, Python, and native Go checks; failed or unavailable checks block application/readiness.
- JSON normalization that preserves parsed values, explicit review before apply, and CODE apply, stage, checkpoint, and undo.
- Secret redaction, path isolation, protected-contract blocking, and negative acceptance proving the FELTUS root remains `MIXED`, `productionization_safe: false`, with a blocked plan and no change set.

The recorded root classification covered 194 paths and was a negative acceptance case, not a productionization target. These are local code and fixture results. They do not prove a live production deployment, provider behavior, cohort economics, or independent team operation.

### Important current limits

- Existing application-state contracts make desired Blueprints immutable and link execution, artifact, deployment, and observed-state records by source commit and artifact digest. The recorded go-live status does not establish a completed live provider deployment or observed-runtime drill.
- Phase F's deterministic automatic normalization is limited to semantic-preserving JSON formatting. It does not authorize automatic source rewrites or protected-contract changes.
- The repository review for this plan did not establish a shipped component-level `Developer Managed` state or deterministic visual-reconciliation policy. The related diligence cases below are acceptance requirements, not claims of current capability.
- No cohort dataset was supplied. Every commercial metric below is therefore **NOT YET MEASURED**.
- Do not treat record-only deployment history or a preview health check as proof that an immutable artifact was deployed and observed at runtime.

## 3. Technical Stress Test

### Test boundary and setup

Use one disposable application fixture in a temporary local workspace, with a synthetic application identity and test-only Blueprint/state fixture. Use a real local Git repository and make the external/manual edits with ordinary Git and editor commands, outside FELTUS CODE. Run FELTUS CODE classification, plan, validation, review, apply, stage, checkpoint, and undo handlers against that fixture.

Do not connect the fixture to Production, shared Staging, a live customer repository, a provider API, or a database with active application records. Do not create a test pass by relaxing the classifier, changing protected-contract rules, mocking a successful validation, or writing a record-only deployment. Keep the original baseline and every changed commit available side by side until evidence is captured.

Before each case, record the synthetic application ID, workspace ID, branch, full Git commit, Blueprint ID/version/hash, source snapshot SHA-256, classifier version, and relevant component ownership state. After each manual commit, rerun classification from the changed repository and retain the full diff and commit ID.

### Acceptance cases

| Case | Action | Expected result | Evidence captured | Pass/fail gate | Current status |
|---|---|---|---|---|---|
| Baseline and exact checkpoint | Load the disposable application's known state and classify its committed repository. | The report names the exact app/workspace/branch/commit, Blueprint revision, source hash, and classifier version. | Fixture manifest; Git `HEAD`; Blueprint fixture; classification JSON; source hash. | All identifiers match the fixture; no source or fixture state is mutated by inspection. | **READY FOR FIXTURE RUN; not run by this planning task.** |
| Compatible external source change | Edit a non-contract implementation file in the disposable repo using a normal editor; commit with Git; request state/overview again. | The old classification is recognized as stale; the new classification binds to the new commit and hash. Existing edits remain present. | Before/after commits and hashes; diff; stale response/error; new classification JSON. | New state is source-bound to the new commit; no prior content is overwritten. | **READY FOR FIXTURE RUN.** |
| Low-risk internal code change | Select a source path only if the current protection map classifies it `LOW_RISK_INTERNAL`; make a small compatible edit externally. | The policy reports the actual risk classification. Phase F does not automatically rewrite arbitrary source; any proposal remains reviewable and hash-bound. | Protection-map entry; change-set fingerprint; exact path/diff; review result. | Pass only if the observed policy is preserved. If no code path is classified low risk, record `NOT APPLICABLE`; do not weaken classification to force a pass. | **READY WITH PATH-AVAILABILITY CHECK.** |
| Protected-contract change | Change a protected route, schema, serialized-state field, migration identifier, or equivalent fixture contract externally. | Reclassification sees the new source; contract evaluation identifies the protected operation; unsafe automatic apply is rejected. | Before/after contract map; affected path and hashes; blocked-operation result; apply rejection code. | Protected change is blocked or routed to an explicitly versioned compatibility/migration review; no automatic apply. | **READY FOR FIXTURE RUN.** |
| FELTUS-managed component changed within policy | Make a normal external edit to a component whose persisted ownership is explicitly FELTUS-managed. | The change is detected and reconciled only if the supported deterministic rule can prove compatibility; otherwise it is preserved and surfaced for review. | Component identity and ownership; before/after component hashes; reconciliation decision; whole-app status. | No silent overwrite. The result is scoped to that component and the rest of the app remains usable. | **PASS — Phase F.5 acceptance case 6: supported external hero variant change reconciles to the changed component; sibling remains FELTUS Managed.** |
| Component exceeds deterministic visual reconciliation | Apply a structural/layout change that the deterministic reconciliation rule cannot represent safely. | The changed component's code remains intact; that component can transition to Developer Managed; unrelated FELTUS-managed components remain available. | Exact external diff; component ownership transition; before/after app inventory; unrelated-component checks. | Pass only if ownership is component-scoped and unaffected app functionality remains available. A test-only flag or simulated status is not proof. | **PASS — Phase F.5 acceptance case 7: external structure is preserved; only the affected component becomes Developer Managed; the sibling remains editable.** |
| Stale repository classification | After an external commit, submit the old classification/checkpoint as if current. | FELTUS rejects it and requires reclassification against the new repository state. | Request identity; current and submitted commits/hashes; rejection code and response. | Old source identity cannot authorize validation, apply, or build eligibility. | **READY FOR FIXTURE RUN; stale-plan coverage already exists in Phase F.** |
| Stale productionization plan | Create a Phase F plan, then externally commit another change before validation or apply. | Validation/apply rejects the plan as stale; no proposed content is applied to the changed repository. | Plan's app/workspace/branch/checkpoint/hash/classifier version; new commit; rejection code; file hashes. | All source bindings are checked and stale plan is rejected without overwriting the external change. | **READY FOR FIXTURE RUN; Phase F stale-plan acceptance passed.** |
| Validation and build eligibility | Validate a compatible reviewed change set against the disposable snapshot, then evaluate build eligibility. | Required checks run against the exact proposed snapshot. Only passing, source-bound, non-blocked changes can proceed to a build request. | Per-check command/status/exit code; snapshot hashes before/after; review result; eligibility decision. | Failed/unavailable checks, changed source, or blocked contracts keep build ineligible. | **Validation READY; real artifact eligibility must be proven by the isolated build path.** |
| Checkpoint and undo | Apply only a validated change in the fixture, stage the exact paths, create a local checkpoint, then use the existing undo token. | The new checkpoint is distinct; undo restores the pre-apply file bytes and reports the restored paths. | Git status/diff/commits; backup token metadata; before/after file hashes; undo result. | No unrelated path changes; undo is conflict-checked; the original manual change remains intact. | **READY; CODE checkpoint/undo passed in Phase F fixture coverage.** |
| Source remains usable / no silent overwrite | At each case, compare the externally edited working tree with the fixture after reclassification, validation, failure, and undo. | The repository remains readable and usable; no background operation replaces the manual edit. | Content hashes and diffs at every boundary; task logs; failure responses. | Every unexpected mutation is a fail, even if a status screen reports success. | **Mandatory invariant across all cases.** |
| Immutable artifact to observed runtime | If a provider-free local artifact path is available, build a real immutable OCI artifact, deploy it to an isolated local target, and read back its health/observed state. | Build, artifact, deployment, and observation refer to the same full commit, Blueprint revision, and artifact digest; observed health is collected from the running disposable target. | Build/check logs; OCI manifest digest; deployment event; target identity; health response; observed-state record and hash. | Digest and source lineage match end to end; target is disposable; no provider API or live database is involved. If no real local artifact/deployment/observation path exists, stop and mark `BLOCKED`; do not substitute a mock, preview, or record-only deployment. | **BLOCKED until a provider-free local artifact-to-runtime path is demonstrated.** |

### Technical decision

The Phase F fixture cases verify source identity, stale-plan handling, contract policy, isolated checks, and CODE lifecycle actions. Phase F.5 acceptance cases 6–8 exercise component-scoped reconciliation against disposable Git/CODE source. Immutable artifact-to-runtime remains a separate, explicitly blocked gate until a real provider-free artifact and deployment-observation path can be exercised; local Preview is not a substitute.

## 4. Cohort Economics Measurement Framework

### Status separation

**ACTUAL** — No real cohort data, invoices, acquisition-cost allocation, or customer-level cost attribution were supplied. There are no validated actual values to report.

**TARGET** — No numerical targets are approved in the available evidence. Before enrollment, leadership should register targets by customer segment and deployment model, including definitions, observation windows, owners, and acceptable gross-margin/contribution thresholds. Do not backfill targets after seeing cohort outcomes.

**NOT YET MEASURED** — All metrics in the dictionary below. A blank or unavailable source is reported as `NOT MEASURED`, never as zero.

### Metric dictionary

| Area | Metric | Definition and calculation | Required source data |
|---|---|---|---|
| Acquisition | Paid conversion | Eligible prospects or trials converting to a first paid account within a pre-registered conversion window ÷ eligible prospects/trials in the same cohort. Report denominator and channel. | CRM/lead cohort, signup/trial dates, paid-start date, channel, eligibility rule. |
| Acquisition | CAC | Attributable acquisition spend, including the disclosed labor/agency allocation policy, ÷ new paid customers acquired in the matching period/channel. Report blended and channel-level CAC only when attribution is supportable. | Campaign/channel costs, sales costs, attribution source, new paid accounts. |
| Activation | Time to first working application | Median elapsed time from account activation to a customer application passing a defined build/validation and usable-preview check. Report failures and distribution, not only the median. | Account/app IDs, activation time, first successful check/build/preview events. |
| Activation | Time to production | Median elapsed time from activation to the first verified production deployment with health observation. Keep this distinct from preview or build completion. | Activation time, source checkpoint, immutable artifact digest, deployment event, observed health/time. |
| Usage | Active applications | Distinct applications with at least one customer-initiated source change, successful build, or deployment during the stated window. Publish the event rule and window. | Application-to-account mapping and timestamped activity/build/deployment events. |
| Usage | Builds per application | Count build attempts and successful builds separately per active application and time window. | Build IDs, app IDs, status, duration, source commit, resource usage. |
| Usage | AI usage | Requests/tokens by model and purpose, paired with FELTUS-borne inference cost. BYOP customer spend is separate. | Usage records, model, tokens/requests, unit cost or invoice allocation, billing owner. |
| Usage | Deployment activity | Deployment attempts, successes, failures, time to healthy observation, and rollback events. | Immutable artifact/deployment lineage, target, event times, health observations. |
| Usage | Continued post-launch changes | Applications with at least one meaningful source/build/deployment change after first production launch; report changes per retained app. | First production time and subsequent source/build/deployment events. |
| Retention | Day-30 customer retention | Paid accounts still active at Day 30 and with at least one active application in the preceding 30-day observation window ÷ eligible paid accounts whose Day 30 has matured. | Paid status and timestamped application events; cohort maturity. |
| Retention | Day-60 customer retention | Same rule at Day 60. Keep revenue retention and product-activity retention as separate views. | Paid status, invoices, application events, cohort maturity. |
| Retention | Day-90 customer retention | Same rule at Day 90. Report matured and immature accounts separately. | Paid status, invoices, application events, cohort maturity. |
| Expansion | Second application creation | Paid customers creating a second distinct application after their first ÷ eligible paid customers. Report time to second app. | Account/app relationships and creation timestamps. |
| Expansion | Applications per customer | Distinct applications created and retained per customer relationship; show median and distribution, including single-app customers. | Stable customer relationship and application IDs. |
| Expansion | Repeat builds / additional usage | Repeat successful builds, deployments, or usage expansion after initial production; define each event separately. | Build/deployment/usage event history by account and app. |
| Agency / consultant | Applications deployed per customer relationship | Verified production apps divided by agency/consultant customer relationships; also report per-account distribution. | Relationship type, account/app mapping, verified deployments. |
| Agency / consultant | Applications retained per agency | Agency accounts with active retained applications, plus the count of those apps at D30/D60/D90. | Agency classification, app activity, paid status, cohort maturity. |
| Agency / consultant | Production apps per account | Verified production applications per customer account, separate from created or preview-only apps. | Account/app mapping and verified artifact/deployment/health lineage. |
| Cost | AI inference cost | Actual provider cost borne by FELTUS, attributed by customer/app/model/purpose. Report BYOP customer-paid inference separately and do not call it FELTUS cost or revenue. | Provider invoice or metered cost, usage events, ownership mode. |
| Cost | Build cost | Compute/resource cost for build attempts, with successful and failed attempts separated. | Worker resource/time metering, build status, app/account mapping. |
| Cost | Hosting / infrastructure | Direct recurring and variable infrastructure costs attributable to managed workloads; allocate shared capacity using a documented rule. | Provider invoices, resource allocation, environment and app mapping. |
| Cost | Storage | Storage and transfer costs by customer/app where measurable; disclose shared-cost allocation. | Storage metrics/invoices and app attribution. |
| Cost | Monitoring | Direct observability/logging/monitoring costs attributed by deployment model and account. | Vendor invoices, event/log volume, attribution method. |
| Cost | Support | Direct implementation/support labor and service costs, with time categories and allocation rules disclosed. | Ticket/implementation time, loaded cost policy, account/app mapping. |
| Economics | Revenue per customer | Recognized revenue for the measured period ÷ paying customer accounts. Separate subscription, managed-resource, and services revenue. | Billing ledger/invoices, credits/refunds, revenue policy, account IDs. |
| Economics | Revenue per active application | Recognized revenue allocated to active applications ÷ active applications, with allocation method disclosed. | Revenue and app activity plus allocation policy. |
| Economics | Gross profit per customer | Customer revenue minus direct delivery COGS (inference, build, hosting/infrastructure, storage, and monitoring as classified by the approved accounting policy). Report support cost separately and also show contribution after support. | Revenue, direct-cost ledger, cost allocation/accounting policy. |
| Economics | Gross profit per active application | Application-attributed revenue less application-attributed direct delivery COGS. | Application-level revenue and direct costs. |
| Economics | Gross margin percentage | `(recognized revenue - direct delivery COGS) / recognized revenue`; show denominator and period. Do not treat customer-paid BYOP costs as FELTUS revenue. | Revenue and COGS with consistent accounting treatment. |

### Deployment-model comparison

All three columns below are measurement designs, not actual economics.

| Model | Revenue to measure | FELTUS costs to include | Customer-funded costs to report separately | Main diligence question |
|---|---|---|---|---|
| FELTUS Managed | Platform fees plus managed-resource charges, discounts, and credits. | Actual underlying inference, compute/build, hosting, storage, monitoring, and direct support costs. | None assumed; disclose any pass-through or customer-specific purchases. | Does managed usage retain positive gross profit and acceptable support burden at observed load? |
| Bring Your Own Provider (BYOP) | FELTUS platform revenue and any disclosed integration/service revenue. | FELTUS-hosted control-plane, build, storage, monitoring, and support costs; any FELTUS-borne proxy/inference costs. | Provider costs paid directly by the customer. Keep these out of FELTUS revenue and COGS unless FELTUS actually bears or resells them. | Does customer-funded infrastructure improve FELTUS margins without excessive support/integration cost? |
| Customer-controlled infrastructure | Platform/license and any implementation revenue recognized by FELTUS. | FELTUS software/control-plane, build-if-FELTUS-run, storage, monitoring, and direct support costs. | Customer's cloud/server, database, registry, and inference spend; report only from customer-provided data. | Does lower FELTUS infrastructure exposure coexist with durable paid usage and manageable customer success cost? |

### Data and reporting protocol

- Define a cohort by first paid-start month and segment; retain acquisition channel and deployment model as dimensions. Never mix immature D30/D60/D90 cohorts with matured accounts.
- Use stable pseudonymous customer and application IDs. Keep PII and secrets out of investor exports.
- Record event source, timestamp, app/account scope, cost owner, and allocation method. Reconcile usage totals to invoices or ledger totals before reporting margins.
- Show denominators, missingness, sample counts, and distributions. Separate observed facts from modeled allocations and estimates.
- Publish one portfolio view and separate managed, BYOP, customer-controlled, agency, and direct-customer views. Do not pool models if costs or revenue treatment differ.

## 5. Founder Dependency Reduction Plan

### Ownership areas

| Workstream | Initial subsystem ownership | Transfer evidence |
|---|---|---|
| Platform / Infrastructure Engineering | Build workers; runtime infrastructure; deployment; reliability; observability; operational tooling. | A qualified non-founder diagnoses a controlled failed build, restores a disposable checkpoint, deploys a supported application in an authorized test environment, and explains system health from runbooks and telemetry. |
| Product / Frontend Engineering | Application-building experience; FELTUS CODE; frontend quality and interaction. Design Studio enters this ownership map only after that separately approved phase begins. | A qualified non-founder ships and reviews a scoped UX change, reproduces a defect, validates accessibility/interaction expectations, and preserves the server/API and state contracts. |
| Customer Implementation | Onboarding; application delivery; production adoption; routine support; feedback capture. | A qualified non-founder takes a test customer from kickoff through first working app and supported production adoption, handles a routine issue, and records feedback without founder intervention. |

These are ownership assignments to be named when the team is assessed; no hire, current employee, or existing transfer is assumed.

### Capability assessment

Assess each person using a controlled task, not a confidence survey. The ten capability tests are:

1. Set up and run the development environment from the documented prerequisites.
2. Explain the architecture, data boundaries, and the source-to-runtime lifecycle from the current documentation.
3. Diagnose a deliberately failing validation in a disposable fixture.
4. Diagnose a deliberately failing build without changing production configuration.
5. Deploy a supported application in an authorized, isolated environment and trace its artifact and health evidence.
6. Restore a disposable checkpoint and prove the restored file and source identity.
7. Explain repository classification and correctly identify why the mixed FELTUS root is blocked.
8. Onboard a test customer using the approved setup and evidence checklist.
9. Resolve a normal implementation/support issue and record the resolution and feedback.
10. Operate one assigned subsystem through a routine operational cycle without founder intervention.

Score each capability on this fixed progression:

| Stage | State | Evidence required |
|---:|---|---|
| 0 | Founder Only | Founder is required to execute or explain an undocumented critical step. |
| 1 | Documented | A current runbook exists and is reviewable, but an independent operator has not completed the task. |
| 2 | Shadowed | A non-founder completed the task while the founder observed; hidden decisions and missing runbook steps were recorded. |
| 3 | Independently Operable | A qualified non-founder completed two consecutive controlled runs from the documented process without founder intervention. |
| 4 | Owned | A named primary and backup have authority, operational measures, and sustained independent responsibility for the subsystem; the owner can update its runbook and handle normal changes. |

Use `NOT ASSESSED` rather than guessing a stage. Define the Founder Dependency Score (FDS) as a 0–100 index where higher means more dependency:

`FDS = 100 × Σ(4 − stageᵢ) / (4 × number of assessed capabilities)`

Always report assessment coverage (`assessed capabilities / 10`) beside FDS. Do not publish an aggregate as a readiness result until all ten capabilities are assessed. Establish any numeric FDS target before the first assessment; no score or target is available today.

For a transfer gate, every critical operating capability must reach at least **Independently Operable** and each workstream must have a named accountable owner and backup. A subsystem is not **Owned** merely because a person has read its documentation.

## 6. Evidence required

### Technical

- Fixture manifest, initial state, synthetic application/workspace IDs, source checkpoint, Blueprint revision/hash, branch, source snapshot SHA-256, and classifier version.
- Manual Git commands, full commit IDs, diffs, before/after hashes, classification reports, stale rejection codes, protected-operation results, and explicit review decisions.
- Check command, isolated snapshot identity, status/exit code/output summary, and proof the original external edit remained unchanged through failure and undo.
- For artifact/runtime proof only: immutable OCI digest, matching build/deployment/observation lineage, disposable target identity, health output, and teardown evidence. If the path requires a provider API or a live database write, it is outside this plan and remains unverified.
- Component ownership/reconciliation evidence only after the real component-level state and policy are available; no mocked ownership transition.

### Commercial

- Cohort definition and maturity; acquisition spend and paid-start evidence; billing/revenue ledger; app/customer mapping; usage and build events; deployment health; direct cost invoices/meters; support time; and allocation rules.
- Reconciliation notes, missing-data counts, model-specific cuts, and an audit trail connecting reported values to source records.
- No customer-level PII, credential, or secret values in the diligence pack.

### Organizational

- Named capability assessor and participant; task/runbook version; task result; intervention log; evidence links; stage decision; primary/backup owner; and date for reassessment.
- FDS and coverage by workstream, plus unresolved Founder Only/Documented capabilities and remediation owners.

## 7. Decision gates

| Gate | Pass condition | Fail / hold condition |
|---|---|---|
| D0 — Scope and isolation | Disposable fixture, no live application records, no Production/shared Staging, no provider API, and evidence capture are confirmed. | Any requirement to mutate live data or call a provider stops the run. |
| D1 — Repository resilience | Compatible, risk-scoped, protected, stale-plan, validation, and undo cases produce the expected source-bound results with no silent overwrite. | Any stale plan accepted, protected change auto-applied, manual change lost, or source made unusable. |
| D2 — Component ownership | Normal and structural component changes preserve work and produce the correct component-scoped ownership/reconciliation outcome without disabling unrelated application parts. | Capability absent, ownership is app-wide, change is overwritten, or rest of app is disabled. Mark **BLOCKED**, not passed. |
| D3 — Artifact/runtime lineage | A real local immutable artifact is built and the disposable runtime observation refers to the same commit, Blueprint, and digest. | Only preview, a mock, record-only row, or provider-dependent action is available. Mark **BLOCKED**. |
| D4 — Measurement readiness | Metric definitions, event mappings, cost attribution, cohort windows, privacy handling, actual/target labels, and owners are frozen before cohort analysis. | Missing denominators, unallocated material costs, post-hoc target changes, or unknown cohort maturity. |
| D5 — Cohort proof | D30, D60, and D90 values are reported only for matured cohorts; paid conversion, production adoption, model-specific cost, and margin are reconciled. | Insufficient or immature data, unexplained cost/revenue differences, or material negative contribution with no approved response. |
| D6 — Ownership transfer | Ten capabilities are assessed; critical capabilities meet the transfer rule; owners and backups demonstrate operation without founder intervention. | Critical steps remain Founder Only/Documented or evidence coverage is incomplete. |
| D7 — Investor-readiness review | Technical, commercial, and organizational evidence is traceable, limitations are disclosed, and leadership approves any targets and claims. | Any claim relies on simulated proof, unmeasured economics, unverified deployments, or an incomplete founder-dependency assessment. |

## 8. Risks that remain after each gate

- **After D1:** fixture success may not cover repository sizes, unusual Git layouts, or real customer workflows. It establishes bounded behavior, not general compatibility.
- **After D2:** component ownership can still fail under untested structural/UI changes; deterministic reconciliation must not be represented as semantic equivalence.
- **After D3:** one local runtime does not prove provider reliability, regional availability, production security, or multi-tenant scale. Provider acceptance remains a separate authorization and evidence requirement.
- **After D4:** instrumentation can be correct while early cohorts remain too small, immature, or biased to support broad claims.
- **After D5:** observed cohort margin may not persist at larger scale; managed-resource price changes, support load, and agency mix can move margins.
- **After D6:** independent drills do not prove long-term retention of knowledge or resilience to turnover. Reassess owners and backups periodically.
- **After D7:** diligence evidence does not guarantee product-market fit, regulatory readiness, security certification, or an investment outcome.

## 9. Recommended diligence sequence

1. **Freeze the evidence protocol.** Name the diligence owner, fixture operator, metric owner, and capability assessors. Approve definitions and evidence retention before collecting results.
2. **Prepare the disposable technical fixture.** Record a known synthetic Blueprint and Git checkpoint; verify there is no live database or provider configuration attached.
3. **Run source and stale-state cases.** Make manual changes through ordinary Git; reclassify, evaluate contracts, reject stale plans, validate, and exercise checkpoint/undo. Preserve every external edit.
4. **Resolve technical blockers honestly.** Run component ownership/reconciliation only if the real capability exists. Run artifact-to-runtime lineage only through a real provider-free local artifact and deployment path. Otherwise leave the gate blocked and record the needed capability/authorization separately.
5. **Lock cohort instrumentation before enrollment.** Map billing, product activity, build, AI, deployment, cost, and support records to stable account/application IDs; document attribution and missingness.
6. **Start cohort reporting only when the first paid cohort exists.** Publish actual, target, and not-yet-measured fields separately; wait for each cohort to mature before D30/D60/D90 claims.
7. **Run ownership drills while cohorts mature.** Use controlled failures and normal customer tasks; score all ten capabilities and transfer named primary/backup responsibility.
8. **Assemble the investor evidence pack.** Include raw evidence references, calculation notes, gate results, blockers, and explicit statements of what remains unverified. Do not turn blocked cases into success claims.

## 10. Investment-readiness milestones

1. **Evidence-ready:** technical fixture, metric dictionary, source mappings, privacy rules, assessment rubric, and named owners are approved.
2. **Technical-resilience demonstrated:** all executable repository cases pass. Component ownership and artifact/runtime cases are either demonstrated with real evidence or listed as explicit open blockers.
3. **Commercial-measurement ready:** actual and target schemas are approved, costs reconcile to source ledgers/invoices, and each deployment model has a documented attribution policy.
4. **Cohort outcomes observable:** paid conversion, activation, production time, usage, costs, margin, and matured D30/D60/D90 retention are reported for sufficiently mature cohorts, with sample size and missingness visible.
5. **Founder dependency reduced:** all ten capabilities are assessed, critical paths are independently operable, and platform, product, and implementation workstreams have accountable owners and backups.
6. **Investment claims reviewable:** every technical, commercial, and organizational statement maps to evidence; actuals are not confused with targets or forecasts; remaining risks and blocked gates are disclosed.

## Diligence matrix

| Question | Test | Evidence | Pass condition | Current status |
|---|---|---|---|---|
| Does FELTUS detect external repository changes? | Manual commit in disposable Git workspace; reclassify. | Commit IDs, diffs, hashes, classifications. | New state binds to exact new commit; old state is stale. | Phase F stale-plan controls verified locally; full external-developer drill not run. |
| Does it preserve developer work? | Exercise compatible, protected, failed-validation, and undo paths. | Before/after bytes and hashes; review/apply/undo records. | No silent overwrite; protected changes fail closed; undo is conflict-checked. | CODE lifecycle and protected-contract fixture coverage passed in Phase F. |
| Can management remain component-scoped? | Change a managed component within and beyond supported reconciliation. | scripts/design-studio-tests.mjs, cases 6–8: source diffs, reconciliation results, ownership transitions, unaffected component checks. | Only the affected component changes ownership; unrelated app capability stays usable. | Verified in the Phase F.5 disposable Git/CODE acceptance for supported variant reconciliation and unsupported structural preservation. |
| Can a deployed artifact be traced to runtime? | Build immutable local artifact and run it in a disposable provider-free target. | Commit/Blueprint/digest lineage, deployment event, health observation. | Same source and digest across build, deployment, and observation. | Blocked: provider-free artifact-to-runtime path not demonstrated; no provider calls authorized. |
| Are cohort economics attractive? | Reconciled cohort model by deployment mode and customer segment. | Billing, usage, costs, support, maturity, formulas. | Pre-registered targets met with transparent denominators and cost attribution. | Not yet measured: no real cohort dataset supplied. |
| Does usage persist and expand? | D30/D60/D90 customer and application retention; second-app and agency analysis. | Matured cohorts, event history, customer/app mapping. | Approved retention/expansion targets met; immature cohorts excluded. | Not yet measured. |
| Can the team operate without the founder? | Ten capability drills and subsystem ownership handoff. | Runbook versions, task results, intervention logs, FDS/coverage. | All critical capabilities independently operable; owners and backups demonstrated. | Not yet assessed; current team/task evidence not supplied. |
| Is FELTUS itself a safe productionization target? | Repeat root classification as a negative acceptance case. | Classification, safety flag, plan result. | Root remains blocked while mixed/unsafe; no weakened classifier. | Phase F verified this negative case: `MIXED`, unsafe, blocked, no change set. |

**Diligence conclusion:** Phases F and F.5 supply local lifecycle evidence. Component-scoped management is demonstrated for the tested supported and unsupported visual changes. Broader technical resilience under arbitrary external edits, immutable artifact-to-runtime verification, commercial unit economics, and independent subsystem ownership remain separate proof obligations. No commercial metric is claimed as actual until its source data is available and reconciled.
