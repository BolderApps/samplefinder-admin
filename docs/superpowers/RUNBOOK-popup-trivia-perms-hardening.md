# Runbook: Scope `popups` / `trivia` permissions to admins only

## Why

Today the `popups` and `trivia` Appwrite tables grant `create`/`read`/`update`/`delete`
to `role:"users"` — i.e. **any authenticated mobile user**, not just admins. Because
`rowSecurity` is `false` on both tables, that's a blanket grant with no per-row check.
Any signed-in user can call the Appwrite SDK directly (bypassing the app UI) and:

- create bogus popups/trivia,
- edit a **live** popup's `link` to a phishing URL,
- delete popups/trivia outright.

This change scopes those four permissions to `label:admin` instead, so only Appwrite
Auth users carrying the `admin` label can write (or read) those two tables. Everything
else — `popup_interactions`, `trivia_responses`, and all other tables — is unchanged.

This is safe for both apps:
- **Mobile app** never touches `trivia`/`popups` collections directly. It only calls
  the Mobile API Appwrite Function, which authenticates with a server API key
  (`.setKey(...)`) that bypasses collection permissions entirely.
- **Admin dashboard** reads/writes these tables using the logged-in admin's session,
  so it needs the admin's Appwrite Auth user to carry the `admin` label.

## Critical ordering

Admin-ness today only exists as `user_profiles.role === 'admin'`, a **document
attribute** — there is no Appwrite label or team backing it yet. Appwrite permissions
can only reference auth principals (users/teams/labels), never a database attribute.
So existing admins must be labeled **before** the tightened permissions go live, or
they will be locked out of `popups`/`trivia` in the gap between the two steps.

1. **Dry-run, then run, the labeler** (from `samplefinder-admin/`):
   ```bash
   APPWRITE_API_KEY=... npm run label:admin-users -- --dry-run
   APPWRITE_API_KEY=... npm run label:admin-users
   ```
   The API key needs `users.read`, `users.write`, and `rows.read` (on `user_profiles`).
   The script is idempotent — safe to re-run at any time, including later when new
   admins are added.

2. **Have admins log out and back in.** Belt-and-suspenders in case anything caches
   role/session state client-side. Not strictly required by Appwrite (labels apply to
   the auth user, checked per-request), but cheap insurance.

3. **Push the tightened permissions** (from `samplefinder-admin/appwrite/`):
   ```bash
   appwrite push tables --table-id popups --table-id trivia
   ```
   `trivia` is optional/separable from this change — if you want to defer it, push
   `--table-id popups` only and repeat step 3 for `trivia` later.

4. **Verify**, logged in as an admin in the dashboard:
   - Create, edit, and delete a popup.
   - Create, edit, and delete a trivia question.
   - Confirm the popups and trivia list pages still load (read access).

   If any write is denied (`401`/`403` from Appwrite), that admin's Auth user isn't
   labeled yet — re-run the labeler (step 1) or have them log out/in again, then retry.

## Rollback

Set both tables' `$permissions` back to the original grant and re-push:

```json
[
  "create(\"users\")",
  "read(\"users\")",
  "update(\"users\")",
  "delete(\"users\")"
]
```

```bash
appwrite push tables --table-id popups --table-id trivia
```

No data is affected by either direction of this change — it's permissions-only.
Labels already applied to admins are harmless to leave in place after a rollback.

## Ongoing operational change

**Creating a new admin now requires assigning the `admin` label — this doesn't happen
automatically.** The client-side admin-create flow (`register()` in `src/stores/authStore.ts`)
sets `role: 'admin'` on the new `user_profiles` row, but it **cannot** set the Appwrite
Auth label from the browser — there is no server API key in the client, by design (see
workspace CLAUDE.md: "Never put server Appwrite API keys in the mobile client"; the same
applies to any client-side code path in the admin app).

After creating a new admin, do one of:
- Re-run `npm run label:admin-users` (idempotent — only touches unlabeled admins), or
- Add the `admin` label to that user manually in the Appwrite console
  (Auth → user → Labels).

Until one of those happens, the new admin will be able to log into the dashboard (login
only checks `user_profiles.role`) but will get permission errors on any popups/trivia
read or write.
