# FELTUS go-live gates

Status for the repository checkout as of 2026-10-30. “Verified locally” means the repository checks passed in this environment; it does not mean a public deployment has been tested.

| Gate | Status | Evidence / required action |
| --- | --- | --- |
| Production Compose configuration | Verified locally | `docker compose --env-file .env.example --file compose.production.yaml config --quiet` passed. |
| App and extractor regression checks | Verified locally | `npm run check`, `npm run regression`, and extractor unit tests passed. |
| GitHub automated checks | Workflow added; first run unverified | The review branch is configured to run checks on every branch push. Confirm syntax/regression, Python tests, Compose validation, and app/extractor image builds pass in GitHub Actions. |
| Live project/data isolation | Not verified against a running backend | Source and RLS wiring checks pass locally; run two-owner/project API and document/conversation isolation tests against an isolated self-hosted stack. |
| Coolify application and runtime secrets | Not verified | Configure the Compose resource and secrets in Coolify. Never copy real values into Git. |
| DNS and TLS for `feltuslabs.com` / `www` | Not verified | Point DNS at the Coolify host, issue certificates, enforce HTTPS, then check both domains. |
| Production owner bootstrap and login | Not verified | Run the one-time owner bootstrap and validate the session on the deployed site. |
| Email recovery | Implemented, not verified | Configure SMTP and complete an end-to-end reset from the deployed domain, or explicitly launch with recovery unavailable. |
| Scheduled encrypted off-host backups | Not verified | Install the host schedule and copy backups to a separate encrypted location. |
| Full database + file restore drill | Not verified | Restore into a separate project/empty volumes and validate app, records, documents, and sidecars. A dump archive listing is not a restore drill. |
| Production browser security and end-to-end checks | Not verified | Run against the deployed domain after DNS/TLS/auth setup. |
| Multi-user GA and commercial roadmap | Not implemented | Organizations, memberships/roles, billing, workflow automation, and the broader builder/admin features require future implementation. The current model is a single configured owner. |

The current code can be prepared for a private, single-owner deployment after the external gates pass. It is not yet evidence of a live production service or a multi-tenant general-availability release.
