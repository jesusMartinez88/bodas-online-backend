/**
 * Política de la cookie de sesión.
 *
 * El JWT **no** se guarda en `localStorage` (accesible desde cualquier XSS).
 * Viaja en una cookie `httpOnly`, que el JavaScript de la página no puede
 * leer, y el navegador envía solo al dominio de la API.
 *
 * Atributos:
 *   · `httpOnly`  → invisible para `document.cookie`. Un XSS no puede leerla.
 *   · `secure`    → solo por HTTPS (siempre activo en producción).
 *   · `sameSite`  → `lax` por defecto. Los dos hosts (`tubodaonline.onrender.com`
 *                   y `boda-backend-4e6z.onrender.com`) comparten sitio
 *                   (eTLD+1 = `onrender.com`), así que la cookie viaja en las
 *                   XHR cross-origin. Si el frontend pasa a un dominio propio
 *                   habría que poner `none` (y entonces la verificación de
 *                   `Origin` de `middleware/csrf.js` es la que protege).
 *   · `path=/`    → válida para toda la API.
 *
 * La vida de la cookie coincide con la del JWT (24 h).
 */

export const SESSION_COOKIE_NAME = "tb_session";

/** El JWT firmado dura 24 h: la cookie debe vivir lo mismo. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const isProduction = process.env.NODE_ENV === "production";

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: process.env.COOKIE_SAME_SITE?.trim() || "lax",
  path: "/",
  maxAge: SESSION_TTL_MS,
  ...(process.env.COOKIE_DOMAIN?.trim()
    ? { domain: process.env.COOKIE_DOMAIN.trim() }
    : {}),
});

/** Emite la cookie de sesión con el token indicado. */
export const setSessionCookie = (res, token) => {
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
};

/** Elimina la cookie de sesión (al cerrar sesión). */
export const clearSessionCookie = (res) => {
  // `clearCookie` no admite `maxAge`: los atributos deben coincidir con los
  // de la cookie que se quiere borrar.
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE_NAME, options);
};
