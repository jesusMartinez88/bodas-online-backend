import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.session-cookie.test.db";
process.env.RESEND_API_KEY = "";
// Origen permitido para las pruebas de CSRF.
process.env.ORIGIN_URL = "https://tubodaonline.onrender.com";

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
  return { status: response.status, body, response };
};

/** Devuelve el par `nombre=valor` de la cookie indicada en `Set-Cookie`. */
const cookiePair = (response, name) => {
  const cookies =
    response.headers.getSetCookie?.() ??
    (response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie")]
      : []);
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!found) return null;
  return found.split(";")[0];
};

const setCookieHeader = (response) => {
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
};

let token;
let cookieHeader;
let username;

const login = async () => {
  const res = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
};

test.before(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'cookieuser%'");
  username = `cookieuser${Date.now().toString().slice(-8)}`;
  const register = await request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: "cookieuser@test.com",
      password: "password123",
    }),
  });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  token = register.body.token;
});

test.after(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'cookieuser%'");
  await new Promise((resolve) => server.close(resolve));
});

// --------------------------------------------------------------------------
// 1. La cookie de sesión
// --------------------------------------------------------------------------

test("El login emite una cookie de sesión httpOnly", async () => {
  const res = await login();
  const cookies = res.response.headers.getSetCookie?.() ?? [];
  const session = cookies.find((cookie) => cookie.startsWith("tb_session="));

  assert.ok(session, "El login debe emitir la cookie de sesión");
  assert.match(session, /HttpOnly/i, "La cookie debe ser httpOnly");
  assert.match(session, /Path=\//i, "La cookie debe valer para toda la API");
  // `onrender.com` está en la Public Suffix List: frontend y backend son
  // sitios distintos, así que la cookie necesita `SameSite=None` (y `Secure`
  // es obligatorio para que el navegador no la rechace).
  assert.match(session, /SameSite=None/i, "Debe llevar SameSite=None");
  assert.match(session, /Secure/i, "SameSite=None exige Secure");
  assert.match(session, /Max-Age=86400/i, "Debe vivir 24 h como el JWT");

  // El valor de la cookie es el propio JWT.
  const value = session.split(";")[0].split("=")[1];
  assert.equal(value.split(".").length, 3, "El valor debe ser un JWT");
});

test("La cookie de sesión autentica sin cabecera Authorization", async () => {
  const res = await login();
  const cookie = setCookieHeader(res.response);
  assert.ok(cookie, "Debe haber cookie");

  const me = await request("/auth/me", { headers: { Cookie: cookie } });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.username, username);
});

test("La cabecera Authorization sigue funcionando (clientes no navegador)", async () => {
  const me = await request("/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, username);
});

test("Sin cookie ni cabecera, la petición es 401", async () => {
  const me = await request("/auth/me");
  assert.equal(me.status, 401);
  assert.match(me.body.message, /Authentication required/i);
});

test("Una cookie manipulada se rechaza", async () => {
  const res = await login();
  const cookie = setCookieHeader(res.response);
  const tampered = cookie.replace(/^tb_session=[^.]+/, "tb_session=aaaa");

  const me = await request("/auth/me", { headers: { Cookie: tampered } });
  assert.equal(me.status, 403, "Un JWT manipulado no puede autenticar");
});

test("El logout borra la cookie de sesión", async () => {
  const res = await login();
  const cookie = setCookieHeader(res.response);

  const logout = await request("/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);

  const cleared = (logout.response.headers.getSetCookie?.() ?? []).find((c) =>
    c.startsWith("tb_session="),
  );
  assert.ok(cleared, "El logout debe enviar la cookie a borrar");
  // El valor vacío + fecha de caducidad pasada = cookie eliminada.
  assert.match(cleared, /tb_session=;/);
});

// --------------------------------------------------------------------------
// 2. El token no se devuelve al navegador
// --------------------------------------------------------------------------

test("A un navegador (con Origin) no se le devuelve el token", async () => {
  const res = await request("/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://tubodaonline.onrender.com",
    },
    body: JSON.stringify({ username, password: "password123" }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.token, undefined, "El navegador no debe recibir el token");
  assert.ok(res.body.user, "Pero sí los datos del usuario");
  // La cookie sí se manda.
  assert.ok(setCookieHeader(res.response), "La cookie debe seguir mandándose");
});

test("A un cliente no navegador (sin Origin) se le devuelve el token", async () => {
  const res = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123" }),
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.token, "Los clientes no navegador necesitan el token");
});

// --------------------------------------------------------------------------
// 3. Protección CSRF (verificación de Origin)
// --------------------------------------------------------------------------

test("Una mutación con un Origin no permitido se bloquea", async () => {
  const res = await request("/guests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "https://sitio-malicioso.example",
    },
    body: JSON.stringify({ name: "Intruso", email: "intruso@test.com" }),
  });

  assert.equal(res.status, 403, "El CSRF debe bloquearse");
  assert.match(res.body.message, /Origin not allowed/i);
});

test("Una mutación con el Origin permitido pasa", async () => {
  const res = await request("/guests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "https://tubodaonline.onrender.com",
    },
    body: JSON.stringify({ name: "Invitadook", email: "ok@test.com" }),
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("Una mutación sin Origin (CLI, app móvil) pasa", async () => {
  const res = await request("/guests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: "Invitado CLI", email: "cli@test.com" }),
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("Las peticiones de lectura no se ven afectadas por el Origin", async () => {
  const res = await request("/guests", {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://sitio-malicioso.example",
    },
  });

  assert.equal(res.status, 200, "Un GET no muta nada: no hay riesgo de CSRF");
});
