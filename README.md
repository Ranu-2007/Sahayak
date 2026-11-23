# Sahayak

**Every Request. The Right Response.**

Sahayak is an emergency resource coordination application with a React/Vite client and an Express/MongoDB API. It supports registered requests, provider profiles and inventory, coordinator-reviewed provider matching, assignment acceptance, fulfillment confirmation, and verified feedback. It supplements official emergency services; it does not dispatch emergency services. For immediate life-threatening danger, contact the appropriate official emergency service.

## Project status and data

The API stores registered accounts and operational records in MongoDB. The dashboard includes clearly illustrative sample content to demonstrate the interface; that content is not live emergency information and does not represent actual provider availability. Do not make operational decisions from sample content. For a real deployment, use registered API records and configure the application for your coordinating organization.

## Sahayak Live — Real-Time Disaster & Incident Intelligence

Sahayak Live classifies emergency reports by incident type, groups likely reports about the same event by type, time, location, and text similarity, and publishes incident changes to authorized resolver dashboards over Socket.IO. It provides live incident detection, incident aggregation, and dynamic situation updates. Resolver clients authenticate with the existing HttpOnly session cookie; only coordinator and administrator sessions can join the live incident room. HTTP refresh remains a fallback when a socket cannot connect. Affected-person totals use the highest individual report estimate because reports may overlap, and incident priority remains advisory for human responders. The Socket.IO default in-memory adapter broadcasts within one API process; multi-instance deployments need a shared Socket.IO adapter for cross-instance delivery.

Clustering also checks assistance category, affected-area type, description similarity, and report time. Configure the bounded candidate radius and time window with `INCIDENT_CLUSTER_RADIUS_METERS` (default 1000) and `INCIDENT_CLUSTER_WINDOW_HOURS` (default 72). Coordinators and administrators can open an incident to inspect its individual complaints, authorized report locations, private evidence, community confirmation counts, assignments, resolver notes, and audit timeline. Every complaint remains a separate database record linked to its incident.

Incident aggregates are recalculated when linked complaints, confirmations, evidence, verification, assignments, priority overrides, or statuses change. Affected population is stored as the maximum estimate among non-duplicate reports because individual reports may describe the same people; it is not the complaint count or a sum. Resolvers can resolve or reopen incidents; resolved incidents are excluded from automatic matching. Administrators can correct complaint-to-incident links with a required reason, recorded in the incident audit history.

## Offline reporting and responder directory

The installed web app can save an emergency report and selected evidence in browser IndexedDB while offline. The app marks it as saved locally and does not claim it has reached responders. When the app is open, online, and the user is signed in, it synchronizes queued reports; reopening the app also retries. The API uses a per-user report ID and per-file IDs to make retries idempotent. The server receipt time remains authoritative for priority; the device-reported time is retained as informational metadata. The local queue puts immediate danger and urgency first as a transfer-order aid only, and never replaces backend priority calculation.

While online, signed-in users can cache a limited directory of verified responder organizations and their services and operating areas. It omits contact details and is labeled with its download time because availability can change. Browser storage is not encrypted by this application; its protection depends on the device and browser. On shared devices, remove delivered local copies when they are no longer needed.

Offline delivery is not guaranteed while the browser is closed: background synchronization is not implemented, so the app must be opened again with connectivity. Browser-based device-to-device Bluetooth/Wi-Fi Direct relaying is also not implemented and cannot be relied on across browsers or devices. The cached directory is informational, not an emergency dispatch channel. Use official emergency services whenever a communication route is available.

## Requirements

- Node.js 20 or newer and npm.
- MongoDB 7+ or MongoDB Atlas. Assignment stock reservations use MongoDB transactions, so use a replica set; Atlas clusters provide this.

## Local development

1. Install workspace dependencies from the repository root: `npm install`.
2. Copy `server/.env.example` to `server/.env`. Set `MONGODB_URI` and make `JWT_SECRET` a unique random string with at least 32 characters.
3. Optionally copy `client/.env.example` to `client/.env`; the default API URL is `http://localhost:4000/api`.
4. Start MongoDB, then run `npm run dev` from the repository root.
5. Open `http://localhost:5173`. The API is at `http://localhost:4000/api`; `GET /api/health` reports API and database readiness.

The API verifies the MongoDB unique index for per-user offline report IDs before listening. To verify or create that index separately during deployment, run `npm run ensure-indexes -w server`. It is safe to rerun; if existing duplicate client IDs prevent index creation, resolve those duplicates before starting the API.

To build the frontend locally, run `npm run build`. `npm run preview -w client` serves the generated build for a local production-style preview.

## Initial account setup and data seeding

There is no automatic seeder for fake emergencies or providers. This avoids presenting fabricated resources as live emergency information. Register the first account using the app or `POST /api/auth/register`, then promote it to an administrator from the project root:

```sh
npm run promote-user -w server -- coordinator@example.org admin
```

The command changes the role of an existing account; it does not create one. Keep this command restricted to trusted operators and do not expose it as a public endpoint. After logging in as the administrator, use the API to grant coordinator access, verify provider profiles, and enter real, confirmed operational data. To promote an account to coordinator directly, replace `admin` with `coordinator`.

## Deployment

Keep frontend and API origins on HTTPS in production. Never commit `.env`, `.env.*`, credentials, database connection strings, or signing secrets. The root `.gitignore` excludes env files while allowing the checked-in `.env.example` files.

### Backend: Node.js hosting service

1. Create a MongoDB Atlas database and database user. Restrict the Atlas network access list to the API host's outbound IP ranges where supported. Use a replica-set connection string and URL-encode special characters in credentials.
2. Create a Node.js web service from the repository. Set its root to the repository root (for a monorepo host) and use:
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
3. Configure these service environment variables in the host dashboard, not in source control:
   - `NODE_ENV=production`
   - `MONGODB_URI=<Atlas replica-set URI>`
   - `JWT_SECRET=<unique random value, at least 32 characters>`
   - `CLIENT_ORIGIN=https://<your-frontend-host>` (comma-separated exact origins are supported; do not include paths or trailing slashes)
   - `TRUST_PROXY_HOPS=1` when the host places one trusted reverse proxy in front of Express; set the actual trusted proxy hop count for your host.
   - `PORT` is normally assigned by the hosting service. The API defaults to 4000 for local development.
4. Deploy and verify `https://<api-host>/api/health` returns HTTP 200 with `{"status":"ok","database":"connected"}`. A disconnected database returns HTTP 503.
5. Bootstrap the first administrator only after the service is connected to the intended production database. Run the `promote-user` script from an appropriately secured administrative environment using that same database URI, after registering the account. Do not store production credentials in a local checked-in file.

The API enforces the configured CORS allow-list and fails startup in production if `CLIENT_ORIGIN` is missing. Cookie sessions are HttpOnly and Secure in production. If your host uses a different number of trusted proxies, configure `TRUST_PROXY_HOPS` correctly so client IP rate limits use the forwarded address safely.

### Frontend: static hosting

1. Create a static site from the repository. Set the build root/workspace to `client` or use the monorepo commands below:
   - Install: `npm install` from repository root
   - Build: `npm run build`
   - Publish directory: `client/dist`
2. Configure the build-time variable `VITE_API_URL=https://<your-api-host>/api`. Vite embeds `VITE_*` values into the built client, so set it before building and rebuild after changing it.
3. Configure the static host to serve `index.html` for client-side routes if those routes are enabled by the client.
4. Set the backend's `CLIENT_ORIGIN` to the exact HTTPS origin used by the static site, redeploy the API, then redeploy the frontend.
5. Check browser network requests, sign in, and confirm `GET /api/health` succeeds from the deployed client origin.

Use the provider's supported static hosting and Node web service options; exact dashboard labels vary by provider. External SMS, email, and routing services are not required by this MVP and are not configured by default. Manual coordination remains available if those integrations are unavailable.

## Configuration files

- `server/.env.example`: API, MongoDB, JWT, CORS, proxy, and optional match weights.
- `client/.env.example`: local Vite API URL. In production set `VITE_API_URL` in the static host build environment.
- `.gitignore`: excludes local env files, dependencies, build output, and coverage artifacts.

## Tests and verification

Run the automated matching and evidence-explanation unit tests from the repository root:

```sh
npm test -w server
npm run build
```

With the API running and connected to a non-production database, smoke-test `GET /api/health`, registration/login/logout, role-protected endpoints, request creation, provider profile and inventory updates, matching, coordinator assignment, provider acceptance/decline, fulfillment confirmation, and feedback. See [API documentation](docs/API.md) for the route list and access roles. Do not run destructive smoke tests against production records.

## Documentation

- [API documentation](docs/API.md)
- [Server environment example](server/.env.example)
- [Client environment example](client/.env.example)

## Matching and operational limits

Matching filters mandatory service, qualifications, unreserved inventory, workload, availability, service area, provider verification, and operating hours before scoring. Eligible providers receive normalized components using configurable default weights: service/skills 25%, resource capacity 20%, availability 20%, straight-line distance 15%, verified reliability 10%, and verified feedback 10%. Missing score data is surfaced as uncertainty and remaining weights are renormalized. Distance is not travel time. Recommendations are advisory; coordinators make assignments, and an offer is not confirmed until the provider accepts it. Current full-quantity assignment reservations require MongoDB transaction support.
