import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.register-enum.test.db";
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

const register = async (username, email) => {
  const startedAt = Date.now();
  const res = await request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password: "password123" }),
  });
  return { ...res, elapsed: Date.now() - startedAt };
};

const checkUsername = async (username) => {
  const startedAt = Date.now();
  const res = await request(
    `/auth/check-username?username=${encodeURIComponent(username)}`,
  );
  return { ...res, elapsed: Date.now() - startedAt };
};

test.before(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'enumuser%'");
});

test.after(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'enumuser%'");
  await new Promise((resolve) => server.close(resolve));
});

// --------------------------------------------------------------------------
// 1. El registro no revela si el username ya existe
// --------------------------------------------------------------------------

test("Registrar un username libre devuelve 201 y crea la cuenta", async () => {
  const res = await register("enumuserA", "enumusera@test.com");
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.token, "Debe devolver token");
});

test("Registrar un username ocupado no lo dice en el mensaje", async () => {
  const res = await register("enumuserA", "enumusera2@test.com");

  assert.equal(res.status, 409, "Sigue siendo un conflicto (409)");

  const message = String(res.body.message || res.body.error || "");
  assert.ok(message.length > 0, "Debe haber un mensaje");
  assert.doesNotMatch(
    message,
    /username already|taken|already taken|already exists|disponible/i,
    `El mensaje no debe confirmar que el username existe: "${message}"`,
  );
  assert.doesNotMatch(
    message,
    /^username/i,
    `El mensaje no debe empezar por "Username": "${message}"`,
  );
});

test("El registro con username libre y el ocupado tardan lo mismo", async () => {
  // Username libre: camino completo (bcrypt + inserts).
  const libre = await register("enumuserB", "enumuserb@test.com");
  assert.equal(libre.status, 201, JSON.stringify(libre.body));

  // Username ocupado: camino de conflicto (bcrypt descartable).
  const ocupado = await register("enumuserA", "enumusera3@test.com");
  assert.equal(ocupado.status, 409);

  const diferencia = Math.abs(libre.elapsed - ocupado.elapsed);
  assert.ok(
    diferencia < 150,
    `Las dos respuestas deben ser indistinguibles en tiempo: libre=${libre.elapsed}ms, ocupado=${ocupado.elapsed}ms (diferencia ${diferencia}ms)`,
  );
});

test("El registro de un username libre devuelve 201 y el ocupado 409, con el mismo cuerpo genérico", async () => {
  // El status distingue los casos (inevitable), pero el cuerpo no debe
  // filtrar el motivo: ambos errores usan el mismo mensaje genérico.
  const libre = await register("enumuserC", "enumuserc@test.com");
  const ocupado = await register("enumuserC", "enumuserc2@test.com");

  assert.equal(libre.status, 201);
  assert.equal(ocupado.status, 409);
  assert.equal(ocupado.body.success, false);
});

// --------------------------------------------------------------------------
// 2. check-username: el endpoint diseñado para consultar disponibilidad
// --------------------------------------------------------------------------

test("check-username informa de la disponibilidad sin filtrar nada más", async () => {
  const ocupado = await checkUsername("enumuserA");
  assert.equal(ocupado.status, 200);
  assert.equal(ocupado.body.available, false);
  assert.equal(ocupado.body.success, true);
  // No debe incluir el username ni el motivo.
  assert.doesNotMatch(
    JSON.stringify(ocupado.body),
    /enumuserA|taken|already/i,
    "La respuesta no debe filtrar el motivo",
  );

  const libre = await checkUsername("enumuserLibre999");
  assert.equal(libre.status, 200);
  assert.equal(libre.body.available, true);
});

test("check-username mantiene una latencia constante", async () => {
  const ocupado = await checkUsername("enumuserA");
  const libre = await checkUsername("enumuserLibre888");
  const diferencia = Math.abs(ocupado.elapsed - libre.elapsed);
  assert.ok(
    diferencia < 120,
    `La latencia debe ser igual para "ocupado" y "libre": ${ocupado.elapsed}ms vs ${libre.elapsed}ms`,
  );
});

// --------------------------------------------------------------------------
// 3. El login tampoco enumera usuarios
// --------------------------------------------------------------------------

test("El login da el mismo error para usuario inexistente y contraseña incorrecta", async () => {
  const inexistente = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "enumuserNoExiste", password: "password123" }),
  });
  const incorrecta = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "enumuserA", password: "claveIncorrecta" }),
  });

  assert.equal(inexistente.status, 401);
  assert.equal(incorrecta.status, 401);
  assert.equal(
    inexistente.body.message,
    incorrecta.body.message,
    "El mensaje debe ser idéntico en ambos casos",
  );
});
