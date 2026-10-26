import dotenv from "dotenv";

dotenv.config();

const gateway = (
  process.env.FELTUS_GATEWAY_URL ||
  ""
).replace(/\/+$/, "");
const serviceRoleKey = process.env.FELTUS_ADMIN_API_KEY || "";
const email = (process.env.FELTUS_OWNER_EMAIL || "").trim().toLowerCase();
const password = process.env.FELTUS_OWNER_PASSWORD || "";

if (!gateway || !serviceRoleKey || !email) {
  process.stderr.write(
    "Owner bootstrap requires FELTUS_GATEWAY_URL, FELTUS_ADMIN_API_KEY, and FELTUS_OWNER_EMAIL.\n"
  );
  process.exit(1);
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  Accept: "application/json"
};

const listResponse = await fetch(
  `${gateway}/auth/v1/admin/users?per_page=1000`,
  { headers, signal: AbortSignal.timeout(15000) }
);

if (!listResponse.ok) {
  process.stderr.write("Could not verify the owner account in local Auth.\n");
  process.exit(1);
}

const listedUsers = await listResponse.json().catch(() => ({}));
const users = Array.isArray(listedUsers.users)
  ? listedUsers.users
  : Array.isArray(listedUsers)
    ? listedUsers
    : [];

if (users.some(user => String(user.email || "").toLowerCase() === email)) {
  process.stdout.write("FELTUS owner account already exists; password unchanged.\n");
  process.exit(0);
}

if (password.length < 12 || password.length > 1024) {
  process.stderr.write(
    "FELTUS_OWNER_PASSWORD must be 12 to 1024 characters when creating the owner.\n"
  );
  process.exit(1);
}

const createResponse = await fetch(`${gateway}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    ...headers,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    user_metadata: { feltus_role: "owner" }
  }),
  signal: AbortSignal.timeout(15000)
});

if (!createResponse.ok) {
  process.stderr.write("FELTUS owner account creation failed.\n");
  process.exit(1);
}

process.stdout.write("FELTUS owner account created.\n");
