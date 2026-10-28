import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.isolation.test.db";

const { default: app } = await import("../src/app.js");
const { default: db, initializationPromise } = await import("../src/db.js");

// La creación del esquema es asíncrona: hay que esperarla antes de tocar la BD.
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
  "Content-Type": "application/json",
});

let tokenA;
let tokenB;
let headersA;
let headersB;
let userA;
let userB;

test.before(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'isouser%'");

  const register = async (username, email) => {
    const res = await request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password: "password123" }),
    });
    assert.equal(res.status, 201, `El registro de ${username} debe funcionar`);
    return res.body;
  };

  const a = await register("isouserA", "isouserA@test.com");
  const b = await register("isouserB", "isouserB@test.com");

  userA = a.user;
  userB = b.user;
  tokenA = a.token;
  tokenB = b.token;
  headersA = authHeaders(tokenA);
  headersB = authHeaders(tokenB);
});

test.after(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'isouser%'");
  await new Promise((resolve) => server.close(resolve));
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const createGuest = async (headers, name, email) => {
  const res = await request("/guests", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, email }),
  });
  assert.equal(res.status, 201, `No se pudo crear el invitado ${name}`);
  return res.body.data;
};

const createTable = async (headers, name) => {
  const res = await request("/tables", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, capacity: 8 }),
  });
  assert.equal(res.status, 201, `No se pudo crear la mesa ${name}`);
  return res.body.data;
};

const listGuests = async (headers) => {
  const res = await request("/guests", { headers });
  assert.equal(res.status, 200);
  return res.body.data;
};

const listTables = async (headers) => {
  const res = await request("/tables", { headers });
  assert.equal(res.status, 200);
  return res.body.data;
};

const countGuests = async (headers) => (await listGuests(headers)).length;
const countTables = async (headers) => (await listTables(headers)).length;

const requestDeleteCode = async (headers, resource) => {
  const res = await request(`/${resource}/request-delete`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(res.status, 200, `No se pudo pedir el código de ${resource}`);
  assert.ok(res.body.code, "En test el código debe devolverse en la respuesta");
  return res.body.code;
};

/** Un acceso a un recurso ajeno debe ser rechazado (403 o 404). */
const assertBlocked = (res, what) => {
  assert.ok(
    res.status === 403 || res.status === 404,
    `${what}: se esperaba 403/404 y se recibió ${res.status} (${JSON.stringify(res.body)})`,
  );
};

// --------------------------------------------------------------------------
// 1. Códigos de borrado masivo: aislamiento por tenant (regresión)
// --------------------------------------------------------------------------

test("El código de borrado de un tenant no habilita el borrado masivo de otro", async () => {
  await createGuest(headersA, "Invitado A", "ga@test.com");
  await createGuest(headersB, "Invitado B", "gb@test.com");

  const guestsABefore = await countGuests(headersA);
  const guestsBBefore = await countGuests(headersB);

  const codeA = await requestDeleteCode(headersA, "guests");

  // B intenta usar el código emitido para A.
  const attack = await request(`/guests?code=${codeA}`, {
    method: "DELETE",
    headers: headersB,
  });

  assert.equal(
    attack.status,
    400,
    "El código de A no debe autorizar el borrado de B",
  );
  assert.match(
    attack.body.error || "",
    /Invalid confirmation code/i,
    "El error debe indicar código inválido",
  );

  // Los datos de A siguen intactos y B conserva los suyos.
  assert.equal(
    await countGuests(headersA),
    guestsABefore,
    "Los invitados de A no deben tocarse",
  );
  assert.equal(
    await countGuests(headersB),
    guestsBBefore,
    "Los invitados de B no deben tocarse",
  );
});

test("Pedir un código en un tenant no invalida el código pendiente del otro", async () => {
  await createGuest(headersA, "Invitado A2", "ga2@test.com");
  await createGuest(headersB, "Invitado B2", "gb2@test.com");

  const codeA = await requestDeleteCode(headersA, "guests");
  const codeB = await requestDeleteCode(headersB, "guests");

  // El código de A sigue siendo válido pese a que B haya pedido el suyo.
  const delA = await request(`/guests?code=${codeA}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(delA.status, 200, "El código propio debe seguir siendo válido");

  // Y el de B también, de forma independiente.
  const delB = await request(`/guests?code=${codeB}`, {
    method: "DELETE",
    headers: headersB,
  });
  assert.equal(delB.status, 200, "Cada tenant conserva su propio código");
});

test("El borrado masivo con el código propio solo borra los datos del propio tenant", async () => {
  await createGuest(headersA, "Invitado A3", "ga3@test.com");
  await createGuest(headersB, "Invitado B3", "gb3@test.com");

  const guestsABefore = await countGuests(headersA);
  const guestsBBefore = await countGuests(headersB);

  const codeA = await requestDeleteCode(headersA, "guests");
  const del = await request(`/guests?code=${codeA}`, {
    method: "DELETE",
    headers: headersA,
  });

  assert.equal(del.status, 200);
  assert.equal(
    await countGuests(headersA),
    0,
    "A debe quedarse sin ningún invitado",
  );
  assert.equal(
    await countGuests(headersB),
    guestsBBefore,
    "Los invitados de B deben sobrevivir al borrado de A",
  );
  assert.ok(guestsABefore > 0);
});

test("El código de borrado de invitados y el de mesas son independientes", async () => {
  await createGuest(headersA, "Invitado A4", "ga4@test.com");
  await createTable(headersA, "Mesa A4");

  const guestCode = await requestDeleteCode(headersA, "guests");
  const tableCode = await requestDeleteCode(headersA, "tables");

  const guestsABefore = await countGuests(headersA);

  // El código de mesas no habilita el borrado de invitados.
  const wrongPurpose = await request(`/guests?code=${tableCode}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(
    wrongPurpose.status,
    400,
    "El código de mesas no debe servir para invitados",
  );
  assert.equal(
    await countGuests(headersA),
    guestsABefore,
    "No debe borrarse nada con un código de otro propósito",
  );

  // Cada uno sigue sirviendo para su propósito.
  const delGuests = await request(`/guests?code=${guestCode}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(delGuests.status, 200);

  const delTables = await request(`/tables?code=${tableCode}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(delTables.status, 200);
});

test("El código de borrado de mesas de un tenant no habilita el borrado de otro", async () => {
  await createTable(headersA, "Mesa A5");
  await createTable(headersB, "Mesa B5");

  const tablesABefore = await countTables(headersA);
  const tablesBBefore = await countTables(headersB);

  const codeA = await requestDeleteCode(headersA, "tables");

  const attack = await request(`/tables?code=${codeA}`, {
    method: "DELETE",
    headers: headersB,
  });
  assert.equal(attack.status, 400, "El código de A no debe autorizar a B");

  assert.equal(
    await countTables(headersA),
    tablesABefore,
    "Las mesas de A no deben tocarse",
  );
  assert.equal(
    await countTables(headersB),
    tablesBBefore,
    "Las mesas de B no deben tocarse",
  );
});

test("Un código de borrado es de un solo uso", async () => {
  await createGuest(headersA, "Invitado A6", "ga6@test.com");

  const code = await requestDeleteCode(headersA, "guests");
  const first = await request(`/guests?code=${code}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(first.status, 200);

  const second = await request(`/guests?code=${code}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(second.status, 400, "El código no puede reutilizarse");
});

test("Sin código no se puede borrar masivamente", async () => {
  const noCode = await request("/guests", {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(noCode.status, 400, "El código es obligatorio");
  assert.match(noCode.body.error || "", /missing/i);
});

test("Las rutas /guests/bulk y /guests borran con el mismo código", async () => {
  await createGuest(headersA, "Invitado A7", "ga7@test.com");

  const code = await requestDeleteCode(headersA, "guests");
  const viaBulk = await request(`/guests/bulk?code=${code}`, {
    method: "DELETE",
    headers: headersA,
  });
  assert.equal(viaBulk.status, 200, "La ruta /bulk debe seguir disponible");
});

// --------------------------------------------------------------------------
// 2. IDOR sobre recursos individuales
// --------------------------------------------------------------------------

test("B no puede leer, editar ni borrar los invitados de A", async () => {
  const guest = await createGuest(headersA, "Invitado privado", "priv@test.com");
  const id = guest.id;

  const read = await request(`/guests/${id}`, { headers: headersB });
  assertBlocked(read, "lectura de invitado ajeno");
  assert.ok(
    !JSON.stringify(read.body).includes("Invitado privado"),
    "No debe filtrarse el nombre del invitado de A",
  );

  const update = await request(`/guests/${id}`, {
    method: "PUT",
    headers: headersB,
    body: JSON.stringify({ name: "Secuestrado", email: "hack@test.com" }),
  });
  assertBlocked(update, "actualización de invitado ajeno");

  const patch = await request(`/guests/${id}`, {
    method: "PATCH",
    headers: headersB,
    body: JSON.stringify({ name: "Secuestrado" }),
  });
  assertBlocked(patch, "parche de invitado ajeno");

  const remove = await request(`/guests/${id}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(remove, "borrado de invitado ajeno");

  // El recurso sigue intacto para su dueño.
  const check = await request(`/guests/${id}`, { headers: headersA });
  assert.equal(check.status, 200);
  assert.equal(check.body.data.name, "Invitado privado");
});

test("B no puede leer, editar ni borrar las mesas de A", async () => {
  const table = await createTable(headersA, "Mesa privada");
  const id = table.id;

  const read = await request(`/tables/${id}`, { headers: headersB });
  assertBlocked(read, "lectura de mesa ajena");

  const patch = await request(`/tables/${id}`, {
    method: "PATCH",
    headers: headersB,
    body: JSON.stringify({ name: "Secuestrada", capacity: 99 }),
  });
  assertBlocked(patch, "actualización de mesa ajena");

  const remove = await request(`/tables/${id}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(remove, "borrado de mesa ajena");

  const check = await request(`/tables/${id}`, { headers: headersA });
  assert.equal(check.status, 200);
  assert.equal(check.body.data.name, "Mesa privada");
});

test("B no puede tocar las tareas, contactos, finanzas ni categorías de A", async () => {
  const todo = await request("/todos", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "Tarea privada" }),
  });
  assert.equal(todo.status, 201, JSON.stringify(todo.body));
  const todoId = todo.body.data.id;

  const contact = await request("/contacts", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      name: "Contacto privado",
      phone: "600111222",
      side: "novia",
      countryCode: "+34",
    }),
  });
  assert.equal(contact.status, 201, JSON.stringify(contact.body));
  const contactId = contact.body.data.id;

  const finance = await request("/finances", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      description: "Gasto privado",
      amount: 42,
      type: "expense",
    }),
  });
  assert.equal(finance.status, 201);
  const financeId = finance.body.data.id;

  const category = await request("/categories", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "Categoría privada" }),
  });
  assert.equal(category.status, 200);
  const categoryId = category.body.data.id;

  const todoGet = await request(`/todos/${todoId}`, { headers: headersB });
  assertBlocked(todoGet, "lectura de tarea ajena");

  const todoPatch = await request(`/todos/${todoId}`, {
    method: "PATCH",
    headers: headersB,
    body: JSON.stringify({ name: "Secuestrada" }),
  });
  assertBlocked(todoPatch, "actualización de tarea ajena");

  const contactPatch = await request(`/contacts/${contactId}`, {
    method: "PATCH",
    headers: headersB,
    body: JSON.stringify({ name: "Secuestrado" }),
  });
  assertBlocked(contactPatch, "actualización de contacto ajeno");

  const financeGet = await request(`/finances/${financeId}`, { headers: headersB });
  assertBlocked(financeGet, "lectura de finanza ajena");

  const financeDelete = await request(`/finances/${financeId}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(financeDelete, "borrado de finanza ajena");

  const categoryDelete = await request(`/categories/${categoryId}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(categoryDelete, "borrado de categoría ajena");

  // Nada se ha modificado ni borrado.
  const checkTodo = await request(`/todos/${todoId}`, { headers: headersA });
  assert.equal(checkTodo.status, 200);
  assert.equal(checkTodo.body.data.name, "Tarea privada");

  const checkFinance = await request(`/finances/${financeId}`, {
    headers: headersA,
  });
  assert.equal(checkFinance.status, 200);

  const checkCategory = await request("/categories", { headers: headersA });
  assert.ok(
    checkCategory.body.data.some((c) => c.id === categoryId),
    "La categoría de A debe seguir existiendo",
  );
});

test("B no puede tocar la playlist de A", async () => {
  const song = await request("/music-playlist", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      title: "Canción privada",
      artist: "Artista",
      youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    }),
  });
  assert.equal(song.status, 201, JSON.stringify(song.body));
  const songId = song.body.data.id;

  const patch = await request(`/music-playlist/${songId}`, {
    method: "PATCH",
    headers: headersB,
    body: JSON.stringify({ title: "Secuestrada" }),
  });
  assertBlocked(patch, "actualización de canción ajena");

  const remove = await request(`/music-playlist/${songId}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(remove, "borrado de canción ajena");

  const listA = await request("/music-playlist", { headers: headersA });
  assert.ok(
    listA.body.data.some((s) => s.id === songId),
    "La canción de A debe seguir en su playlist",
  );

  // El listado de B no debe incluir la canción de A.
  const listB = await request("/music-playlist", { headers: headersB });
  assert.ok(
    !listB.body.data.some((s) => s.id === songId),
    "B no debe ver la canción de A en su listado",
  );
});

test("B no puede borrar ni listar los contactos y tareas de A", async () => {
  const contact = await request("/contacts", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      name: "Contacto listado",
      phone: "600333444",
      side: "novio",
      countryCode: "+34",
    }),
  });
  assert.equal(contact.status, 201, JSON.stringify(contact.body));
  const contactId = contact.body.data.id;

  const todo = await request("/todos", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "Tarea listada" }),
  });
  assert.equal(todo.status, 201);
  const todoId = todo.body.data.id;

  // Borrados cruzados.
  const contactDelete = await request(`/contacts/${contactId}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(contactDelete, "borrado de contacto ajeno");

  const todoDelete = await request(`/todos/${todoId}`, {
    method: "DELETE",
    headers: headersB,
  });
  assertBlocked(todoDelete, "borrado de tarea ajena");

  const todoPut = await request(`/todos/${todoId}`, {
    method: "PUT",
    headers: headersB,
    body: JSON.stringify({ name: "Secuestrada" }),
  });
  assertBlocked(todoPut, "actualización PUT de tarea ajena");

  // Listados: B no debe ver nada de A.
  const contactsB = await request("/contacts", { headers: headersB });
  assert.ok(
    contactsB.body.data.every((c) => c.userId === userB.id),
    "B solo debe ver sus contactos",
  );
  assert.ok(
    !contactsB.body.data.some((c) => c.id === contactId),
    "B no debe ver el contacto de A",
  );

  const todosB = await request("/todos", { headers: headersB });
  assert.ok(
    todosB.body.data.every((t) => t.userId === userB.id),
    "B solo debe ver sus tareas",
  );
  assert.ok(
    !todosB.body.data.some((t) => t.id === todoId),
    "B no debe ver la tarea de A",
  );

  // Y los recursos de A siguen en pie. (No existe GET /api/contacts/:id:
  // la API solo expone PATCH y DELETE sobre un contacto concreto.)
  const contactsA = await request("/contacts", { headers: headersA });
  assert.ok(
    contactsA.body.data.some((c) => c.id === contactId),
    "El contacto de A debe seguir existiendo",
  );

  const checkTodo = await request(`/todos/${todoId}`, { headers: headersA });
  assert.equal(checkTodo.status, 200, "La tarea de A debe seguir existiendo");
  assert.equal(checkTodo.body.data.name, "Tarea listada");
});

test("B no puede escribir en los ajustes de A", async () => {
  await request("/settings/ajuste_secreto", {
    method: "PUT",
    headers: headersA,
    body: JSON.stringify({ value: "valor-de-A" }),
  });

  const settingsB = await request("/settings", { headers: headersB });
  const found = settingsB.body.data.find((s) => s.key === "ajuste_secreto");
  assert.ok(
    !found || found.value !== "valor-de-A",
    "B no debe ver los ajustes privados de A",
  );
});

// --------------------------------------------------------------------------
// 3. Aislamiento en los listados
// --------------------------------------------------------------------------

test("Los listados no mezclan datos entre tenants", async () => {
  await createGuest(headersA, "Listado A", "listadoa@test.com");
  await createGuest(headersB, "Listado B", "listadob@test.com");
  await createTable(headersA, "Mesa Listado A");
  await createTable(headersB, "Mesa Listado B");

  const guestsA = await listGuests(headersA);
  const guestsB = await listGuests(headersB);
  assert.ok(
    guestsA.every((g) => g.userId === userA.id),
    "A solo ve sus invitados",
  );
  assert.ok(
    guestsB.every((g) => g.userId === userB.id),
    "B solo ve sus invitados",
  );

  const tablesA = await listTables(headersA);
  const tablesB = await listTables(headersB);
  assert.ok(
    tablesA.every((t) => t.userId === userA.id),
    "A solo ve sus mesas",
  );
  assert.ok(
    tablesB.every((t) => t.userId === userB.id),
    "B solo ve sus mesas",
  );

  const financesA = await request("/finances", { headers: headersA });
  const financesB = await request("/finances", { headers: headersB });
  assert.ok(
    financesA.body.data.every((f) => f.userId === userA.id),
    "A solo ve sus finanzas",
  );
  assert.ok(
    financesB.body.data.every((f) => f.userId === userB.id),
    "B solo ve sus finanzas",
  );
});

test("Las rutas públicas solo exponen los datos del slug indicado", async () => {
  const guest = await createGuest(headersA, "Invitado público", "pub@test.com");

  const own = await request(`/guests/public/${userA.slug}/${guest.id}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.data.id, guest.id);

  const foreign = await request(`/guests/public/${userB.slug}/${guest.id}`);
  assert.equal(
    foreign.status,
    404,
    "Con el slug de otro tenant el invitado no debe existir",
  );
});
