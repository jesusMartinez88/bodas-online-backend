import db from "../db.js";

/**
 * Modelo para la tabla `webhook_events` (idempotencia del webhook de Stripe).
 *
 * Stripe **reintenta** la entrega de un webhook cuando la respuesta no es
 * 2xx o la conexión falla, y lo puede hacer hasta 3 días después. Además, el
 * panel de Stripe permite reenviar un evento a mano. Sin un registro de
 * eventos procesados, cada reintento reenvía el email de "pago recibido" al
 * cliente y vuelve a marcar `paidAt`.
 *
 * Esta tabla guarda el `eventId` (único e inmutable en Stripe) como clave
 * primaria: el `INSERT OR IGNORE` es la operación atómica que decide si este
 * worker es el primero en procesar el evento.
 *
 * Estados:
 *   · `processing` → el evento está siendo procesado AHORA MISMO por un worker.
 *   · `processed`  → el evento se procesó correctamente. Las entregas
 *                    posteriores se ignoran (idempotencia).
 *
 * Si el procesamiento falla, el claim se libera (se borra la fila) para que
 * el reintento de Stripe pueda volver a procesarlo.
 */

/**
 * Minutos tras los que un claim en estado `processing` se considera
 * huérfano: el proceso que lo tomó murió a medias (deploy, OOM, caída de la
 * red) y nunca llegó a marcarlo como `processed`. Solo entonces otro worker
 * puede retomarlo, de modo que dos reintentos simultáneos de Stripe no
 * procesen el mismo evento a la vez.
 */
const STALE_CLAIM_MINUTES = 10;

/**
 * Intenta reclamar el procesamiento de un evento.
 *
 * @param {string} eventId  Identificador del evento (`evt_...`).
 * @param {string} type     Tipo del evento (`payment_intent.succeeded`...).
 * @returns {Promise<{claimed: boolean, reason: string}>}
 *   · `{claimed: true, reason: 'new'}` → este worker debe procesarlo.
 *   · `{claimed: false, reason: 'duplicate'}` → ya se procesó: se ignora.
 *   · `{claimed: false, reason: 'in-flight'}` → otro worker lo está
 *     procesando ahora mismo: se ignora.
 *   · `{claimed: true, reason: 'takeover'}` → el claim anterior caducó:
 *     este worker lo retoma.
 */
export const claimEvent = async (eventId, type) => {
  // 1) Intento de inserción: si la fila no existe, la creamos y es nuestro.
  const inserted = await db.run(
    `INSERT OR IGNORE INTO webhook_events (eventId, type, status)
     VALUES (?, ?, 'processing')`,
    [eventId, type],
  );
  if (inserted.changes > 0) {
    return { claimed: true, reason: "new" };
  }

  // 2) La fila ya existe: ¿la procesamos otra vez?
  const existing = await db.get(
    "SELECT eventId, type, status, updatedAt FROM webhook_events WHERE eventId = ?",
    [eventId],
  );

  if (!existing) {
    // La fila desapareció entre el INSERT y el SELECT (otro worker la
    // liberó). Reintentamos una vez el claim.
    const retry = await db.run(
      `INSERT OR IGNORE INTO webhook_events (eventId, type, status)
       VALUES (?, ?, 'processing')`,
      [eventId, type],
    );
    return retry.changes > 0
      ? { claimed: true, reason: "new" }
      : { claimed: false, reason: "in-flight" };
  }

  if (existing.status === "processed") {
    // Ya se procesó correctamente: entrega duplicada (reintento o reenvío
    // manual desde el panel de Stripe). No se vuelve a procesar.
    return { claimed: false, reason: "duplicate" };
  }

  // 3) Estado `processing`: el worker anterior murió a medias. Retomamos el
  //    claim solo si está caducado, para no procesar dos veces en paralelo.
  const takeover = await db.run(
    `UPDATE webhook_events
        SET type = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE eventId = ?
        AND status = 'processing'
        AND datetime(updatedAt) <= datetime('now', ?)`,
    [type, eventId, `-${STALE_CLAIM_MINUTES} minutes`],
  );
  if (takeover.changes > 0) {
    return { claimed: true, reason: "takeover" };
  }

  return { claimed: false, reason: "in-flight" };
};

/**
 * Marca el evento como procesado correctamente. A partir de este momento,
 * cualquier entrega duplicada se ignora.
 */
export const markEventProcessed = async (eventId) => {
  await db.run(
    `UPDATE webhook_events
        SET status = 'processed', updatedAt = CURRENT_TIMESTAMP
      WHERE eventId = ?`,
    [eventId],
  );
};

/**
 * Libera el claim tras un fallo de procesamiento.
 *
 * Se borra la fila (no se marca como fallida) para que el reintento de
 * Stripe pueda volver a procesar el evento desde cero. Si se conservara el
 * estado `failed`, el reintento se saltaría el evento y el pago se
 * perdería en silencio.
 */
export const releaseEvent = async (eventId) => {
  await db.run("DELETE FROM webhook_events WHERE eventId = ?", [eventId]);
};

/** Devuelve la fila del evento (o `undefined` si no existe). */
export const findEvent = async (eventId) => {
  return await db.get(
    "SELECT eventId, type, status, createdAt, updatedAt FROM webhook_events WHERE eventId = ?",
    [eventId],
  );
};

/**
 * Elimina los eventos procesados hace más de `days` días.
 *
 * La tabla crece muy despacio (un evento por pago), pero sin limpieza
 * acabaría siendo un almacén infinito de ids de Stripe.
 *
 * @param {number} days Antigüedad mínima en días (por defecto 30).
 */
export const purgeOldEvents = async (days = 30) => {
  const result = await db.run(
    `DELETE FROM webhook_events
      WHERE status = 'processed'
        AND datetime(updatedAt) <= datetime('now', ?)`,
    [`-${days} days`],
  );
  return result.changes;
};
