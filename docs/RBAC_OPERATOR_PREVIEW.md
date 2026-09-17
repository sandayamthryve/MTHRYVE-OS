# PDF role access in the devchannel

Source: RBAC(1).pdf supplied on 2026-09-09.

The existing operator account can select any of the eight department views using
**View as**. The server stores the selected view in an HttpOnly cookie; reloading,
opening another page, or accessing a URL directly uses the same permission set.
Selecting Operator restores the full operator workspace. Signing out resets the
view to Operator. There are no new accounts, users, department rows, SQL migrations,
credentials, or invitations in this change.

| View | Available modules |
| --- | --- |
| E-Commerce | Campaigns, TikTok Orders, Ad Ops, Operational Records, Clients, E-Commerce Analytics |
| Creatives | Creative Studio, Vesper Studio, Content Calendar, Creatives Analysis |
| Warehouse & Fulfilment | Warehouse Overview, Product Intelligence, Product Master, Stock, RTS, Case Monitoring, Warehouse Analytics |
| Customer Service | Operational Records, Case Monitoring, RTS, Live Ops Analytics |
| Live Host | Live & Video Wall, Live Selling, Live Operations, Live Ops Analytics, Host Attendance |
| Affiliate Manager | Affiliate Campaigns, Creators, Leads, BizDev Outreach, Client Delivery, Affiliate Reach, Affiliate Analytics |
| Finance | Finance, Expenses, Expense Records, Budgets, Expense Audit, Payroll |
| Human Resources | Leaderboard, People, Probation, Daily Logs, Recruitment, Moderation Queue, LMS |

## Existing-route mappings

- Clients is the Commerce `/brands` dashboard.
- Daily Logs is `/attendance`; LMS is `/knowledge`.
- Affiliate Campaigns and Affiliate Reach both lead to the existing `/affiliate`
  workspace. Both PDF labels are retained; this change does not invent a second module.
- Customer Service's combined Case Monitoring & RTS entry is represented by the
  two existing warehouse pages.
- A department workspace lists the permitted modules instead of displaying the
  operator's executive dashboard.
- Parent modules do not implicitly grant all child routes. In particular, Live
  Operations excludes HR Moderation and Contributors; Finance excludes Expense
  Approvals, Vendors, and Categories, which are not listed in the PDF.

## Enforcement and scope

`lib/auth/module-access.ts` is the shared module matrix. Module page entry points
use `requireModule`; server-resolved roles drive the dev navigation and search.
Middleware rejects forbidden preview pages, APIs, and action requests on forbidden
paths before rendering. The session resolver also rechecks the request scope.
Shared analytics reads require an explicitly allowed department. Unknown APIs and
unscoped catalog reads are denied in department previews. The metrics write handler
checks its body department independently from any query string.

The preview endpoint only works when the existing devchannel/mock environment
flag is enabled and an operator demo session already exists. It rejects invalid
roles and cross-origin changes. It is not a new authentication provider: the
existing perimeter gate still authenticates access to this dev build. Ordinary
Supabase sessions cannot use this endpoint to change their roles.

Every department preview keeps the same operator ID and org ID, with an effective
`team_member` application role and the selected department name. It is never a CEO
or department-head impersonation. Existing action-specific approval/write checks
and database RLS remain in place. Module access alone does not grant authority to
approve spending, manage accounts, promote employees, or delete records. Because
no database membership is provisioned, this is not verification of real employee
RLS or live company data; modules may show their existing empty states.

## Verification

- `npm test`: includes the independently transcribed PDF matrix, prohibited sibling
  routes, unknown roles, scoped analytics APIs, operator session identity, endpoint
  authentication/origin validation, and existing privileged-action guards.
- `npx tsc --noEmit`: full repository type check.
- Browser checks: operator sign-in, switching to department views, reload persistence,
  workspace links, forbidden direct URLs, and return to Operator.
