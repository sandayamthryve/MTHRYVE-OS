# Multi-Factor Authentication (TOTP)

Two-factor authentication for Mthryve OS. Users enroll a TOTP authenticator
(Google Authenticator, 1Password, Authy, …); leadership can **enforce** it at
login for privileged roles — **without ever locking anyone out**.

Built on Supabase Auth's managed MFA (`auth.mfa_factors`), so there is **no app
migration** — factors live in Supabase's own schema.

---

## The safety contract (why this can't lock you out)

1. **Enforcement is OFF by default.** Nothing about login changes until
   `MFA_ENFORCEMENT_ENABLED=true` is set. Enrolling a factor while the flag is
   off is a pure no-op for login — it only takes effect once the switch flips.
2. **A required user with no factor is never dead-ended.** When enforcement is on
   and someone whose role requires MFA has no authenticator yet, the login gate
   routes them to **enrollment** (Settings → Security), not to a wall.
3. **The challenge page always offers "Sign out instead."** A user who can't
   produce a code can still leave cleanly.
4. **Fail-open.** If the assurance level can't be read (a transient Supabase
   blip), the gate lets the request through rather than locking the org out. Row
   Level Security still protects the data underneath.
5. **Existing session / logout are untouched.** The gate only adds a redirect for
   under-assured sessions; it never weakens `signOut()` or the cookie handling.

---

## Who is required (when enforcement is on)

| Role              | MFA at login |
| ----------------- | ------------ |
| `ceo`             | Required     |
| `coo`             | Required     |
| `department_head` | Required     |
| `team_member`     | Optional     |

Required roles live in `MFA_REQUIRED_ROLES` (`lib/auth/mfa.ts`). Anyone —
including team members — who enrolls a factor **will** be challenged at login
once enforcement is on; enrolling is opt-in, being challenged for what you
enrolled is not.

---

## How it works

- **Enrollment** — `Settings → Security`. `supabase.auth.mfa.enroll()` returns a
  QR code + manual secret; the user scans it and verifies a 6-digit code. On
  success the factor is verified **and** the session steps up to `aal2`, so a
  user who just enrolled is immediately compliant.
- **Login enforcement** — after password sign-in the session is `aal1`. The
  middleware (`middleware.ts` → `evaluateMfaGate`) checks the assurance level:
  - Has a verified factor but still `aal1` → routed to `/login/mfa` to enter a
    code (steps up to `aal2`).
  - No factor but role requires MFA → routed to enrollment (grace).
  - `aal2`, or a team member with no factor → allowed through.
- **Removal** — requires **re-auth**: the user enters a current code (stepping up
  to `aal2`) before the factor is unenrolled.
- **Audit** — every enroll / challenge-pass / unenroll is recorded on the
  privileged `audit_log` trail (migration `20260720000000`, "reuse #190") via
  `/api/auth/mfa/audit`, which stamps identity from the verified session — never
  the client. Actions: `mfa_enrolled`, `mfa_challenge_passed`, `mfa_unenrolled`.

---

## Turning enforcement ON (do this deliberately)

**Prereq — one-time:** in Supabase → **Authentication → MFA**, enable the **TOTP**
factor. (Without this, `enroll()` fails.)

1. **Enroll + test on a THROWAWAY account first.** Create a test user, enroll an
   authenticator, and confirm: logout → login now demands the code; a required
   user with no factor is guided to enroll (not locked); "Sign out instead"
   works.
2. **Make sure at least one CEO/COO has enrolled** before flipping the switch, so
   leadership isn't the one bounced to enrollment.
3. Set `MFA_ENFORCEMENT_ENABLED=true` (Vercel → Project → Settings → Environment
   Variables). It's read per request, so it takes effect on the next request —
   **no redeploy required**. Setting it back to blank (or `false`) disables
   enforcement just as fast.

---

## Break-glass — reset a locked-out user

A user who lost their phone / authenticator can't produce a code. An admin resets
their factor from Supabase; the user then re-enrolls a fresh one.

**Via the Supabase dashboard:**

1. **Authentication → Users** → open the affected user.
2. Find their **MFA factors** and **remove / delete** the TOTP factor.
3. Tell the user to log in (password only now) and re-enroll at
   `Settings → Security`. If their role requires MFA and enforcement is on,
   they'll be guided straight to enrollment on next login.

**Via SQL (service role), if the dashboard control isn't handy:**

```sql
-- Find the user's factors:
select id, user_id, factor_type, status, friendly_name
from auth.mfa_factors
where user_id = '<AUTH_USER_UUID>';

-- Remove the factor (forces re-enrollment):
delete from auth.mfa_factors where id = '<FACTOR_ID>';
```

> Deleting from `auth.mfa_factors` requires the service role / DB owner. Record
> the reset in the audit trail out-of-band (who reset whom, and why) — the app
> can't stamp an admin's dashboard action automatically.

**Emergency org-wide off switch:** if enforcement is causing broad problems, set
`MFA_ENFORCEMENT_ENABLED` back to blank. Login gating stops on the next request;
enrolled factors are preserved and simply stop being required.
