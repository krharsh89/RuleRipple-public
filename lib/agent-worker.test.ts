import assert from "node:assert/strict";
import test from "node:test";
import { deliverRequests } from "../integrations/agent-worker.mjs";

const args = { origin: "https://ruleripple.example", credential: "rragent1.testcredential", requests: [{ submission_id: "immutable-delivery-1" }] };
const receipt = () => Response.json({ received: ["RQ-123"], duplicates: [] }, { status: 201 });
const decision = () => Response.json({ rows: [{ requestId: "RQ-123", status: "pending_approval", requested: 1000, proposed: 1000, authorized: 0, accounting: { remainingAuthorization: 0, consumed: 0 } }] });
test("worker posts once then reads its own decision without executing or calling Codex", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const result = await deliverRequests({ ...args, fetchImpl: async (url, options) => { calls.push({ url: String(url), options: options! }); return options?.method === "POST" ? receipt() : decision(); } });
  assert.equal(calls.length, 2); assert.equal(calls[0].url, "https://ruleripple.example/api/agent-requests");
  assert.equal(calls[1].url, "https://ruleripple.example/api/agent-requests?request_id=RQ-123");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(result.decisions[0].authorized, 0); assert.equal(result.executionAttempted, false);
});
test("ambiguous delivery retries identical IDs and reads duplicate receipt without granting again", async () => {
  const bodies: unknown[] = []; let posts = 0;
  const result = await deliverRequests({ ...args, pause: async () => {}, fetchImpl: async (_url, options) => {
    if (options?.method === "GET") return decision();
    bodies.push(options?.body); posts++;
    if (posts === 1) throw new Error("network reset after save");
    return Response.json({ received: [], duplicates: ["RQ-123"] });
  } });
  assert.equal(result.duplicateRetries, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});
test("worker refuses unsafe endpoints, spoofed identities and invalid credentials before sending", async () => {
  for (const change of [{ origin: "http://ruleripple.example" }, { origin: "https://ruleripple.example/path" }, { origin: "https://secret@ruleripple.example" }, { origin: "https://ruleripple.example/?secret=key" }, { credential: "owner-id-token" }, { requests: [{ submission_id: "x", agent: { id: "other" } }] }]) await assert.rejects(deliverRequests({ ...args, ...change, fetchImpl: async () => { assert.fail("must not send"); } }));
});
test("denied connections stop without retries or echoing response secrets", async () => {
  let calls = 0;
  await assert.rejects(deliverRequests({ ...args, fetchImpl: async () => { calls++; return new Response("SENSITIVE_PROVIDER_VALUE", { status: 401 }); } }), (e: Error) => e.message.includes("401") && !e.message.includes("SENSITIVE"));
  assert.equal(calls, 1);
});
test("malformed receipt or missing decision fails rather than implying authorization", async () => {
  await assert.rejects(deliverRequests({ ...args, fetchImpl: async () => Response.json({ ok: true }) }), /Invalid delivery receipt/);
  await assert.rejects(deliverRequests({ ...args, fetchImpl: async (_url, options) => options?.method === "POST" ? receipt() : Response.json({ rows: [] }) }), /Could not verify/);
});
