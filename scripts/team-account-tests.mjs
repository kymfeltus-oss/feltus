import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canCreateApp,
  canDeleteWorkspace,
  canDeployProduction,
  canDeployStaging,
  canEditResource,
  canManageBilling,
  canManagePeople,
  canTransferOwnership,
  canViewResource
} from "../src/lib/feltus-authorization.js";
import { createTeamApiHandler } from "../src/lib/feltus-team-api.js";

const teamMigration = readFileSync(new URL("../supabase/migrations/20261106030000_feltus_team_accounts.sql", import.meta.url), "utf8");
const controlPlaneMigration = readFileSync(new URL("../supabase/migrations/20261102020000_feltus_deployment_control_plane.sql", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/app-wizard/app.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const infrastructureSource = readFileSync(new URL("../src/lib/feltus-infrastructure-worker.js", import.meta.url), "utf8");

const owner = { workspaceRole: "owner", status: "active" };
const admin = { workspaceRole: "admin", status: "active" };
const member = { workspaceRole: "member", projectRole: "developer", status: "active" };
const operator = { workspaceRole: "member", projectRole: "operator", status: "active" };
const viewer = { workspaceRole: "viewer", projectRole: "viewer", status: "active" };

assert.equal(canManagePeople(owner), true);
assert.equal(canManageBilling(owner), true);
assert.equal(canTransferOwnership(owner), true);
assert.equal(canDeleteWorkspace(owner), true);
assert.equal(canCreateApp(owner), true);
assert.equal(canDeployProduction(owner), true);

assert.equal(canManagePeople(admin), true);
assert.equal(canManageBilling(admin), false);
assert.equal(canTransferOwnership(admin), false);
assert.equal(canDeleteWorkspace(admin), false);
assert.equal(canCreateApp(admin), true);
assert.equal(canDeployProduction(admin), true);

assert.equal(canManagePeople(member), false);
assert.equal(canViewResource(member), true);
assert.equal(canEditResource(member), true);
assert.equal(canDeployStaging(member), false);
assert.equal(canDeployStaging(operator), true);
assert.equal(canDeployProduction(operator), false);

assert.equal(canViewResource(viewer), true);
assert.equal(canEditResource(viewer), false);
assert.equal(canDeployStaging(viewer), false);
assert.equal(canViewResource({ ...viewer, status: "suspended" }), false);
console.log("PASS centralized owner, admin, member, and viewer capabilities");

assert.match(controlPlaneMigration, /UNIQUE \(organization_id, user_id\)/);
assert.match(controlPlaneMigration, /feltus_ensure_personal_organization/);
assert.match(controlPlaneMigration, /SET organization_id = org\.id/);
assert.match(controlPlaneMigration, /app\.owner_id = p_user_id/);
assert.match(teamMigration, /FOR v_user_id IN SELECT id FROM auth\.users/);
assert.match(teamMigration, /CREATE TRIGGER feltus_auth_user_default_workspace[\s\S]*AFTER INSERT ON auth\.users/);
assert.match(teamMigration, /feltus_applications_workspace_read[\s\S]*feltus_can_view_resource\(id\)/);
assert.match(teamMigration, /feltus_user_has_workspace_permission[\s\S]*membership\.organization_id = p_organization_id/);
assert.match(teamMigration, /feltus_workspace_invitations_active_email_uq[\s\S]*accepted_at IS NULL AND revoked_at IS NULL/);
console.log("PASS default workspace migration, unique membership, existing owner access, and tenant-scoped RLS");

assert.match(teamMigration, /WHERE token_hash = p_token_hash[\s\S]*accepted_at IS NULL[\s\S]*revoked_at IS NULL[\s\S]*FOR UPDATE/);
assert.match(teamMigration, /v_invitation\.expires_at <= now\(\)/);
assert.match(teamMigration, /SET accepted_at = now\(\), accepted_by_user_id = v_user/);
assert.match(teamMigration, /SET revoked_at = now\(\), updated_at = now\(\)/);
assert.match(controlPlaneMigration, /feltus_protect_org_owner/);
assert.match(teamMigration, /Owner changes require the ownership-transfer workflow/);
assert.match(teamMigration, /target_role\.role_key IN \('org_admin', 'org_member', 'org_viewer'\)/);
assert.match(teamMigration, /ownership\.transferred/);
assert.match(teamMigration, /member\.invited/);
assert.match(teamMigration, /invitation\.accepted/);
assert.match(teamMigration, /invitation\.revoked/);
assert.match(teamMigration, /member\.role_changed/);
assert.match(teamMigration, /member\.removed/);
console.log("PASS invitation lifecycle, sole-owner protection, escalation prevention, and team audit events");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const calls = [];
let rpcFailure = null;

const handler = createTeamApiHandler({
  enabled: true,
  getUser: () => ({ id: USER_ID, email: "owner@example.com" }),
  readBody: async request => request.body || {},
  randomBytes: () => Buffer.alloc(32, 7),
  now: () => Date.parse("2026-11-06T12:00:00.000Z"),
  tableRequest: async (table, method, options = {}) => {
    calls.push({ table, method, options });
    if (rpcFailure) return rpcFailure;
    if (table === "rpc/feltus_create_workspace_invitation") {
      return { status: 200, data: { id: INVITATION_ID, workspace_id: WORKSPACE_ID, email: options.body.p_email, role: "member" } };
    }
    if (table === "rpc/feltus_accept_workspace_invitation") {
      return { status: 200, data: { workspace_id: WORKSPACE_ID, user_id: USER_ID, status: "active" } };
    }
    if (table === "rpc/feltus_revoke_workspace_invitation") {
      return { status: 200, data: { id: INVITATION_ID, revoked_at: "2026-11-06T12:05:00.000Z" } };
    }
    return { status: 200, data: {} };
  }
});

async function invoke(pathname, method = "GET", body = null) {
  const response = { status: null, headers: null, body: null };
  const res = {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(value) { response.body = value ? JSON.parse(value) : null; }
  };
  const handled = await handler({ method, body }, res, new URL("https://feltus.test" + pathname));
  assert.equal(handled, true);
  return response;
}

const created = await invoke(`/api/workspaces/${WORKSPACE_ID}/invitations`, "POST", {
  email: "Member@Example.com",
  role: "member",
  expires_in_days: 7
});
assert.equal(created.status, 201);
assert.match(created.body.acceptance_token, /^[A-Za-z0-9_-]{40,100}$/);
const createCall = calls.at(-1);
assert.equal(createCall.table, "rpc/feltus_create_workspace_invitation");
assert.equal(createCall.options.body.p_email, "member@example.com");
assert.match(createCall.options.body.p_token_hash, /^[0-9a-f]{64}$/);
assert.equal(JSON.stringify(createCall.options.body).includes(created.body.acceptance_token), false, "plaintext invitation token must not be stored");

const accepted = await invoke("/api/workspaces/invitations/accept", "POST", { token: created.body.acceptance_token });
assert.equal(accepted.status, 200);
assert.equal(calls.at(-1).table, "rpc/feltus_accept_workspace_invitation");
assert.equal(calls.at(-1).options.body.p_token_hash, createCall.options.body.p_token_hash);

const revoked = await invoke(`/api/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}/revoke`, "POST");
assert.equal(revoked.status, 200);
assert.equal(calls.at(-1).table, "rpc/feltus_revoke_workspace_invitation");
console.log("PASS invitation API hashes tokens and supports acceptance and revocation");

rpcFailure = { status: 403, data: { code: "42501", message: "denied" } };
const denied = await invoke(`/api/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/invitations`, "POST", {
  email: "outsider@example.com",
  role: "viewer"
});
assert.equal(denied.status, 403);
assert.match(denied.body.error, /permission/i);
console.log("PASS cross-workspace team mutation fails closed");

assert.match(appSource, /key !== "team" \|\| state\.features\.teams === true/);
assert.match(appSource, /route\.page === "team" && state\.features\.teams !== true/);
assert.doesNotMatch(appSource, /fake team|sample member|demo member/i);
const disabledHandler = createTeamApiHandler({
  enabled: false,
  getUser: () => ({ id: USER_ID }),
  readBody: async () => ({}),
  tableRequest: async () => { throw new Error("disabled team API must not query the database"); }
});
const disabledResponse = { status: null, body: null };
await disabledHandler({ method: "GET" }, {
  writeHead(status) { disabledResponse.status = status; },
  end(value) { disabledResponse.body = JSON.parse(value); }
}, new URL("https://feltus.test/api/workspaces"));
assert.equal(disabledResponse.status, 404);
assert.match(disabledResponse.body.error, /not available/i);
console.log("PASS People navigation and route stay hidden while team access is disabled");

const sessionGate = serverSource.match(/async function authenticatedUserCanStartSession\([\s\S]*?\n\}/)?.[0] || "";
assert.match(sessionGate, /if \(email === OWNER_EMAIL\) return true;\s*if \(!TEAMS_ENABLED\) return false;/,
  "when teams are disabled, the configured owner can sign in and other users cannot fall through to organization membership");
console.log("PASS FELTUS_TEAMS_ENABLED retains the owner-only sign-in fallback");

assert.match(infrastructureSource, /docker_registry_image_name/);
console.log("PASS Phase 3 infrastructure implementation remains present and outside the team foundation");
