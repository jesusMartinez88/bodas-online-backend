import { timingSafeEqual } from "node:crypto";

/**
 * Almacén en memoria de los códigos de confirmación exigidos para las
 * operaciones destructivas masivas (borrado de invitados / borrado de mesas).
 *
 * AISLAMIENTO POR TENANT
 * ----------------------
 * El estado se indexa por la clave `<purpose>:<userId>`, de modo que:
 *   - el código emitido a un tenant nunca habilita la operación de otro tenant;
 *   - el código de un tenant no invalida el código pendiente de otro tenant;
 *   - los códigos de "invitados" y de "mesas" son espacios de nombres
 *     independientes, de modo que pedir uno no inutiliza el otro.
 *
 * El estado vive en memoria del proceso: al reiniciar el servidor los códigos
 * pendientes se invalidan (comportamiento seguro por defecto).
 */

/** Propósitos (espacios de nombres) de los códigos de borrado masivo. */
export const DELETE_PURPOSE = {
  GUESTS: "guests",
  TABLES: "tables",
};

/** Validez del código: 15 minutos desde su emisión. */
const CODE_TTL_MS = 15 * 60 * 1000;

/** Intentos fallidos tolerados antes de invalidar el código del tenant. */
const MAX_ATTEMPTS = 5;

/** Tiempo mínimo entre dos envíos del mismo código al correo del tenant. */
const RESEND_COOLDOWN_MS = 60 * 1000;

/** userId+purpose -> { code, expiresAt, attempts, sentAt } */
const store = new Map();

const buildKey = (userId, purpose) => `${purpose}:${userId}`;

const generateCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/** Elimina las entradas ya expiradas para no retener memoria indefinidamente. */
const sweepExpired = () => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
};

/** Comparación en tiempo constante (evita filtrar el código por temporización). */
const safeCompare = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * Emite (o reutiliza) el código de confirmación de un tenant.
 *
 * Si el tenant ya tiene un código vigente se reutiliza el mismo, de forma que
 * solicitar un segundo código no invalida el primero.
 *
 * @param {number|string} userId tenant propietario
 * @param {string} purpose uno de DELETE_PURPOSE
 * @returns {{ code: string, expiresAt: number, shouldSendEmail: boolean }}
 */
export const issueDeleteCode = (userId, purpose) => {
  sweepExpired();

  const key = buildKey(userId, purpose);
  const now = Date.now();
  const existing = store.get(key);

  if (existing) {
    const shouldSendEmail = now - existing.sentAt >= RESEND_COOLDOWN_MS;
    return {
      code: existing.code,
      expiresAt: existing.expiresAt,
      shouldSendEmail,
    };
  }

  const expiresAt = now + CODE_TTL_MS;
  store.set(key, {
    code: generateCode(),
    expiresAt,
    attempts: 0,
    sentAt: 0,
  });

  return { code: store.get(key).code, expiresAt, shouldSendEmail: true };
};

/**
 * Marca el código del tenant como enviado, para no reenviarlo por correo en
 * cada petición (evita el envío masivo de emails a un mismo destino).
 */
export const markDeleteCodeSent = (userId, purpose) => {
  const entry = store.get(buildKey(userId, purpose));
  if (entry) {
    entry.sentAt = Date.now();
  }
};

/**
 * Valida y consume el código del tenant indicado.
 *
 * El código solo se valida contra el del propio tenant: el de otro tenant no
 * existe en su espacio de nombres, por lo que nunca se acepta.
 *
 * @param {number|string} userId tenant que presenta el código
 * @param {string} purpose uno de DELETE_PURPOSE
 * @param {unknown} code código presentado
 * @returns {{ ok: true } | { ok: false, reason: "missing" | "invalid" | "expired" }}
 */
export const consumeDeleteCode = (userId, purpose, code) => {
  if (!code) return { ok: false, reason: "missing" };

  const key = buildKey(userId, purpose);
  const entry = store.get(key);

  if (!entry) return { ok: false, reason: "invalid" };

  if (!safeCompare(entry.code, code)) {
    entry.attempts += 1;
    if (entry.attempts >= MAX_ATTEMPTS) {
      // Demasiados intentos: el código queda invalidado y hay que pedir otro.
      store.delete(key);
    }
    return { ok: false, reason: "invalid" };
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return { ok: false, reason: "expired" };
  }

  store.delete(key);
  return { ok: true };
};

/** Descarta el código pendiente del tenant (sin consumarlo). */
export const clearDeleteCode = (userId, purpose) => {
  store.delete(buildKey(userId, purpose));
};
