# Create App Wizard — Phase 1

The app launcher replaces the platform dashboard as the default experience. The prior console remains available at `/platform` while existing capabilities move into dedicated app routes.

## Routes

| Route | Experience |
| --- | --- |
| `/` | Home, recent activity, app drafts, and platform health summary |
| `/apps` | App list with All, Draft, Active, and Archived filters |
| `/apps/new` | Create App introduction and setup-flow preview |
| `/apps/new/basics` | First step before an app record exists |
| `/apps/:appId` | Concise app overview |
| `/apps/:appId/setup/:step` | Wizard shell; App Details is active, later steps are explicit placeholders |
| `/apps/:appId/code` | Existing project-scoped FELTUS CODE UI |
| `/apps/:appId/logs` | Existing project-scoped activity records |
| `/apps/:appId/{data,relationships,documents,ai,deployments,environments,infrastructure,team,settings}` | Dedicated extension routes with a clear capability explanation |

All application-shell routes are served by the same HTML shell, so direct navigation and browser reloads work. The route resolver rejects unknown paths and malformed application IDs.

## Draft persistence

Wizard fields live on the existing `feltus_applications` row. Migration `20261103020000_create_app_wizard.sql` adds the app description/type/icon/accent and setup status/current step/completed steps/non-secret JSON setup data. Existing applications keep the migration's active/overview defaults; only apps created through the wizard begin as drafts, so pre-existing project data is not reclassified.

The entry screen does not create an application. Saving or continuing from App Details calls the authenticated `/api/apps` endpoint. Further setup state is read from and patched through `/api/apps/:id` and `/api/apps/:id/setup`. Row-level ownership remains the existing FELTUS application policy. Duplicate names return a conflict, and invalid basics remain in the browser form for correction. Setup JSON rejects secret-like property names and is size/depth bounded.

Draft records live in Postgres, so browser refresh and Node process restarts do not lose saved values. Resume sends draft applications to their saved `setup_current_step`.

## Interaction map

| Action | Result |
| --- | --- |
| Create New App | Opens `/apps/new`; creates no record |
| Start Setup | Opens `/apps/new/basics` |
| Cancel | Returns to `/apps` without creating an app |
| Save Draft | Validates and creates/updates the server-side draft; stays in Basics |
| Continue to Data | Saves Basics, marks it complete, changes status to configuring, and opens the Data placeholder |
| Back | Goes to the previous route; changed Basics are saved first for an existing app; a new unsaved form requires discard confirmation |
| Exit Setup | Saves when valid, confirms, then returns to `/apps`; if saving fails, offers to keep the last saved version |
| Resume Setup | Opens the saved step for a draft/configuring app |
| View Details / Open App | Opens the app management overview |
| Archive | Confirms, updates the app status through the server, then refreshes the list |
| Overview sidebar routes | Navigate to dedicated pages; Code opens FELTUS CODE and Logs reads activity; unconnected capabilities show a reasoned placeholder |

## Deliberately deferred

Data/model editing, relationship configuration, document setup, AI setup, environment management, GitHub connections, build runner execution, artifact publication, preview environments, deployment orchestration, production promotion, team invitations, and app runtime preview are not exposed as working actions in Phase 1. Build and subsequent wizard steps show disabled continuation with an explanation. No build progress is simulated.

The existing platform console is retained at `/platform` during migration. It is not linked as an app-workspace capability.
