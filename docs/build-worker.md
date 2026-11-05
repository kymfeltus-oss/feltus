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
| `FELTUS_BUILDKIT_CA_PEM` | build-worker secret (legacy) | Backwards-compatible environment PEM for validating the BuildKit server. |
| `FELTUS_BUILDKIT_CLIENT_CERT_PEM` | build-worker secret (legacy) | Backwards-compatible environment PEM for the BuildKit mTLS client certificate. |
| `FELTUS_BUILDKIT_CLIENT_KEY_PEM` | build-worker secret (legacy) | Backwards-compatible environment PEM for the BuildKit mTLS client private key. |
| `FELTUS_BUILDKIT_CA_FILE` | build-worker service | Absolute path to a mounted BuildKit CA file. Takes precedence over the legacy PEM variable. |
| `FELTUS_BUILDKIT_CLIENT_CERT_FILE` | build-worker service | Absolute path to a mounted BuildKit client certificate file. Takes precedence over the legacy PEM variable. |
| `FELTUS_BUILDKIT_CLIENT_KEY_FILE` | build-worker service | Absolute path to a mounted BuildKit client private key file. Takes precedence over the legacy PEM variable. |
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

## Staging credential rotation

Staging uses `compose.staging.yaml`, which mirrors the Production service graph but injects BuildKit mTLS credentials as three file-backed Compose secrets. The secret values live only on the Staging deployment host under versioned directories at `/etc/feltus/staging/buildkit/releases/`; Compose reads through the stable `/etc/feltus/staging/buildkit/current/` symlink. They are never environment values or repository files. The worker copies each file into a mode-0600 temporary runtime directory, validates PEM framing and base64 encoding, and redacts the credential material from persisted build logs. Invalid or unreadable files keep the worker offline with the generic `BUILDKIT_CREDENTIALS_INVALID` code.

The Staging Compose file is intentionally separate so Coolify can stop owning the legacy `*_PEM` environment variables without changing `compose.production.yaml`. Keep its non-worker service definitions in sync with Production; the regression suite checks that those service blocks remain identical. Production continues to use the legacy environment PEM mapping until separately reviewed and migrated.

For the one-time Staging migration, first copy the already-rotated v2 files into a versioned directory and point the stable symlink at it. On the Coolify server, run these commands without printing file contents:

```sh
sudo install -d -o root -g 1000 -m 0750 /etc/feltus/staging/buildkit /etc/feltus/staging/buildkit/releases/v2
sudo install -o root -g 1000 -m 0440 /root/feltus-buildkit-client-v2/ca.pem /etc/feltus/staging/buildkit/releases/v2/ca.pem
sudo install -o root -g 1000 -m 0440 /root/feltus-buildkit-client-v2/client-cert.pem /etc/feltus/staging/buildkit/releases/v2/client-cert.pem
sudo install -o root -g 1000 -m 0440 /root/feltus-buildkit-client-v2/client-key.pem /etc/feltus/staging/buildkit/releases/v2/client-key.pem
sudo -u '#1000' sh -c 'test -r /etc/feltus/staging/buildkit/releases/v2/ca.pem && test -r /etc/feltus/staging/buildkit/releases/v2/client-cert.pem && test -r /etc/feltus/staging/buildkit/releases/v2/client-key.pem'
sudo ln -s releases/v2 /etc/feltus/staging/buildkit/current
```

Then, in the Staging resource only:

1. Open **Configuration → General → Edit Compose File** and set the Compose file path to `compose.staging.yaml` in the connected repository.
2. Save, validate, and reload the Compose definition. Inspect **Deployable Compose**: the three BuildKit values must appear under `secrets`/`/run/secrets`, with no legacy `*_PEM` environment references.
3. Remove `FELTUS_BUILDKIT_CA_PEM`, `FELTUS_BUILDKIT_CLIENT_CERT_PEM`, and `FELTUS_BUILDKIT_CLIENT_KEY_PEM` from the Staging Environment Variables page. They should unlock once Coolify reparses a Compose definition that no longer references them.
4. Redeploy the Staging resource. Confirm the worker reports healthy and run the mTLS check in [Final acceptance commands](#final-acceptance-commands).

Future rotations install the complete new chain under `releases/v3/` (or the next unused version), validate its permissions and trust chain, create a temporary symlink to that release, then atomically replace `current` before restarting only the Staging build-worker:

```sh
sudo install -d -o root -g 1000 -m 0750 /etc/feltus/staging/buildkit/releases/v3
sudo install -o root -g 1000 -m 0440 /root/feltus-buildkit-client-v3/ca.pem /etc/feltus/staging/buildkit/releases/v3/ca.pem
sudo install -o root -g 1000 -m 0440 /root/feltus-buildkit-client-v3/client-cert.pem /etc/feltus/staging/buildkit/releases/v3/client-cert.pem
sudo install -o root -g 1000 -m 0440 /root/feltus-buildkit-client-v3/client-key.pem /etc/feltus/staging/buildkit/releases/v3/client-key.pem
sudo -u '#1000' sh -c 'test -r /etc/feltus/staging/buildkit/releases/v3/ca.pem && test -r /etc/feltus/staging/buildkit/releases/v3/client-cert.pem && test -r /etc/feltus/staging/buildkit/releases/v3/client-key.pem'
sudo ln -s releases/v3 /etc/feltus/staging/buildkit/current-v3
sudo mv -Tf /etc/feltus/staging/buildkit/current-v3 /etc/feltus/staging/buildkit/current
```

Compose and Coolify environment-variable definitions do not change. Do not copy the Staging files into the Production server or change Production's Compose path as part of this migration.

## Final acceptance commands

Run these from the Coolify server shell. They report health/configuration status only; they do not print PEM values:

```sh
curl -fsS https://labs.feltusforensicintel.com/api/health
curl -fsS https://labs.feltusforensicintel.com/api/ready

WORKER="$(docker ps --filter 'label=coolify.applicationUuid=zvdbtjiy9znzo8zjtmvborit' --filter 'label=com.docker.compose.service=build-worker' --format '{{.ID}}' | head -n1)"
test -n "$WORKER"

docker exec "$WORKER" node -e 'const fs=require("node:fs");const e=process.env;const p=[e.FELTUS_BUILDKIT_CA_FILE,e.FELTUS_BUILDKIT_CLIENT_CERT_FILE,e.FELTUS_BUILDKIT_CLIENT_KEY_FILE];const files=p.length===3&&p.every(x=>x&&fs.accessSync(x,fs.constants.R_OK)===undefined);const legacy=[e.FELTUS_BUILDKIT_CA_PEM,e.FELTUS_BUILDKIT_CLIENT_CERT_PEM,e.FELTUS_BUILDKIT_CLIENT_KEY_PEM].every(x=>!x);console.log(JSON.stringify({credentialFilesReadable:files,legacyPemVariablesUnset:legacy}));process.exit(files&&legacy?0:1)'
docker exec "$WORKER" node -e 'fetch("http://127.0.0.1:8082/health").then(async r=>{const h=await r.json();console.log(JSON.stringify({httpStatus:r.status,status:h.status,ready:h.ready,lastErrorCode:h.last_error_code}));process.exit(r.ok&&h.ready?0:1)}).catch(()=>process.exit(1))'
docker exec "$WORKER" sh -lc 'buildctl --addr "$FELTUS_BUILDKIT_ADDR" --tlscacert "$FELTUS_BUILDKIT_CA_FILE" --tlscert "$FELTUS_BUILDKIT_CLIENT_CERT_FILE" --tlskey "$FELTUS_BUILDKIT_CLIENT_KEY_FILE" debug workers'

if docker logs "$WORKER" 2>&1 | grep -Eq -- '-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----'; then
  echo 'FAIL: private-key PEM marker found in worker logs'
  exit 1
else
  echo 'PASS: no private-key PEM marker in worker logs'
fi
```

## Start and verify configuration

After the isolated BuildKit host and secret-manager values are ready:

1. Set `FELTUS_BUILD_WORKER_ENABLED=true` and `FELTUS_BUILD_RUNNER_ENABLED=true`.
2. Start the service with `docker compose -f compose.production.yaml --profile build up -d build-worker`.
3. Confirm `/health` is healthy and `feltus_worker_heartbeats` has a recent `worker_type=build`, `status=online` row.
4. Queue an exact GitHub commit and verify checkout, build logs, exit code, registry HEAD digest, and Blueprint/commit/build/artifact lineage.
5. Configure only the isolated Staging Coolify target, deploy the published digest through the existing infrastructure outbox, and verify health, observed state, and deltas.

The build service profile is opt-in. With missing or invalid builder/registry configuration it does not heartbeat online, and the app API keeps builds unavailable. It never falls back to host Docker or runs a simulated build.
