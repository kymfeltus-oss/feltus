# FELTUS Design Studio

FELTUS Design Studio is a visual surface in the existing FELTUS CODE workspace. It edits the authorized application's existing source through the CODE change-set, isolated validation, exact-path staging, checkpoint, and undo lifecycle. It does not create a second application builder or source store.

## Architecture

The flow is:

Application Intelligence and capabilities → recipe suggestions → Design State → Canvas proposal → CODE review → isolated validation → exact-path checkpoint → actual Preview → reconciliation

Design Studio reads the existing application classification, capability graph, data model schema, CODE branch, checkpoint, source snapshot, and Phase E classifier version. Recipe recommendations are advisory and do not change application classification. Low-confidence recommendations remain suggestions.

feltus.design-state/v1 is the one authoritative visual-intent contract for recipe selection, token customization, responsive settings, component ownership, guardrails, Canvas properties, and AI proposals. The state is persisted under the application's existing setup_data.code.design field using the private feltus.design-state-storage/v1 representation. Sensitive-looking field names such as tokens are hex-encoded in setup-data storage to satisfy FELTUS's existing secret-key validator, then decoded before Design Studio reads the state or the application-state API constructs feltus.application-state/v1. The public desired blueprint and its hash therefore use the canonical Design State shape.

Design writes use existing app setup-data optimistic concurrency (setup_updated_at) and Design State hash checks. The setup-data limit remains in force; Design State is bounded, and saving fails safely if the rest of the app's setup data leaves insufficient capacity.

## Recipes and profile

The catalog is generated from 15 application-style families and five design directions, yielding 75 configurable recipes. Each recipe provides color, typography, spacing, radius, shadow, layout, motion, accessibility, and desktop/tablet/mobile defaults. Users may customize bounded tokens and components to form a derived Custom Design Profile. Conservative, Premium, and Bold variations use the same property validation and Brand Guardrails as manual edits.

Recommendations use existing Application Intelligence, the application type, and enabled capabilities. The full catalog remains available regardless of recommendation confidence.

## Managed component contract

Deterministic Canvas synchronization is limited to supported HTML elements carrying the managed identity attributes:

    <section
      data-feltus-id="featured-products"
      data-feltus-component="section"
      data-feltus-page="home"
      data-feltus-variant="spacious"
      data-feltus-managed="v1">
      Featured products
    </section>

The supported type and property catalogs are allowlisted. Design Studio does not expose arbitrary markup edits, absolute-position dragging, script changes, route edits, data-binding changes, permission changes, or business-logic changes. It links conventional CSS at src/feltus-design.css; application HTML and CSS do not need the FELTUS visual editor at runtime.

The Preview iframe renders the app's real isolated CODE Preview. Its Canvas overlay supports selecting data-feltus-id elements and temporarily previews proposal CSS. It does not substitute a standalone mock screen for the app. Responsive controls select desktop, tablet, and mobile widths and preserve viewport-specific component overrides.

## AI and guardrails

AI Design Chat receives the application classification, capabilities, current Design State, selected page/component, responsive target, Brand Guardrails, and a bounded redacted excerpt of the selected managed HTML component(s). It returns structured property actions only. The server independently enforces selected component/page scope and validates every action. A selected Developer Managed component cannot receive an AI edit until it is reconnected.

Brand Guardrails cover allowed and prohibited colors, repository-relative logo references, typography, density, component types, locked values, and accessibility minimum targets/contrast. Guardrail failures block proposal creation with a named reason. AI does not write source directly.

## CODE, preview, and undo

Every source-changing proposal is bound to application ID, workspace, branch, checkpoint, complete source snapshot hash, classifier version, and Design State hash. Review rechecks those identities and protected contracts. Apply requires the exact review confirmation, runs the available allowlisted CODE validation task in an isolated workspace, stages only proposal paths, and creates a new checkpoint. The CODE backup holds before/after Design State metadata so undo can verify the contract before restoring any file. Undo uses the existing CODE backup, stages only restored paths, makes a new checkpoint, and restores the prior Design State.

If source or the Design State changes after review, the proposal is rejected. If persistence fails after a source checkpoint, the lifecycle attempts a compensating CODE undo and checkpoint; it does not reset or discard unrelated work. Existing CODE checks also prevent design proposals while other staged or unstaged repository changes exist.

## Reconciliation and ownership

Ownership is tracked per component:

- FELTUS Managed — bounded Canvas editing is available.
- Developer Managed — source is retained and Canvas/AI edits are blocked for that component.
- Reconciliation Required — structural source changes require a user decision.

A deterministic external data-feltus-variant change updates only the matching component and records AUTOMATIC_RECONCILIATION evidence. An unsupported structural change marks that component Developer Managed and preserves its exact source. Sibling managed components remain editable. A user can request reconnection; the resulting CODE diff restores the supported managed marker/type and is validated and checkpointed before it takes effect.

The generated shared stylesheet is tracked by source hash. External stylesheet edits are reported as application-level reconciliation evidence, and visual proposals are blocked until the stylesheet is restored or otherwise resolved. Design Studio will not overwrite a developer stylesheet edit just because its generated header remains present.

No claim is made that arbitrary frameworks, arbitrary HTML, source CSS, or manually modified component structure can be mapped perfectly back to Canvas. Unsupported source remains usable as ordinary application code; only supported marked components participate in deterministic synchronization.

## Verification boundary

npm run test:design-studio uses a disposable Git-backed application fixture and the real FELTUS CODE handlers. It covers recipe recommendations and selection, storage encoding, scoped Canvas and AI edits, responsive settings, guardrail blocking, external reconciliation, component isolation, reconnect, protected contracts, stale proposals, preview HTML/CSS delivery, and CODE undo. It does not call providers, a remote model, Production, or shared Staging. The existing Build Studio/Docker tests cover the Preview service separately; automated fixture coverage is not a substitute for a user-authenticated browser run against a real authorized application.
