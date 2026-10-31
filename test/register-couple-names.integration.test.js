import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.couple-names.test.db";
// Sin clave de Resend el servicio de email queda deshabilitado: los tests no
// salen a internet y la latencia es determinista.
process.env.RESEND_API_KEY = "";

const { default: app } = await import("../src/app.js");
const { default: db, initializationPromise } = await import("../src/db.js");
await initializationPromise;

const server = app.listen(0);
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/api`;

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
};

const register = async (username, extra = {}) => {
  const res = await request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: `${username}@test.com`,
      password: "password123",
      ...extra,
    }),
  });
  return res;
};

const cleanupUsernames = [
  "couplenamesA",
  "couplenamesB",
  "couplenamesC",
  "couplenamesD",
  "couplenamesE",
  "couplenamesF",
];
const cleanup = () =>
  db.run(
    `DELETE FROM users WHERE username IN (${cleanupUsernames.map(() => "?").join(", ")})`,
    cleanupUsernames,
  );

test.before(async () => {
  await cleanup();
});

test.after(async () => {
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
});

test("El registro guarda los nombres de la pareja en la BD", async () => {
  const res = await register("couplenamesA", {
    partner1Name: "Paco",
    partner2Name: "Lola",
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await db.get(
    "SELECT partner1Name, partner2Name FROM users WHERE username = ?",
    ["couplenamesA"],
  );

  assert.equal(row.partner1Name, "Paco");
  assert.equal(row.partner2Name, "Lola");
});

test("El registro devuelve los nombres de la pareja en la respuesta", async () => {
  const res = await register("couplenamesB", {
    partner1Name: "Antonio",
    partner2Name: "María",
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.partner1Name, "Antonio");
  assert.equal(res.body.user.partner2Name, "María");
});

test("Los nombres se limpian: sin HTML y sin espacios sobrantes", async () => {
  const res = await register("couplenamesC", {
    partner1Name: "  <b>Paco</b>  García  ",
    partner2Name: "Lola",
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await db.get(
    "SELECT partner1Name, partner2Name FROM users WHERE username = ?",
    ["couplenamesC"],
  );

  assert.equal(row.partner1Name, "Paco García");
  assert.equal(row.partner2Name, "Lola");
});

test("El registro sigue funcionando sin nombres de la pareja", async () => {
  const res = await register("couplenamesD");

  assert.equal(res.status, 201, JSON.stringify(res.body));

  const row = await db.get(
    "SELECT partner1Name, partner2Name FROM users WHERE username = ?",
    ["couplenamesD"],
  );

  assert.equal(row.partner1Name, null);
  assert.equal(row.partner2Name, null);
});

test("Los nombres no pueden pasar del límite de 100 caracteres", async () => {
  const res = await register("couplenamesE", {
    partner1Name: "a".repeat(101),
    partner2Name: "Lola",
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test("Los nombres de la pareja se devuelven en /auth/me", async () => {
  const res = await register("couplenamesF", {
    partner1Name: "Paco",
    partner2Name: "Lola",
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));

  const me = await request("/auth/me", {
    headers: { Cookie: `tb_session=${res.body.token}` },
  });

  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.partner1Name, "Paco");
  assert.equal(me.body.user.partner2Name, "Lola");
});
