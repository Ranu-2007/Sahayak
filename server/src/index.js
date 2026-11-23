import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import authRoutes from "./routes/auth.js";
import requestRoutes from "./routes/requests.js";
import communityRoutes from "./routes/community.js";
import providerRoutes from "./routes/providers.js";
import notificationRoutes from "./routes/notifications.js";
import coordinationRoutes from "./routes/coordination.js";
import resourceRoutes from "./routes/resources.js";
import assignmentRoutes from "./routes/assignments.js";
import locationRoutes from "./routes/location.js";
import { backfillUnclusteredIncidents } from "./services/incidents.js";
import { ensureDatabaseIndexes } from "./services/database.js";
import { configureLiveSockets, closeLiveSockets } from "./services/liveEvents.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { sensitiveOperationLimit } from "./middleware/rateLimit.js";
import { expireLiveLocations } from "./services/expireLiveLocations.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
const isProduction = process.env.NODE_ENV === "production";
const configuredOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (isProduction && configuredOrigins.length === 0) {
  throw new Error(
    "CLIENT_ORIGIN must list the deployed frontend origin in production.",
  );
}
const allowedOrigins = configuredOrigins.length
  ? configuredOrigins
  : ["http://localhost:5173"];
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0)
  app.set("trust proxy", trustProxyHops);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }),
);
app.use((req, res, next) => {
  const changesState = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (
    changesState &&
    req.headers.origin &&
    !allowedOrigins.includes(req.headers.origin)
  ) {
    return res
      .status(403)
      .json({ message: "Origin is not allowed to modify Sahayak data." });
  }
  next();
});
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || "").split(";").filter(Boolean)) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    try {
      req.cookies[part.slice(0, separator).trim()] = decodeURIComponent(
        part.slice(separator + 1).trim(),
      );
    } catch {
      /* Ignore malformed cookie values. */
    }
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
app.get("/", (_req, res) => {
  const database = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res.status(database === "connected" ? 200 : 503).json({
    name: "Sahayak API",
    status: database === "connected" ? "ok" : "unavailable",
    database,
    frontend: allowedOrigins[0] || "http://localhost:5173",
    health: "/api/health",
    api: "/api",
  });
});
app.use("/api", sensitiveOperationLimit);
app.use("/api/auth", authRoutes);
app.use("/api/requests", communityRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/providers", providerRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/coordination", coordinationRoutes);
app.use("/api/resources", resourceRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/admin", coordinationRoutes);
app.get("/api/health", (_req, res) => {
  const database =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res
    .status(database === "connected" ? 200 : 503)
    .json({
      status: database === "connected" ? "ok" : "unavailable",
      database,
    });
});
app.use(notFound);
app.use(errorHandler);

const port = Number(process.env.PORT || 4000);
const start = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be configured before starting the API.");
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters.");
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.info("MongoDB connected");
  await ensureDatabaseIndexes();
  console.info("Required database indexes verified");
  const server = app.listen(port, () =>
    console.info(`Sahayak API listening on ${port}`),
  );
  configureLiveSockets(server, allowedOrigins);
  const locationExpiryTimer = setInterval(() => expireLiveLocations().catch(error => console.error("Live location expiry failed:", error.message)), 30_000);
  locationExpiryTimer.unref?.();
  expireLiveLocations().catch(error => console.error("Live location expiry failed:", error.message));
  setImmediate(() => backfillUnclusteredIncidents().then(count => {
    if (count) console.info(`Linked ${count} existing requests to incident clusters`);
  }).catch(error => console.error("Incident backfill failed:", error.message)));
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(locationExpiryTimer);
    console.info(`${signal} received; closing Sahayak API`);
    closeLiveSockets(() => mongoose.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
};

start().catch((error) => {
  console.error("API startup failed:", error.message);
  process.exitCode = 1;
});
