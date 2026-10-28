/**
 * Allowlist de orígenes del frontend.
 *
 * La usan **dos** controles que tienen que estar de acuerdo:
 *   · El CORS (`src/app.js`): decide si la respuesta lleva
 *     `Access-Control-Allow-Origin`. Con `credentials: true` el valor debe ser
 *     el origen exacto de la petición, nunca `*`.
 *   · La protección CSRF (`src/middleware/csrf.js`): decide si una petición
 *     que muta estado viene de un origen de confianza.
 *
 * Si cada uno usara su propia lista, el CORS dejaría pasar (o bloquearía) una
 * petición que el CSRF_blockearía (o dejaría pasar). Un solo sitio, una sola
 * lista.
 *
 * Variables de entorno:
 *   · `ORIGIN_URL`       → el origen principal del frontend.
 *   · `ALLOWED_ORIGINS`  → orígenes adicionales separados por comas (por
 *                          ejemplo, un dominio propio o un panel de admin).
 */

const normalize = (origin) => origin.trim().replace(/\/+$/, "");

/** Orígenes permitidos, sin duplicados y sin vacíos. */
export const allowedOrigins = () => {
  const origins = new Set();

  const primary = process.env.ORIGIN_URL?.trim();
  if (primary) origins.add(normalize(primary));

  const extra = process.env.ALLOWED_ORIGINS?.trim();
  if (extra) {
    for (const origin of extra.split(",")) {
      const trimmed = normalize(origin);
      if (trimmed) origins.add(trimmed);
    }
  }

  // En desarrollo, si no hay nada configurado, se permite el frontend local.
  if (!origins.size && process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:4200");
  }

  return [...origins];
};

/** ¿Este origen concreto está permitido? */
export const isAllowedOrigin = (origin) => {
  if (!origin) return true; // peticiones sin Origin (CLI, apps, webhook)
  return allowedOrigins().includes(normalize(origin));
};
