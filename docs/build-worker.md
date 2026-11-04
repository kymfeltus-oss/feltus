# Isolated build worker

Phase 3 builds run in a separate `build-worker` service. The FELTUS application container and this worker do not receive a Docker socket. The worker uses `buildctl` over mutually authenticated TLS to a separately operated BuildKit endpoint. BuildKit executes repository Dockerfiles; the worker container only checks out the pinned Git commit, uploads that context, verifies the pushed OCI digest, and records the artifact.

## Isolation boundary

The BuildKit endpoint is an external execution boundary, not a Compose sidecar. Run it on a dedicated isolated builder host or pool that has no route to the FELTUS database, production services, Coolify API, or other trusted control-plane networks. Use rootless BuildKit with mTLS, a separate per-job execution/network boundary, bounded CPU/memory/disk/time, and no host filesystem mounts or Docker socket. Rootless BuildKit's network mode must be isolated from its host; see the [BuildKit rootless guidance](https://github.com/moby/buildkit/blob/master/docs/rootless.md) and [mTLS TCP guidance](https://github.com/moby/buildkit/blob/master/README.md#expose-buildkit-as-a-tcp-service). Do not enable the FELTUS build flag until this isolation has been verified.

The FELTUS build worker itself runs non-root, read-only, without Linux capabilities, with a temporary no-exec workspace, and receives only Git credential decryption, BuildKit mTLS client, registry push, and database service credentials. GitHub access tokens and registry credentials are never sent as Docker build arguments or included in the source context. The worker redacts credential patterns and known secrets before writing bounded build logs.

## Configure

Use the deployment secret manager. Do not commit secret values.

| Name | Configure in | Purpose |
| --- | --- | --- |
| `FELTUS_BUILD_RUNNER_ENABLED` | app service | Allows build requests only when a fresh online build-worker heartbeat also exists. |
| `FELTUS_BUILD_WORKER_ENABLED` | build-worker service | Starts claims after all worker dependencies are configured. |
| `FELTUS_BUILDKIT_ADDR` | build-worker service | `tcp://<isolated-builder-host>:<port>` endpoint. |
| `FELTUS_BUILDKIT_CA_PEM` | build-worker secret | CA for validating the BuildKit server. |
| `FELTUS_BUILDKIT_CLIENT_CERT_PEM` | build-worker secret | BuildKit mTLS client certificate. |
| `FELTUS_BUILDKIT_CLIENT_KEY_PEM` | build-worker secret | BuildKit mTLS client private key. |
| `FELTUS_ARTIFACT_REGISTRY` | build-worker service | Lowercase registry/repository prefix, e.g. `ghcr.io/feltus-apps`. |
| `FELTUS_ARTIFACT_REGISTRY_USERNAME` | build-worker service | Registry push identity. |
| `FELTUS_ARTIFACT_REGISTRY_PASSWORD` | build-worker secret | Registry token with least privilege to push and verify FELTUS images. |
| `FELTUS_SECRET_ENCRYPTION_KEY` | app and build-worker secrets | App uses it for GitHub OAuth; worker uses it only to decrypt the connected repository credential. |
| `FELTUS_GITHUB_CLIENT_ID` | app service | GitHub OAuth App client ID used when users connect repositories. |
| `FELTUS_GITHUB_CLIENT_SECRET` | app secret | GitHub OAuth App client secret used when users connect repositories. |
| `FELTUS_PUBLIC_URL` | app service | Public callback origin for GitHub OAuth; production must use HTTPS. |
| `FELTUS_COOLIFY_URL` | existing infrastructure worker | Coolify API endpoint for the verified Staging target. |
| `FELTUS_COOLIFY_API_TOKEN` | existing infrastructure worker secret | Scoped Coolify read/write/deploy token for the Staging resource. |
| `FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS` | existing infrastructure worker | Must include `staging`; leave `production` out. |
| `FELTUS_COOLIFY_RESOURCE_MAP` | existing infrastructure worker | Maps `staging` to the verified isolated Staging resource UUID. |

The build worker uses existing encrypted GitHub connection rows; it does not need the GitHub OAuth client secret. Its database reads are service-role requests and are scoped again to the claimed app, repository, and organization before source checkout.

## Start and verify configuration

After the isolated BuildKit host and secret-manager values are ready:

1. Set `FELTUS_BUILD_WORKER_ENABLED=true` and `FELTUS_BUILD_RUNNER_ENABLED=true`.
2. Start the service with `docker compose -f compose.production.yaml --profile build up -d build-worker`.
3. Confirm `/health` is healthy and `feltus_worker_heartbeats` has a recent `worker_type=build`, `status=online` row.
4. Queue an exact GitHub commit and verify checkout, build logs, exit code, registry HEAD digest, and Blueprint/commit/build/artifact lineage.
5. Configure only the isolated Staging Coolify target, deploy the published digest through the existing infrastructure outbox, and verify health, observed state, and deltas.

The build service profile is opt-in. With missing or invalid builder/registry configuration it does not heartbeat online, and the app API keeps builds unavailable. It never falls back to host Docker or runs a simulated build.