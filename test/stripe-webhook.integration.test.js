import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.DB_PATH =
  process.env.DB_PATH || "file:data/wedding.stripe-webhook.test.db";
process.env.RESEND_API_KEY = "";
// Stripe debe estar "habilitado" para que el webhook no devuelva 503.
// La clave es falsa: solo se usa para firmar payloads de prueba en local.
process.env.STRIPE_SECRET_KEY = "sk_test_webhook_fake_key";
const WEBHOOK_SECRET = "whsec_test_webhook_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { default: app } = await import("../src/app.js");
const { default: db, initializationPromise } = await import("../src/db.js");
await initializationPromise;

const server = app.listen(0);
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/api`;

const stripeClient = new Stripe("sk_test_webhook_fake_key");

/** Firma un payload como lo haría Stripe. */
const sign = (payload, secret = WEBHOOK_SECRET) =>
  stripeClient.webhooks.generateTestHeaderString({ payload, secret });

/** Envía el payload al webhook con la cabecera de firma indicada. */
const post = async (rawBody, headers = {}) => {
  const response = await fetch(`${baseUrl}/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, text };
};

/** Evento `payment_intent.succeeded` con los datos mínimos. */
const succeededEvent = ({
  eventId = "evt_test_succeeded_1",
  intentId = "pi_test_1",
  userId = 1,
} = {}) => ({
  id: eventId,
  object: "event",
  api_version: "2024-06-20",
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: intentId,
      object: "payment_intent",
      amount: 5900,
      currency: "eur",
      status: "succeeded",
      payment_method_types: ["card"],
      metadata: { userId: String(userId) },
    },
  },
});

let username;
let userId;

/** Crea un usuario de pruebas y devuelve su id. */
const createUser = async () => {
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email: "webhookuser@test.com",
      password: "password123",
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text);
  return body.user.id;
};

test.before(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'webhookuser%'");
  await db.run("DELETE FROM webhook_events");
  username = `webhookuser${Date.now().toString().slice(-8)}`;
  userId = await createUser();
});

test.after(async () => {
  await db.run("DELETE FROM users WHERE username LIKE 'webhookuser%'");
  await db.run("DELETE FROM webhook_events");
  await new Promise((resolve) => server.close(resolve));
});

/** Lee el `paidAt` del usuario de pruebas. */
const readPaidAt = async () => {
  const row = await db.get("SELECT paidAt FROM users WHERE id = ?", [userId]);
  return row?.paidAt ?? null;
};

/** Deja al usuario de pruebas sin pago (para partir de un estado limpio). */
const resetPaidAt = async () => {
  await db.run("UPDATE users SET paidAt = NULL WHERE id = ?", [userId]);
};

// --------------------------------------------------------------------------
// 1. Verificación de la firma
// --------------------------------------------------------------------------

test("Una firma válida se acepta y marca el pago del usuario", async () => {
  const event = succeededEvent({
    eventId: "evt_valid_signature",
    intentId: "pi_valid",
    userId,
  });
  const payload = JSON.stringify(event);

  const res = await post(payload, { "stripe-signature": sign(payload) });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.received, true);
  assert.equal(res.body.duplicate, undefined, "No es un duplicado");

  const paidAt = await readPaidAt();
  assert.ok(paidAt, "El usuario debe quedar marcado como pagado");

  const row = await db.get(
    "SELECT status FROM webhook_events WHERE eventId = ?",
    ["evt_valid_signature"],
  );
  assert.equal(row?.status, "processed", "El evento queda registrado");
});

test("Una firma inválida se rechaza con 400 y no marca el pago", async () => {
  await resetPaidAt();
  const event = succeededEvent({
    eventId: "evt_invalid_signature",
    intentId: "pi_invalid",
    userId,
  });
  const payload = JSON.stringify(event);

  const res = await post(payload, {
    "stripe-signature": sign(payload, "whsec_secreto_del_atacante"),
  });

  assert.equal(res.status, 400, res.text);
  assert.equal(await readPaidAt(), null, "No debe marcar el pago");

  const row = await db.get(
    "SELECT status FROM webhook_events WHERE eventId = ?",
    ["evt_invalid_signature"],
  );
  assert.equal(row, undefined, "Un evento no firmado no se registra");
});

test("Sin cabecera stripe-signature se rechaza con 400", async () => {
  await resetPaidAt();
  const event = succeededEvent({
    eventId: "evt_no_signature",
    intentId: "pi_nosig",
    userId,
  });

  const res = await post(JSON.stringify(event));

  assert.equal(res.status, 400, res.text);
  assert.equal(await readPaidAt(), null, "No debe marcar el pago");
});

test("Un cuerpo alterado después de firmarlo se rechaza con 400", async () => {
  await resetPaidAt();
  const event = succeededEvent({
    eventId: "evt_tampered",
    intentId: "pi_tampered",
    userId,
  });
  const payload = JSON.stringify(event);
  const signature = sign(payload);

  // Se firma el payload original y se envía una versión manipulada.
  const tampered = JSON.stringify({
    ...event,
    data: {
      object: {
        ...event.data.object,
        amount: 1,
        metadata: { userId: "999" },
      },
    },
  });

  const res = await post(tampered, { "stripe-signature": signature });

  assert.equal(res.status, 400, res.text);
  assert.equal(await readPaidAt(), null, "No debe marcar el pago");
});

test("Sin STRIPE_WEBHOOK_SECRET se responde 500 y no se acepta el evento", async () => {
  await resetPaidAt();
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const event = succeededEvent({
      eventId: "evt_no_secret",
      intentId: "pi_nosecret",
      userId,
    });
    const payload = JSON.stringify(event);

    const res = await post(payload, { "stripe-signature": sign(payload) });

    assert.equal(res.status, 500, res.text);
    assert.equal(await readPaidAt(), null, "No debe marcar el pago");
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = previous;
  }
});

// --------------------------------------------------------------------------
// 2. Idempotencia
// --------------------------------------------------------------------------

test("La entrega duplicada del mismo evento se ignora", async () => {
  const event = succeededEvent({
    eventId: "evt_duplicate",
    intentId: "pi_duplicate",
    userId,
  });
  const payload = JSON.stringify(event);
  const signature = sign(payload);

  const first = await post(payload, { "stripe-signature": signature });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.duplicate, undefined);

  // Se marca el pago con un valor centinela: si la entrega duplicada se
  // procesara de verdad, lo sobrescribiría con la fecha actual.
  const sentinel = "2000-01-01T00:00:00.000Z";
  await db.run("UPDATE users SET paidAt = ? WHERE id = ?", [sentinel, userId]);

  const second = await post(payload, { "stripe-signature": signature });

  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.duplicate, true, "La segunda entrega es duplicada");
  assert.equal(
    await readPaidAt(),
    sentinel,
    "El duplicado no debe volver a procesar el evento",
  );

  const rows = await db.all(
    "SELECT eventId FROM webhook_events WHERE eventId = ?",
    ["evt_duplicate"],
  );
  assert.equal(rows.length, 1, "Solo debe existir una fila del evento");
});

test("Un fallo de procesamiento devuelve 500 y libera el claim", async () => {
  // Evento con `data.object` nulo: el handler revienta al leer el intent.
  const event = {
    id: "evt_processing_error",
    object: "event",
    type: "payment_intent.succeeded",
    data: { object: null },
  };
  const payload = JSON.stringify(event);

  const res = await post(payload, { "stripe-signature": sign(payload) });

  assert.equal(res.status, 500, res.text);
  assert.equal(res.body.received, false);

  const row = await db.get(
    "SELECT status FROM webhook_events WHERE eventId = ?",
    ["evt_processing_error"],
  );
  assert.equal(row, undefined, "El claim se libera para poder reintentar");
});

test("Tras un fallo, el reintento del mismo evento sí se procesa", async () => {
  // Mismo eventId que el test anterior, ahora con un payload válido:
  // Stripe reutiliza el id del evento en sus reintentos.
  const event = succeededEvent({
    eventId: "evt_processing_error",
    intentId: "pi_retry",
    userId,
  });
  const payload = JSON.stringify(event);

  const res = await post(payload, { "stripe-signature": sign(payload) });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.duplicate, undefined, "No debe saltarse el evento");
  assert.ok(await readPaidAt(), "El reintento debe marcar el pago");
});

test("Un evento repetido con otro id sí se procesa (pago distinto)", async () => {
  const event = succeededEvent({
    eventId: "evt_other_id",
    intentId: "pi_other",
    userId,
  });
  const payload = JSON.stringify(event);

  const res = await post(payload, { "stripe-signature": sign(payload) });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.duplicate, undefined);
});
