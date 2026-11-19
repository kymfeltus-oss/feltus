import crypto from "node:crypto";
import { normalizeWorkspaceRole, workspaceCapabilities } from "./feltus-authorization.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITABLE_ROLES = new Set(["admin", "member", "viewer"]);

function rows(result) {
  if (Array.isArray(result?.data)) return result.data;
  return result?.data ? [result.data] : [];
}

function first(result) {
  return rows(result)[0] || null;
}

function respond(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

function errorFromResult(result, fallback) {
  const code = result?.data?.code || result?.data?.error?.code || "";
  const message = result?.data?.message || result?.data?.error?.message || result?.data?.error || fallback;
  if (result?.status === 401) return Object.assign(new Error("Please sign in."), { status: 401 });
  if (result?.status === 403 || code === "42501") return Object.assign(new Error("You do not have permission to manage this workspace."), { status: 403 });
  if (code === "23505" || result?.status === 409) return Object.assign(new Error("An active invitation already exists for this email."), { status: 409 });
  if (["22023", "23514"].includes(code) || result?.status === 400) return Object.assign(new Error(message), { status: 400 });
  return Object.assign(new Error(fallback), { status: 502 });
}

function successful(result, fallback) {
  if (!result || result.status < 200 || result.status >= 300) throw errorFromResult(result, fallback);
  return result;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
  }
  return email;
}

function normalizeInviteRole(value) {
  const role = normalizeWorkspaceRole(value);
  if (!INVITABLE_ROLES.has(role)) {
    throw Object.assign(new Error("Choose Admin, Member, or Viewer."), { status: 400 });
  }
  return role;
}

function normalizeExpiryDays(value) {
  const days = value == null ? 7 : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw Object.assign(new Error("Invitation expiry must be between 1 and 30 days."), { status: 400 });
  }
  return days;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function loadWorkspaceList(tableRequest, userId) {
  const memberships = rows(successful(await tableRequest("feltus_organization_memberships", "GET", {
    query: "?" + new URLSearchParams({
      select: "organization_id,role_id,status,joined_at,created_at",
      user_id: "eq." + userId,
      status: "eq.active",
      order: "created_at.asc"
    })
  }), "Workspaces could not be loaded."));
  if (!memberships.length) return [];

  const organizationIds = unique(memberships.map(item => item.organization_id));
  const roleIds = unique(memberships.map(item => item.role_id));
  const [organizationsResult, rolesResult] = await Promise.all([
    tableRequest("feltus_organizations", "GET", {
      query: "?" + new URLSearchParams({
        select: "id,name,slug,personal_owner_id,created_at,updated_at",
        id: `in.(${organizationIds.join(",")})`,
        archived_at: "is.null"
      })
    }),
    tableRequest("feltus_roles", "GET", {
      query: "?" + new URLSearchParams({ select: "id,role_key,display_name", id: `in.(${roleIds.join(",")})` })
    })
  ]);
  const organizations = new Map(rows(successful(organizationsResult, "Workspaces could not be loaded.")).map(item => [item.id, item]));
  const roles = new Map(rows(successful(rolesResult, "Workspace roles could not be loaded.")).map(item => [item.id, item]));
  return memberships.flatMap(membership => {
    const workspace = organizations.get(membership.organization_id);
    const role = roles.get(membership.role_id);
    if (!workspace || !role) return [];
    const normalizedRole = normalizeWorkspaceRole(role.role_key);
    return [{
      ...workspace,
      membership: {
        role: normalizedRole,
        status: membership.status,
        joined_at: membership.joined_at
      },
      capabilities: workspaceCapabilities({ workspaceRole: normalizedRole, status: membership.status })
    }];
  });
}

export function createTeamApiHandler({
  tableRequest,
  readBody,
  getUser,
  enabled = false,
  randomBytes = crypto.randomBytes,
  now = () => Date.now()
} = {}) {
  if (typeof tableRequest !== "function" || typeof readBody !== "function" || typeof getUser !== "function") {
    throw new TypeError("Team API requires tableRequest, readBody, and getUser.");
  }

  return async function handleTeamApi(req, res, url) {
    const pathname = url.pathname;
    const workspaceCollection = pathname === "/api/workspaces";
    const acceptInvitation = pathname === "/api/workspaces/invitations/accept";
    const peopleMatch = /^\/api\/workspaces\/([0-9a-f-]{36})\/people$/i.exec(pathname);
    const invitationCollectionMatch = /^\/api\/workspaces\/([0-9a-f-]{36})\/invitations$/i.exec(pathname);
    const invitationRevokeMatch = /^\/api\/workspaces\/([0-9a-f-]{36})\/invitations\/([0-9a-f-]{36})\/revoke$/i.exec(pathname);
    const memberMatch = /^\/api\/workspaces\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i.exec(pathname);
    const transferMatch = /^\/api\/workspaces\/([0-9a-f-]{36})\/ownership-transfer$/i.exec(pathname);
    if (!workspaceCollection && !acceptInvitation && !peopleMatch && !invitationCollectionMatch && !invitationRevokeMatch && !memberMatch && !transferMatch) return false;
    if (!enabled) {
      respond(res, 404, { error: "People management is not available yet." });
      return true;
    }

    const user = getUser();
    if (!user?.id) {
      respond(res, 401, { error: "Please sign in." });
      return true;
    }

    const method = String(req.method || "GET").toUpperCase();
    try {
      if (workspaceCollection && method === "GET") {
        respond(res, 200, { workspaces: await loadWorkspaceList(tableRequest, user.id) });
        return true;
      }

      if (peopleMatch && method === "GET") {
        const workspaceId = peopleMatch[1];
        const [membersResult, invitationsResult, rolesResult] = await Promise.all([
          tableRequest("feltus_organization_memberships", "GET", {
            query: "?" + new URLSearchParams({
              select: "id,user_id,role_id,status,joined_at,created_at,updated_at",
              organization_id: "eq." + workspaceId,
              order: "created_at.asc"
            })
          }),
          tableRequest("feltus_workspace_invitations", "GET", {
            query: "?" + new URLSearchParams({
              select: "id,email,role_id,expires_at,accepted_at,revoked_at,created_at",
              organization_id: "eq." + workspaceId,
              order: "created_at.desc"
            })
          }),
          tableRequest("feltus_roles", "GET", {
            query: "?" + new URLSearchParams({ select: "id,role_key,display_name", scope_key: "eq.organization" })
          })
        ]);
        const roles = new Map(rows(successful(rolesResult, "Workspace roles could not be loaded.")).map(role => [role.id, role]));
        const members = rows(successful(membersResult, "Workspace members could not be loaded.")).map(member => ({
          ...member,
          role: normalizeWorkspaceRole(roles.get(member.role_id)?.role_key)
        }));
        const invitations = rows(successful(invitationsResult, "Workspace invitations could not be loaded.")).map(invitation => ({
          ...invitation,
          role: normalizeWorkspaceRole(roles.get(invitation.role_id)?.role_key),
          role_id: undefined
        }));
        respond(res, 200, { members, invitations });
        return true;
      }

      if (invitationCollectionMatch && method === "POST") {
        const workspaceId = invitationCollectionMatch[1];
        const body = await readBody(req, 8192);
        const email = normalizeEmail(body.email);
        const role = normalizeInviteRole(body.role);
        const expiryDays = normalizeExpiryDays(body.expires_in_days);
        const token = randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const result = successful(await tableRequest("rpc/feltus_create_workspace_invitation", "POST", {
          body: {
            p_organization_id: workspaceId,
            p_email: email,
            p_role_key: "org_" + role,
            p_token_hash: tokenHash,
            p_expires_at: new Date(now() + expiryDays * 86400000).toISOString()
          }
        }), "The invitation could not be created.");
        respond(res, 201, { invitation: first(result), acceptance_token: token });
        return true;
      }

      if (acceptInvitation && method === "POST") {
        const body = await readBody(req, 8192);
        const token = String(body.token || "").trim();
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw Object.assign(new Error("This invitation link is invalid."), { status: 400 });
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const result = successful(await tableRequest("rpc/feltus_accept_workspace_invitation", "POST", {
          body: { p_token_hash: tokenHash }
        }), "The invitation could not be accepted.");
        respond(res, 200, { membership: first(result) });
        return true;
      }

      if (invitationRevokeMatch && method === "POST") {
        const result = successful(await tableRequest("rpc/feltus_revoke_workspace_invitation", "POST", {
          body: { p_organization_id: invitationRevokeMatch[1], p_invitation_id: invitationRevokeMatch[2] }
        }), "The invitation could not be revoked.");
        respond(res, 200, { invitation: first(result) });
        return true;
      }

      if (memberMatch && method === "PATCH") {
        const body = await readBody(req, 8192);
        const role = normalizeInviteRole(body.role);
        const result = successful(await tableRequest("rpc/feltus_set_workspace_member_role", "POST", {
          body: { p_organization_id: memberMatch[1], p_user_id: memberMatch[2], p_role_key: "org_" + role }
        }), "The member role could not be changed.");
        respond(res, 200, { membership: first(result) });
        return true;
      }

      if (memberMatch && method === "DELETE") {
        successful(await tableRequest("rpc/feltus_remove_workspace_member", "POST", {
          body: { p_organization_id: memberMatch[1], p_user_id: memberMatch[2] }
        }), "The member could not be removed.");
        respond(res, 200, { removed: true });
        return true;
      }

      if (transferMatch && method === "POST") {
        const body = await readBody(req, 8192);
        if (!UUID.test(String(body.user_id || ""))) throw Object.assign(new Error("Choose a valid workspace member."), { status: 400 });
        const result = successful(await tableRequest("rpc/feltus_transfer_workspace_ownership", "POST", {
          body: { p_organization_id: transferMatch[1], p_new_owner_user_id: body.user_id }
        }), "Workspace ownership could not be transferred.");
        respond(res, 200, { workspace: first(result) });
        return true;
      }

      respond(res, 405, { error: "Method not allowed." });
      return true;
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      respond(res, status, { error: status < 500 ? error.message : "The workspace service is temporarily unavailable." });
      return true;
    }
  };
}
