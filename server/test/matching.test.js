import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMatch } from "../src/services/matching.js";

test("missing provider evidence cannot pass mandatory matching checks", () => {
  const match = evaluateMatch(
    {
      category: "Medical assistance",
      requiredService: "first aid",
      requiredSkills: ["first aid"],
      items: [{ resource: "First-aid kits", quantity: 2, unit: "kits" }],
      location: { coordinatesAuthorized: true, coordinates: [77.2, 28.6] },
    },
    {
      name: "Unverified provider",
      category: "Medical assistance",
      serviceCategories: ["Medical assistance"],
      skills: [],
      qualifications: [],
      credentials: [],
      inventory: [],
      capacity: 1,
      availability: "available",
      verificationStatus: "pending",
      verified: false,
      serviceRadiusKm: 10,
      location: { coordinates: [77.2, 28.6] },
    },
  );

  assert.equal(match.eligibilityChecks.verified, false);
  assert.equal(match.eligible, false);
  assert.equal(match.eligibilityStatus, "Not eligible");
  assert.ok(
    match.uncertainties.some((message) => message.includes("inventory")),
  );
  assert.ok(
    match.explanation.safetyLimitations.some((message) =>
      message.includes("pending"),
    ),
  );
});

test("explanations do not claim missing completion history or feedback as evidence", () => {
  const match = evaluateMatch(
    {
      category: "Other emergency supplies",
      requiredService: "distribution",
      items: [{ resource: "Blankets", quantity: 1, unit: "blanket" }],
      location: { coordinatesAuthorized: false },
    },
    {
      name: "Provider with incomplete records",
      category: "Other emergency supplies",
      serviceCategories: ["Other emergency supplies"],
      skills: ["distribution"],
      inventory: [],
      capacity: 1,
      availability: "unavailable",
      verificationStatus: "pending",
      verified: false,
    },
  );

  assert.equal(match.evidence.performance.verifiedCompletedAssignments, 0);
  assert.equal(match.evidence.feedback.verifiedCount, 0);
  assert.ok(
    match.uncertainties.some((message) =>
      message.includes("completed assignments"),
    ),
  );
  assert.ok(
    match.uncertainties.some((message) =>
      message.includes("recipient feedback"),
    ),
  );
  assert.ok(
    !match.reasons.some((message) =>
      /reliable past assistance|positive feedback/i.test(message),
    ),
  );
});
