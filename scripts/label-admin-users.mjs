/**
 * Label existing admin users with the Appwrite Auth `admin` label.
 *
 * Why: the `popups` and `trivia` tables are being locked down to `label:admin`
 * permissions instead of any authenticated user. Appwrite permissions can only be
 * granted to auth principals (users, teams, labels) — never to a database attribute —
 * so `user_profiles.role === 'admin'` (a document field checked client-side at login)
 * has to be mirrored onto each admin's actual Appwrite Auth user as a label. Run this
 * BEFORE pushing the tightened table permissions, or admins will lose access to
 * popups/trivia in the gap.
 *
 * Idempotent: existing labels are preserved (never overwritten), and users who already
 * have the label are skipped. Safe to re-run any time a new admin is created.
 *
 * Requires a server API key with:
 *   - users.read, users.write     (to read + update Appwrite Auth user labels)
 *   - rows.read on user_profiles  (to find rows where role === 'admin')
 *
 * Usage (from samplefinder-admin):
 *   APPWRITE_API_KEY=... node scripts/label-admin-users.mjs --dry-run
 *   APPWRITE_API_KEY=... node scripts/label-admin-users.mjs
 *
 * Loads VITE_* vars from .env when present (same as the Vite admin app).
 */
import { Client, TablesDB, Users, Query } from 'node-appwrite';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = join(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnv();

const endpoint = process.env.VITE_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT;
const projectId = process.env.VITE_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID || '69217af50038b9005a61';
const userProfilesTable = process.env.VITE_APPWRITE_COLLECTION_USER_PROFILES || 'user_profiles';
const ADMIN_LABEL = 'admin';

const DRY_RUN = process.argv.includes('--dry-run');

if (!endpoint || !projectId || !apiKey) {
  console.error(
    'Set VITE_APPWRITE_ENDPOINT, VITE_APPWRITE_PROJECT_ID, and APPWRITE_API_KEY (optionally in .env).'
  );
  process.exit(1);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tablesDB = new TablesDB(client);
const users = new Users(client);

async function findAdminAuthIds() {
  const adminAuthIds = new Set();
  let offset = 0;
  const page = 100;

  for (;;) {
    const res = await tablesDB.listRows({
      databaseId,
      tableId: userProfilesTable,
      queries: [Query.equal('role', 'admin'), Query.limit(page), Query.offset(offset)],
    });
    const rows = res.rows || [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const authID = typeof row.authID === 'string' ? row.authID.trim() : '';
      if (!authID) {
        console.warn(`Skipping user_profiles row ${row.$id}: missing authID.`);
        continue;
      }
      adminAuthIds.add(authID);
    }

    if (rows.length < page) break;
    offset += page;
  }

  return adminAuthIds;
}

async function main() {
  const adminAuthIds = await findAdminAuthIds();
  console.log(`Found ${adminAuthIds.size} admin user_profiles row(s) with a valid authID.`);

  let labeled = 0;
  let alreadyLabeled = 0;
  let errors = 0;

  for (const authID of adminAuthIds) {
    try {
      const user = await users.get({ userId: authID });
      const existingLabels = user.labels || [];

      if (existingLabels.includes(ADMIN_LABEL)) {
        alreadyLabeled++;
        console.log(`[skip] ${authID} already has the '${ADMIN_LABEL}' label.`);
        continue;
      }

      const nextLabels = [...new Set([...existingLabels, ADMIN_LABEL])];

      if (DRY_RUN) {
        console.log(
          `[dry-run] ${authID}: labels ${JSON.stringify(existingLabels)} -> ${JSON.stringify(nextLabels)}`
        );
        labeled++;
        continue;
      }

      await users.updateLabels({ userId: authID, labels: nextLabels });
      console.log(`Labeled ${authID}: ${JSON.stringify(nextLabels)}`);
      labeled++;
    } catch (e) {
      errors++;
      console.error(`Failed to label ${authID}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Admins found:     ${adminAuthIds.size}`);
  console.log(`  ${DRY_RUN ? 'Would be labeled' : 'Labeled'}: ${labeled}`);
  console.log(`  Already labeled:  ${alreadyLabeled}`);
  console.log(`  Errors:           ${errors}`);
  if (DRY_RUN) {
    console.log('');
    console.log('Dry run only — no labels were written. Re-run without --dry-run to apply.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
