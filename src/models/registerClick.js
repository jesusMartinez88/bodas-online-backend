import db from "../db.js";

/**
 * Registra un click único en un CTA "Registrar" de la landing.
 * Deduplicado por IP en las últimas 24 h para no inflar la métrica con
 * dobles-clicks accidentales del mismo visitante.
 *
 * @param {string} ip     - IP del visitante (ya normalizada por Express).
 * @param {string} [ua]   - User-Agent (opcional).
 * @param {string} [src]  - Origen del click (`header` / `hero` / `pricing` /
 *                          `final` / `footer`). Sirve para análisis futuro;
 *                          no se deduplica por origen, solo por IP.
 */
export const track = async (ip, ua = null, src = null) => {
  const recent = await db.get(
    `SELECT id FROM register_clicks
     WHERE ip = ? AND clickedAt >= datetime('now', '-24 hours')
     LIMIT 1`,
    [ip],
  );
  if (recent) return;

  await db.run(
    `INSERT INTO register_clicks (ip, userAgent, source) VALUES (?, ?, ?)`,
    [ip, ua, src],
  );
};

/**
 * Estadísticas globales de clicks en CTAs de registro:
 *   - totalClicks → total histórico de IPs únicas registradas
 *   - todayClicks → IPs únicas en las últimas 24 h
 *   - weekClicks  → IPs únicas en los últimos 7 días
 *   - lastClickAt → timestamp del click más reciente
 */
export const getStats = async () => {
  const [total, today, week, last] = await Promise.all([
    db.get(`SELECT COUNT(*) AS n FROM register_clicks`),
    db.get(
      `SELECT COUNT(*) AS n FROM register_clicks WHERE clickedAt >= datetime('now', '-24 hours')`,
    ),
    db.get(
      `SELECT COUNT(*) AS n FROM register_clicks WHERE clickedAt >= datetime('now', '-7 days')`,
    ),
    db.get(`SELECT MAX(clickedAt) AS t FROM register_clicks`),
  ]);

  return {
    totalClicks: Number(total?.n ?? 0),
    todayClicks: Number(today?.n ?? 0),
    weekClicks: Number(week?.n ?? 0),
    lastClickAt: last?.t ?? null,
  };
};