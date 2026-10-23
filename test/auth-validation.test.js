import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import app from "../src/app.js";

/**
 * Regresión del hallazgo #2 de la revisión de seguridad:
 * `POST /api/auth/login` devolvía 500 ante entradas inválidas del cliente.
 * Lo correcto es 400 (entrada inválida) y 401 (credenciales incorrectas).
 */
describe("POST /api/auth/login — validación de entrada", () => {
  let server;
  let base;

  before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
  });

  const post = (body, raw = false) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    });

  it("responde 400 con body vacío (no 500)", async () => {
    const res = await post({});
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.ok(Array.isArray(data.errors) && data.errors.length > 0);
  });

  it("responde 400 si falta el password", async () => {
    const res = await post({ username: "alguien" });
    assert.strictEqual(res.status, 400);
  });

  it("responde 400 si el password no es string", async () => {
    const res = await post({ username: "alguien", password: 1234 });
    assert.strictEqual(res.status, 400);
  });

  it("responde 400 si el body es un array", async () => {
    const res = await post([]);
    assert.strictEqual(res.status, 400);
  });

  it("responde 400 con JSON malformado (no 500)", async () => {
    const res = await post("{json roto", true);
    assert.strictEqual(res.status, 400);
  });

  it("responde 401 (no 500) con credenciales incorrectas", async () => {
    const res = await post({
      username: "usuario-que-no-existe-1234",
      password: "contrasena-incorrecta",
    });
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    // Mismo mensaje para "usuario inexistente" y "contraseña incorrecta":
    // no debe permitir enumerar cuentas.
    assert.strictEqual(data.message, "Invalid credentials");
  });

  it("no filtra el stack trace en los 400", async () => {
    const res = await post({});
    const text = await res.text();
    assert.ok(!text.includes("at Object."), "el body no debe incluir stack trace");
  });
});
