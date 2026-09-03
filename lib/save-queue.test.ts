import assert from "node:assert/strict";
import test from "node:test";
import { SerializedSaveQueue } from "./save-queue.ts";

test("serializes cloud writes so an older save cannot finish after a newer save", async () => {
  const queue = new SerializedSaveQueue<string>();
  const completed: string[] = [];
  const first = queue.enqueue("older", async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    completed.push(value);
  });
  const second = queue.enqueue("newer", async (value) => {
    completed.push(value);
  });
  await Promise.all([first, second]);
  assert.deepEqual(completed, ["older", "newer"]);
});

test("continues after a failed save", async () => {
  const queue = new SerializedSaveQueue<string>();
  await assert.rejects(queue.enqueue("failed", async () => { throw new Error("offline"); }));
  let persisted = "";
  await queue.enqueue("recovered", async (value) => { persisted = value; });
  assert.equal(persisted, "recovered");
});
