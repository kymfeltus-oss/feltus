# Create App Wizard — Phase 2

Phase 2 connects the wizard's Data, Relationships, Documents, AI, and CODE steps to existing FELTUS APIs. The finished app workspace exposes those same capabilities alongside app activity, platform health, and app-scoped resource records. Each operation uses the active app ID and the existing authenticated server routes.

## Wizard and workspace routes

| Route | Behavior |
| --- | --- |
| `/apps/:appId/setup/data` | List model registry entries, inspect registered columns/system fields, create a model, change RLS |
| `/apps/:appId/setup/relationships` | Inspect the relationship map, add or remove supported foreign keys |
| `/apps/:appId/setup/documents` | Upload a supported file, process it, download saved extraction evidence |
| `/apps/:appId/setup/ai` | Save non-secret assistant settings and make a temporary streamed AI test |
| `/apps/:appId/setup/code` | Open the existing app-scoped FELTUS CODE UI |
| `/apps/:appId/setup/environment` | Read the saved environment label; provisioning options are not available |
| `/apps/:appId/setup/review` | Load current app, model, relationship, document, AI runtime, and CODE workspace state with edit links |
| `/apps/:appId/{data,relationships,documents,ai,code}` | Same capability views in the finished app workspace |
| `/apps/:appId/logs` | Read the latest app-scoped activity events and filter them by text/severity |
| `/apps/:appId/infrastructure` | Read platform service health and app-scoped asset records; no infrastructure is created |

The wizard saves its current step and reviewed steps through `/api/apps/:id/setup`. The stepper lets users revisit earlier steps. Build is visibly disabled because build orchestration is outside this phase. Review opens the app workspace and makes no claim that an app has been built or deployed.

## Button and action map

| Control | Action or state |
| --- | --- |
| Create model | `POST /api/models` with app ID, logical table name, custom column definitions, and RLS choice. FELTUS system fields are shown from the registered model schema. |
| Add field / Remove field | Adds or removes an unsaved field row in the create form. |
| RLS On/Off | `POST /api/models/rls` for the selected model. |
| Edit, delete, duplicate model / preview rows | Not shown as enabled actions. The existing API has no model mutation or row-preview endpoint. The page states this limitation and shows the real schema preview. |
| Create foreign key | `POST /api/relationships` with a pre-existing UUID source field, target model primary key, and supported delete action. This is the existing many-to-one foreign-key behavior. |
| Remove relationship | Confirmation followed by `POST /api/relationships/delete`. Changing a relationship requires removing and recreating it because no update endpoint exists. |
| Upload file | Raw file bytes sent to `POST /api/documents/upload`; the UI accepts TXT, MD, CSV, JSON, PDF, DOCX, and XLSX up to 20 MB. |
| Process document | `POST /api/documents/process`; status is reloaded from `/api/documents`. |
| Download extraction evidence | Opens the existing `/api/documents/extraction` response for that document. Processed documents are eligible for the existing AI retrieval pipeline. Source trust policy remains server-managed. |
| Save assistant settings | Persists model, instructions, temperature, response tokens, and context budget as non-secret app setup JSON via `/api/apps/:id/setup`. No credentials are accepted in that field. |
| Send test prompt | Creates an app-scoped AI conversation, streams `/api/ai/chat/stream`, displays actual output, then deletes the temporary conversation. Disabled with a reason while the runtime is unavailable. |
| CODE editor | Embeds `/api/code/ui?app_id=...`; controls inside that existing workspace retain its server-side path and task restrictions. |
| Logs search/severity | Filters the latest 100 events returned by `/api/activity?app_id=...`. |
| Infrastructure refresh | Reads `/api/system-health` and `/api/assets?app_id=...`. It is informational; no create/deploy action is exposed. |
| Review edit links | Navigate to the corresponding wizard route. Counts and readiness text come from current APIs and saved app setup values. |
| Save Progress | On capability steps, saves the resume location; each model/relationship/document/assistant action has its own explicit save operation. Unsaved form values trigger a discard confirmation before leaving. |
| Continue | Saves the next setup step and marks the current step reviewed. It does not imply that optional resources exist; unsaved forms require confirmation before discard. |
| Open App Workspace | Marks Review as reviewed and opens the app overview. Build/deploy state remains unprovisioned. |
| Build / Deploy / Promote / Roll back / Invite team | Omitted or disabled with the later-phase reason; no action is simulated. |

## Phase boundary

No GitHub connection, generated starter app, build runner, immutable artifact, preview environment, deployment orchestration, production promotion, rollback, team invitations, app runtime preview, or infrastructure provisioning is introduced here. The Code workspace is the existing private FELTUS CODE capability only. Environment is a read-only display of the saved app label; secrets and environment-specific resource creation remain outside this phase.

## Verification

`npm run check` validates JavaScript syntax, including the new capability module. `npm run test:wizard` covers route resolution, saved-step persistence, allowed reviewed steps, build-step rejection, capability HTML escaping, and mock-backed rendering of the Data, Relationships, Documents, AI, CODE, Logs, Infrastructure, and Review panels. These checks use local handlers/mocks; they do not call staging or production services.
