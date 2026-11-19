BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';

INSERT INTO public.feltus_applications (
    id,
    owner_id,
    app_name,
    environment
)
VALUES (
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Synthetic Control Plane Fixture',
    'development'
);

INSERT INTO public.feltus_git_connections (
    id,
    organization_id,
    provider,
    account_label,
    credential_ciphertext,
    encryption_key_version,
    created_by
)
SELECT
    '30000000-0000-0000-0000-000000000001',
    app.organization_id,
    'github',
    'synthetic-test-account',
    decode('00', 'hex'),
    'test-fixture',
    app.owner_id
FROM public.feltus_applications app
WHERE app.id = '10000000-0000-0000-0000-000000000001';

INSERT INTO public.feltus_repositories (
    id,
    organization_id,
    git_connection_id,
    provider_repository_id,
    repository_name,
    clone_url,
    default_branch
)
SELECT
    '40000000-0000-0000-0000-000000000001',
    app.organization_id,
    connection.id,
    'synthetic-control-plane-fixture',
    'synthetic/control-plane-fixture',
    'https://example.invalid/synthetic/control-plane-fixture.git',
    'main'
FROM public.feltus_applications app
JOIN public.feltus_git_connections connection
  ON connection.organization_id = app.organization_id
WHERE app.id = '10000000-0000-0000-0000-000000000001';

INSERT INTO public.feltus_project_repositories (
    organization_id,
    app_id,
    repository_id,
    attached_by
)
SELECT app.organization_id, app.id, repository.id, app.owner_id
FROM public.feltus_applications app
JOIN public.feltus_repositories repository
  ON repository.organization_id = app.organization_id
WHERE app.id = '10000000-0000-0000-0000-000000000001';

INSERT INTO public.feltus_application_blueprints (
    id,
    organization_id,
    app_id,
    version,
    state_hash,
    state,
    source_commit,
    status,
    created_by
)
SELECT
    '50000000-0000-0000-0000-000000000001',
    app.organization_id,
    app.id,
    1,
    repeat('a', 64),
    '{"contract":"feltus.application-state/v1"}'::jsonb,
    repeat('b', 40),
    'ready',
    app.owner_id
FROM public.feltus_applications app
WHERE app.id = '10000000-0000-0000-0000-000000000001';

INSERT INTO public.feltus_builds (
    id,
    organization_id,
    app_id,
    repository_id,
    source_branch,
    commit_sha,
    status,
    build_provider,
    blueprint_id,
    completed_at
)
SELECT
    fixture.id,
    app.organization_id,
    app.id,
    repository.id,
    'main',
    fixture.commit_sha,
    'succeeded',
    'test-fixture',
    blueprint.id,
    now()
FROM public.feltus_applications app
JOIN public.feltus_repositories repository
  ON repository.organization_id = app.organization_id
JOIN public.feltus_application_blueprints blueprint
  ON blueprint.app_id = app.id
CROSS JOIN (VALUES
    ('60000000-0000-0000-0000-000000000001'::uuid, repeat('b', 40)),
    ('60000000-0000-0000-0000-000000000002'::uuid, repeat('e', 40))
) AS fixture(id, commit_sha)
WHERE app.id = '10000000-0000-0000-0000-000000000001';

INSERT INTO public.feltus_artifacts (
    id,
    organization_id,
    app_id,
    build_id,
    registry_image,
    artifact_digest,
    verification_status,
    verified_at,
    blueprint_id
)
SELECT
    fixture.id,
    app.organization_id,
    app.id,
    build.id,
    'feltus-test/control-plane-fixture',
    'sha256:' || repeat(fixture.digest_char, 64),
    fixture.verification_status,
    CASE WHEN fixture.verification_status = 'passed' THEN now() ELSE NULL END,
    blueprint.id
FROM public.feltus_applications app
CROSS JOIN (VALUES
    ('70000000-0000-0000-0000-000000000001'::uuid, 'c', 'passed', '60000000-0000-0000-0000-000000000001'::uuid),
    ('70000000-0000-0000-0000-000000000002'::uuid, 'd', 'revoked', '60000000-0000-0000-0000-000000000002'::uuid)
) AS fixture(id, digest_char, verification_status, build_id)
JOIN public.feltus_builds build
  ON build.app_id = app.id
 AND build.id = fixture.build_id
JOIN public.feltus_application_blueprints blueprint ON blueprint.app_id = app.id
WHERE app.id = '10000000-0000-0000-0000-000000000001';

INSERT INTO public.feltus_deployment_targets (
    id,
    organization_id,
    app_id,
    environment_id,
    provider_key,
    provider_resource_reference,
    created_by
)
SELECT
    '80000000-0000-0000-0000-000000000001',
    app.organization_id,
    app.id,
    environment.id,
    'coolify',
    'synthetic-control-plane-target',
    app.owner_id
FROM public.feltus_applications app
JOIN public.feltus_environments environment
  ON environment.app_id = app.id
 AND environment.kind = 'development'
WHERE app.id = '10000000-0000-0000-0000-000000000001';

COMMIT;
