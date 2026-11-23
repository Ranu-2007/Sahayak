# ResQLink API

Base URL: `https://<api-host>/api` (local: `http://localhost:4000/api`). JSON is used unless an endpoint returns `204 No Content`. Protected calls accept the HttpOnly `resqlink_session` cookie set by login or an `Authorization: Bearer <JWT>` header. Browser clients must send credentials; the API only permits configured `CLIENT_ORIGIN` values.

Authentication and authorization are enforced by the API. Roles are `requester`, `provider`, `coordinator`, and `admin`. Requesters see their own requests; providers see verified provider listings and their own/assigned work; coordinator and admin endpoints can expose broader operational records. Never treat a recommendation as a confirmed assignment before provider acceptance.

## Response and errors

Successful JSON responses use a resource property such as `{ "request": ... }`, collection property such as `{ "requests": [...], "pagination": ... }`, or endpoint-specific summary. Paginated list endpoints accept `page` (default 1) and `limit` (default endpoint-specific, capped at 100) and return `{ "page", "limit", "total", "pages" }`.

Errors use `{ "message": "..." }`; validation errors may also include `details`. Common statuses: `400` invalid input, `401` missing/expired authentication, `403` insufficient permission, `404` missing or intentionally hidden record, `409` conflict, `429` rate limit, `500` unexpected server error, and `503` database health unavailable. Authentication is limited to 10 attempts per 15 minutes per client IP. Sensitive API operations have an additional rate limit.

## Health

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Readiness; 200 if MongoDB is connected, otherwise 503. |

## Authentication and profile

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | Public | Register requester or provider account. Body: `name`, `email`, `password` (10–128 characters), optional `organization`, optional `role` (`requester` or `provider`). |
| POST | `/auth/login` | Public | Body: `email`, `password`; creates HttpOnly session cookie and returns public user. |
| POST | `/auth/logout` | Public/session optional | Revoke current session and clear cookie; returns 204. |
| GET | `/auth/me` | Authenticated | Get current user profile. |
| PATCH | `/auth/me` | Authenticated | Update `name` and/or `organization`. |
| PATCH | `/auth/me/password` | Authenticated | Change password with `currentPassword` and `newPassword`; revokes prior sessions and issues a new session. |

## Requests and coordination workflow

Create requests with `title`, supported `category`, `description`, `requiredService`, `items` (`resource`, positive `quantity`, `unit`), `affectedPeople`, future ISO `responseDeadline`, contact (`name` plus email or phone), location (`label`, `coordinatesAuthorized`, optional `[longitude, latitude]`), optional `requiredSkills`, and `urgency` (`low`, `medium`, `high`, `critical`). Critical requests return an emergency-services safety notice. Immediate danger should be reported to official emergency services.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/requests` | Authenticated | List requests visible to the caller. Supports pagination, `status`, `urgency`, `category` filters. |
| POST | `/requests` | Requester, coordinator, admin | Submit an emergency request. |
| POST | `/requests/:id/evidence` | Request owner, coordinator, admin | Multipart field `photos` (up to 5 JPEG/PNG/WebP images, 5 MB each, or MP4/WebM videos, 10 MB each; 25 MB total per complaint). Returns private evidence metadata; files are available only to the reporter or coordinators. |
| GET | `/requests/:id/evidence/:evidenceId` | Request owner, coordinator, admin | Stream one private evidence image or video. Response uses `Cache-Control: private, no-store`. |
| POST | `/requests/:id/confirmations` | Authenticated user within 2 km | Body: `{ "latitude": 25.43, "longitude": 81.85, "action": "also_affected" }`. Actions: `confirm_issue`, `also_affected`, `issue_not_found`, `problem_resolved`. One response per account per complaint. Returns total and per-action counts plus derived verification status. |
| GET | `/requests/groups` | Authenticated | Rule-based groups for same-category complaints within 500 m. Optional `latitude`, `longitude`, `radiusMeters` (100–50000) filters candidates. Returns sanitized complaint summaries, group counts, duplicate-candidate flags, and verification labels. |
| GET | `/requests/:id` | Owner, assigned provider, coordinator, admin | Read a request. Contact and exact location remain withheld from providers until acceptance. |
| PATCH | `/requests/:id` | Owner or coordinator/admin | Edit permitted request fields. |
| PATCH | `/requests/:id/status` | Coordinator, admin | Update workflow status. |
| POST | `/requests/:id/verify` | Coordinator, admin | Verify submitted request information. |
| POST | `/requests/:id/review` | Coordinator, admin | Record coordinator review. |
| GET | `/requests/:id/matches` | Authenticated with request access | Calculate/view ranked recommendations and explanations. |
| POST | `/requests/:id/matches` | Requester, coordinator, admin | Recalculate recommendations. |
| POST | `/requests/:id/assign` or `/requests/:id/assignments` | Coordinator, admin | Create a coordinator-approved offer and reserve required inventory transactionally. |
| PATCH | `/requests/:id/assignments/:assignmentId/status` | Assigned provider, coordinator, admin | Update assignment progress/status. |
| POST | `/requests/:id/confirm-fulfillment` | Requester, coordinator, admin | Confirm assistance was received after fulfillment. |
| POST | `/requests/:id/feedback` | Request owner after confirmed fulfillment | Submit verified rating/comments. |
| POST | `/requests/:id/resolve-duplicate` | Coordinator, admin | Mark a duplicate request and link its canonical request. |

Critical assignment operations require a transaction-capable MongoDB deployment. An assignment offer is not acceptance; the provider must accept it before it is confirmed.

Complaint creation returns HTTP 201 with a message, the created complaint, `reportedAt`, `category`, and `verificationStatus: "unverified"`. Urgent requests are accepted without waiting for verification. Coordinates are stored only when explicitly authorized. Confirmation responses return HTTP 201 with the submitted `action`, total count, per-action `communityFeedback`, and status. Repeated responses return HTTP 409. Three unique nearby positive responses (`confirm_issue` or `also_affected`) set the community-supported label; negative or resolved feedback never changes official complaint status. Only coordinator verification sets `officially verified`. Confirmation coordinates come from the browser and are not trusted proof.

Evidence files are stored outside the web root in `server/private-evidence` by default. For deployments, set `EVIDENCE_STORAGE_DIR` to a private persistent volume and restrict filesystem access to the API process. The API never exposes evidence files through a public static route. Do not upload media containing personal or identifying details unless necessary and authorized.

## Providers and inventory

Provider profile input includes `name`, `providerType`, `category`, service categories, skills, qualifications, contact method, credentials, inventory, capacity, location, service radius, operating hours, and availability. New profiles start pending verification. Profile and inventory schemas are validated server-side.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/providers` | Authenticated | Paginated provider listing; non-coordinators see verified providers only and less sensitive fields. |
| GET | `/providers/:id` | Authorized user | Provider details, with sensitive fields restricted. |
| GET | `/providers/mine` | Provider | Own profile and calculated operations summary. |
| POST | `/providers` or `/providers/profile` | Provider | Submit provider profile for verification. |
| PATCH | `/providers/mine` | Provider | Update own profile. |
| PATCH | `/providers/:id` | Owner, coordinator, admin | Update provider profile. |
| PATCH | `/providers/:id/availability` | Provider owner, coordinator, admin | Update current availability and its timestamp. |
| PATCH | `/providers/:id/inventory` | Provider owner, coordinator, admin | Update provider inventory. |
| PATCH | `/providers/:id/verification` | Coordinator, admin | Review verification. |
| PATCH | `/providers/:id/suspend` | Admin | Suspend a provider. |
| GET | `/providers/:id/feedback` | Authenticated | Paginated verified feedback. |
| GET | `/providers/mine/assignments` | Provider | Own assignment history. |
| GET | `/providers/mine/feedback` | Provider | Feedback associated with own profile. |
| POST | `/resources` | Provider, coordinator, admin | Add inventory record (provider can only add to own profile). |
| GET | `/resources` | Authenticated | Paginated resource records visible to caller; optional `resourceType`. |
| PATCH | `/resources/:id` | Owner, coordinator, admin | Update an inventory record; ownership checked server-side. |

## Assignment actions, notifications, and feedback

| Method | Path | Access | Purpose |
|---|---|---|---|
| PATCH | `/assignments/:id/accept` | Assigned provider, coordinator, admin | Accept an offered assignment. |
| PATCH | `/assignments/:id/decline` | Assigned provider, coordinator, admin | Decline and release reserved stock as applicable. |
| PATCH | `/assignments/:id/status` | Assigned provider, coordinator, admin | Update assignment status. |
| POST | `/assignments/:id/feedback` | Request owner after verified completion; coordinator/admin | Submit feedback for an assignment. |
| GET | `/notifications` | Authenticated | List the current user's notifications. |
| PATCH | `/notifications/:id/read` | Notification owner | Mark one notification read. |
| POST | `/notifications/read-all` | Authenticated | Mark current user's notifications read. |

## Administration

All coordination routes require the coordinator or admin role unless noted. `/admin` is an alias for the coordinator overview/report routes.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/coordination/summary` or `/admin/overview` | Coordinator, admin | Current request, provider, and available resource summary. |
| GET | `/coordination/overview` | Coordinator, admin | Dashboard summary cards. |
| GET | `/coordination/shortages` | Coordinator, admin | Current demand and reported stock shortage view. |
| GET | `/coordination/reports/resource-utilization` | Coordinator, admin | Resource and assignment utilization report. |
| GET | `/coordination/audit-logs` or `/admin/audit-logs` | Coordinator, admin | Paginated audit log. |
| PATCH | `/coordination/users/:id/role` | Admin | Grant an allowed account role. |

## Example calls

Register:

```sh
curl -i -X POST http://localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Example Coordinator","email":"coord@example.org","password":"replace-this-with-a-long-password","role":"requester"}'
```

Health check:

```sh
curl -i http://localhost:4000/api/health
```

For deployed use, substitute the HTTPS API origin. Keep session cookies and bearer tokens private. Do not place passwords, tokens, contact details, or precise emergency coordinates in logs or public issue reports.
