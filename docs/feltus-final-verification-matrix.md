# FELTUS Final Verification Matrix

This matrix consolidates existing documented phase status and evidence only. It does not re-audit completed phases. `VERIFIED` below means verified within the documented boundary; it does not imply live Production verification unless the evidence says so.

| Capability | Phase | Status | Required Evidence | Remaining Gate |
|---|---|---|---|---|
| Application Intelligence | Application Intelligence | VERIFIED | Canonical application profile, capability graph, Blueprint normalization, and existing local application-state test evidence | Preserve source-to-Blueprint identity in later release and runtime evidence |
| Data | Data | VERIFIED | Existing data-model, relationship, destructive-lifecycle, migration, and project-scoped access evidence | Live staging migration/RLS and legacy-data preservation remain outside completed local verification |
| Knowledge | Knowledge | VERIFIED | Existing document, extraction, chunk, embedding, eligibility, and project-scope evidence | Production persistence and configured runtime integration remain live-environment gates |
| AI | AI | PARTIAL | Implemented provider-neutral adapters, trust policy, prompt/history isolation, redirect refusal, and local regression evidence | Verify the selected AI provider, ownership, credentials, network path, and runtime behavior in an approved environment |
| FELTUS CODE | FELTUS CODE | VERIFIED | Local CODE tests for workspace isolation, safe file operations, source-hash conflict protection, allowlisted tasks, explicit checkpoints, and cancellation | Authenticated browser flow against live project data and host-permitted symlink/junction runtime cases remain open |
| Repository Intelligence | Phase E | VERIFIED | Source-bound classifier, complete snapshot hash, branch/checkpoint binding, engineering-standard evidence, and stale-source rejection | Phase G must consume this evidence without introducing a second classifier |
| Productionization | Phase F | VERIFIED | Disposable Git/CODE acceptance for classification, bounded planning, isolated validation, protected-contract blocking, checkpointing, and undo | Runtime/provider verification is not supplied by Phase F and must remain separately gated |
| Design Studio | Phase F.5 | VERIFIED | Tested Design State binding, component ownership, supported reconciliation, Developer Managed preservation, exact-path validation/checkpoint, and undo | Real authenticated browser/model-provider execution remains outside the fixture boundary |
| Preview | Phase F.5 | VERIFIED | Live isolated Docker Preview of exact reviewed source, matching source identity, served-content hashes, and verified teardown | Preview is local validation evidence only; it is not build, artifact, deployment, or observed-runtime proof |
| Release Readiness | Phase G | PREPARED | Approved architecture, exact source-binding contract, six readiness states, gate semantics, progressive disclosure, and deterministic acceptance-test design | Implement Phase G and pass its acceptance suite plus applicable established suites |
| Build | Phase H | PARTIAL | Existing build records/contracts, local build-related tests, Compose image-build evidence, and explicit build-eligibility boundary | No verified production build runner or source-bound Phase G readiness-to-build execution exists |
| Artifact | Phase H.5 | BLOCKED | Immutable artifact record tied to build, Blueprint, full commit, registry reference, and digest | Build and publish a real immutable artifact; OCI publishing/promotion and artifact-to-runtime proof remain absent |
| Deployment | Phase I | BLOCKED | Artifact-backed deployment with exact Blueprint/commit/digest lineage, authorized environment target, provider event, and health evidence | Isolated staging, target mapping, provider credentials, Coolify execution, domain/TLS, and health verification have not been completed |
| Observed State | Phase I | BLOCKED | Append-only provider observation matching deployment, Blueprint, source commit, artifact digest, environment, health, and observation hash | No real artifact-backed runtime observation has closed the documented diligence gap |
| Day-2 Reconciliation | Phase J | PARTIAL | Owner-only acceptance of an exact observed checkpoint, immutable replacement Blueprint, explicit restore selection, and recurring reconciliation evidence | Observation remains deployment-level; runtime configuration, schema-version, infrastructure-target drift, and live reconciliation remain unverified |
| Trust & SOC 2 Testing Readiness | Cross-cutting | PREPARED | Evidence inventory, control/test mapping, ownership, retention, exception handling, and reviewable testing-readiness claims | Execute control tests and collect reviewable evidence; no certification claim is authorized |
| Portable Export | Repository finalization | PARTIAL | Local export from a recorded Git checkpoint with filtered source, manifest, dependency/build metadata, applicable data/infrastructure assets, and environment-variable names | Verify archive recovery/consumption in a clean external environment without weakening secret filtering |
| Execution Provenance | Repository finalization | PARTIAL | Correlated productionization runs, checks, source snapshots, transformations, apply actions, checkpoints, usage, build, artifact, deployment, and observation references | Context fingerprints and retrieved document/chunk links are not recorded for every execution path |
| Git/source portability | Repository finalization | PARTIAL | Exact Git checkpoint/commit binding plus exportable source and applicable application-owned assets | Clean-checkout portability and end-to-end build/run from the exported checkpoint remain unverified |
| protected contracts | Phase F | VERIFIED | Conservative contract map plus tested blocking of protected route/authorization/serialized-contract changes before apply | Continue to require an explicit versioned compatibility or migration workflow; heuristic classification is not behavioral proof |
| checkpoints/undo | FELTUS CODE / Phase F / Phase F.5 | VERIFIED | Explicit checkpoint confirmation, exact source/path binding, conflict-checked undo, byte/hash restoration, and retained Git history | Preserve current-source checks and never treat undo as deployment rollback or runtime restoration |

## Artifact-to-runtime diligence boundary

Source validation, Design Studio reconciliation, and local Docker Preview do not prove that an immutable artifact was built, published, deployed, or observed in a runtime. The required end-to-end lineage remains:

`source checkpoint -> build -> immutable artifact digest -> deployment -> provider observation`

That diligence gate remains **BLOCKED** until one exact Blueprint, full source commit, artifact digest, deployment, and observed runtime are demonstrated with matching lineage.
