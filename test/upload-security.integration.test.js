import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.upload-security.test.db";
// Sin clave de Resend el servicio de email queda deshabilitado: los tests no
// salen a internet.
process.env.RESEND_API_KEY = "";

const mediaRoot = await mkdtemp(join(tmpdir(), "boda-upload-test-"));
process.env.INVITATION_MEDIA_DIR = mediaRoot;

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

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
});

let userToken;
let userSlug;
let userId;
let adminToken;
let adminId;

test.before(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'upl%'");

  const register = async (username, email) => {
    const res = await request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password: "password123" }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };

  const user = await register("upluser", "upluser@test.com");
  userToken = user.token;
  userSlug = user.user.slug;
  userId = user.user.id;

  const admin = await register("upladmin", "upladmin@test.com");
  await db.run("UPDATE users SET role = 'admin' WHERE id = ?", [admin.user.id]);
  const login = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "upladmin", password: "password123" }),
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  adminToken = login.body.token;
  adminId = login.body.user.id;
});

test.after(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'upl%'");
  await rm(mediaRoot, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const pngBuffer = () =>
  sharp({
    create: { width: 24, height: 24, channels: 3, background: "#3355aa" },
  })
    .png()
    .toBuffer();

const jpegBuffer = () =>
  sharp({
    create: { width: 24, height: 24, channels: 3, background: "#aa5533" },
  })
    .jpeg()
    .toBuffer();

/** MP3 mínimo con cabecera ID3 (magic bytes válidos). */
const mp3Buffer = () => {
  const header = Buffer.from("ID3", "ascii");
  const body = Buffer.alloc(64, 0);
  return Buffer.concat([header, body]);
};

const upload = async (path, token, field, filename, buffer, type) => {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), filename);
  return request(path, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
};

const listMedia = async (token) => {
  const res = await request("/invitation-media", { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  return res.body.data;
};

const galleryFiles = async () => {
  try {
    return await readdir(join(mediaRoot, userSlug, "gallery"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

// --------------------------------------------------------------------------
// 1. El MIME declarado no basta: manda el contenido
// --------------------------------------------------------------------------

test("Una imagen con MIME válido pero contenido que no es imagen se rechaza", async () => {
  const payload = Buffer.from(
    '<html><script>alert(document.cookie)</script></html>',
    "utf8",
  );

  const res = await upload(
    "/invitation-media/cover",
    userToken,
    "image",
    "cover.png",
    payload,
    "image/png",
  );

  assert.equal(res.status, 415, "El contenido manda sobre el MIME declarado");
  assert.match(
    res.body.error || res.body.message || "",
    /valid JPEG, PNG and WebP/i,
  );

  // No debe quedar nada escrito en disco.
  const files = await galleryFiles();
  assert.deepEqual(files, [], "No debe quedar ningún archivo");
});

test("Un SVG con script se rechaza y no se guarda", async () => {
  const payload = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8",
  );

  const res = await upload(
    "/invitation-media/cover",
    userToken,
    "image",
    "cover.svg",
    payload,
    "image/png",
  );

  assert.equal(res.status, 415);
});

test("Un MIME no admitido (text/html) se rechaza antes de procesarlo", async () => {
  const res = await upload(
    "/invitation-media/cover",
    userToken,
    "image",
    "evil.html",
    Buffer.from("<h1>hola</h1>", "utf8"),
    "text/html",
  );

  assert.equal(res.status, 415, "El fileFilter debe rechazar MIME no admitidos");
});

test("Una imagen válida se acepta y se guarda como WebP", async () => {
  const res = await upload(
    "/invitation-media/cover",
    userToken,
    "image",
    "cover.png",
    await pngBuffer(),
    "image/png",
  );

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.data.url, /\/covery\/cover\.webp$/);

  const media = await listMedia(userToken);
  assert.ok(media.coverUrl, "La portada debe quedar registrada");
});

// --------------------------------------------------------------------------
// 2. Atomicidad: una subida fallida no deja medias a medias
// --------------------------------------------------------------------------

test("Si un archivo del lote falla, no queda ninguno guardado", async () => {
  const form = new FormData();
  form.append(
    "images",
    new Blob([await pngBuffer()], { type: "image/png" }),
    "gallery-1.png",
  );
  form.append(
    "images",
    new Blob([Buffer.from("no soy una imagen", "utf8")], {
      type: "image/png",
    }),
    "gallery-2.png",
  );

  const res = await request("/invitation-media/gallery", {
    method: "POST",
    headers: authHeaders(userToken),
    body: form,
  });

  assert.equal(res.status, 415, "El lote debe fallar entero");
  assert.deepEqual(
    await galleryFiles(),
    [],
    "El archivo válido no debe quedarse huérfano en disco",
  );
});

// --------------------------------------------------------------------------
// 3. Audio: magic bytes y MIME
// --------------------------------------------------------------------------

test("Un audio con MIME válido pero sin cabecera MP3 se rechaza", async () => {
  const res = await upload(
    `/admin/users/${userId}/music`,
    adminToken,
    "audio",
    "cancion.mp3",
    Buffer.from("esto no es un mp3 en absoluto", "utf8"),
    "audio/mpeg",
  );

  assert.equal(res.status, 415, "Deben comprobarse los magic bytes");
});

test("Un MP3 válido se acepta", async () => {
  const res = await upload(
    `/admin/users/${userId}/music`,
    adminToken,
    "audio",
    "cancion.mp3",
    mp3Buffer(),
    "audio/mpeg",
  );

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.data.url, /\/music\/background\.mp3$/);
});

test("Un archivo que no es audio se rechaza por su MIME", async () => {
  const res = await upload(
    `/admin/users/${userId}/music`,
    adminToken,
    "audio",
    "cancion.mp3",
    mp3Buffer(),
    "text/html",
  );

  assert.equal(res.status, 415);
});
