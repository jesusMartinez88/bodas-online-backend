import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.settings.test.db";

const { default: app } = await import("../src/app.js");
const { default: db, initializationPromise } = await import("../src/db.js");

await initializationPromise;

const token = jwt.sign({ id: 1, userId: 1, role: "admin", slug: "admin" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});
const authHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

const server = app.listen(0);
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/api/settings`;

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    body: await response.json(),
  };
};

const resetHighchairsSetting = async () => {
  await db.run(
    `INSERT OR REPLACE INTO settings (userId, key, value) VALUES (1, 'enable_highchairs', '0')`,
  );
};

test.beforeEach(async () => {
  await resetHighchairsSetting();
});

test.after(async () => {
  try {
    await resetHighchairsSetting();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("GET /api/settings returns enable_highchairs default false", async () => {
  const response = await request("/", {
    method: "GET",
    headers: authHeaders,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.ok(Array.isArray(response.body.data));

  const highchairs = response.body.data.find(
    (item) => item.key === "enable_highchairs",
  );
  assert.ok(highchairs, "enable_highchairs setting should exist");
  assert.equal(highchairs.value, false);
});

test("PUT /api/settings/enable_highchairs accepts boolean true and persists", async () => {
  const updateResponse = await request("/enable_highchairs", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ value: true }),
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.success, true);
  assert.deepEqual(updateResponse.body.data, { enable_highchairs: true });

  const getResponse = await request("/", {
    method: "GET",
    headers: authHeaders,
  });

  const highchairs = getResponse.body.data.find(
    (item) => item.key === "enable_highchairs",
  );
  assert.equal(highchairs.value, true);
});

test("PUT /api/settings/enable_highchairs accepts string 'false' and persists as false", async () => {
  await request("/enable_highchairs", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ value: true }),
  });

  const updateResponse = await request("/enable_highchairs", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ value: "false" }),
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.success, true);
  assert.deepEqual(updateResponse.body.data, { enable_highchairs: false });

  const getResponse = await request("/", {
    method: "GET",
    headers: authHeaders,
  });

  const highchairs = getResponse.body.data.find(
    (item) => item.key === "enable_highchairs",
  );
  assert.equal(highchairs.value, false);
});
