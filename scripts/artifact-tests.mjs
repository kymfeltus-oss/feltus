import assert from "node:assert/strict";
import {
  artifactImageReference,
  parseArtifactRegistry,
  parseBuildKitDigest
} from "../src/lib/feltus-build-worker.js";

const appId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const buildId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const digest = `sha256:${"1".repeat(64)}`;
assert.equal(parseBuildKitDigest({ "containerimage.digest": digest }), digest);
assert.throws(() => parseBuildKitDigest({ "containerimage.digest": `sha256:${"A".repeat(64)}` }));
assert.throws(() => parseBuildKitDigest({ "containerimage.digest": "latest" }));

const parsed = parseArtifactRegistry("ghcr.io/feltus/apps");
assert.equal(parsed.host, "ghcr.io");
assert.equal(parsed.repositoryPrefix, "feltus/apps");
assert.equal(parseArtifactRegistry("http://ghcr.io/feltus/apps"), null);
assert.equal(parseArtifactRegistry("ghcr.io/feltus/../apps"), null);

const artifact = artifactImageReference("ghcr.io/feltus/apps", appId, buildId);
assert.equal(artifact.image, `ghcr.io/feltus/apps/${appId}:build-${buildId}`);
assert.equal(artifact.repository, `feltus/apps/${appId}`);
assert.throws(() => artifactImageReference("ghcr.io/feltus/apps", "not-an-app", buildId));
console.log("PASS artifact registry references validate and the registry digest is the immutable identity");