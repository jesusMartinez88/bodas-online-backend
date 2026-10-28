import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH = process.env.DB_PATH || "file:data/wedding.csp.test.db";
process.env.RESEND_API_KEY = "";

const { default: app } = await import("../src/app.js");
const { initializationPromise } = await import("../src/db.js");
await initializationPromise;

const server = app.listen(0);
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const getCsp = async () => {
  const response = await fetch(`${baseUrl}/health`);
  return response.headers.get("content-security-policy") || "";
};

/** Divide la cabecera en directivas → valores. */
const parseCsp = (csp) =>
  Object.fromEntries(
    csp
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
      }),
  );

test("La CSP del backend incluye las directivas que Helmet pone por defecto", async () => {
  const directives = parseCsp(await getCsp());

  // Estas se perdían al sobreescribir `directives` de Helmet.
  assert.deepEqual(directives["base-uri"], ["'self'"]);
  assert.deepEqual(directives["form-action"], ["'self'"]);
  assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
  assert.deepEqual(directives["script-src-attr"], ["'none'"]);
  assert.ok(
    "upgrade-insecure-requests" in directives,
    "Falta upgrade-insecure-requests",
  );
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["default-src"], ["'self'"]);
});

test("La allowlist de Stripe cubre 3-D Secure y los orígenes que Stripe.js usa", async () => {
  const directives = parseCsp(await getCsp());

  assert.ok(
    directives["script-src"].includes("https://js.stripe.com"),
    "Falta js.stripe.com en script-src",
  );
  assert.ok(
    directives["script-src"].includes("https://*.js.stripe.com"),
    "Falta *.js.stripe.com en script-src (Stripe lo recomienda para poder arrancar frames en otros orígenes)",
  );
  assert.ok(
    directives["frame-src"].includes("https://hooks.stripe.com"),
    "Falta hooks.stripe.com en frame-src (Payment Element y challenge 3DS)",
  );
  assert.ok(
    directives["frame-src"].includes("https://*.js.stripe.com"),
    "Falta *.js.stripe.com en frame-src",
  );
  assert.ok(
    directives["frame-src"].includes("https://*.3dsecure.io"),
    "Falta *.3dsecure.io en frame-src (challenge 3DS embebido)",
  );
  assert.ok(
    directives["connect-src"].includes("https://api.stripe.com"),
    "Falta api.stripe.com en connect-src",
  );
  assert.ok(
    directives["connect-src"].includes("https://q.stripe.com"),
    "Falta q.stripe.com en connect-src (origen al que Stripe.js hace XHR)",
  );
  assert.ok(
    directives["img-src"].includes("https://*.stripe.com"),
    "Falta *.stripe.com en img-src",
  );
});

test("La CSP no abre horizontes innecesarios", async () => {
  const directives = parseCsp(await getCsp());

  // `script-src` con `https:` permitiría cualquier script remoto.
  assert.ok(
    !directives["script-src"].includes("https:"),
    "script-src no debe permitir cualquier origen",
  );
  assert.ok(
    !directives["default-src"].includes("https:"),
    "default-src no debe permitir cualquier origen",
  );
  assert.ok(
    !directives["connect-src"].includes("https:"),
    "connect-src no debe permitir cualquier origen",
  );
  assert.ok(
    !directives["frame-src"].includes("https:"),
    "frame-src no debe permitir cualquier origen",
  );
});

test("Las demás cabeceras de seguridad siguen presentes", async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.ok(response.headers.get("referrer-policy"), "Falta Referrer-Policy");
});
