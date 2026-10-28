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
 *   · `sameSite`  → `none` por defecto. IMPORTANTE: `onrender.com` está en la
 *                   Public Suffix List (igual que `vercel.app`, `herokuapp.com`
 *                   o `pages.dev`), así que `tubodaonline.onrender.com` y
 *                   `boda-backend-4e6z.onrender.com` son **sitios distintos**
 *                   para el navegador: Chrome envía `sec-fetch-site:
 *                   cross-site` en las peticiones entre ellos.
 *
 *                   Consecuencia: con `SameSite=Lax` el navegador GUARDA la
 *                   cookie pero NO la envía en las XHR cross-site. La cookie se
 *                   quedaba guardada y, aun así, `/api/auth/me` respondía 401
 *                   siempre y la sesión moría sola en el primer `load`.
 *
 *                   Con `SameSite=None` la cookie sí viaja. La protección
 *                   frente a CSRF la aporta la verificación de `Origin` de
 *                   `middleware/csrf.js` (que ya está y cubre POST/PUT/PATCH/
 *                   DELETE), no el atributo `SameSite`.
 *   · `path=/`    → válida para toda la API.
 *
 * La vida de la cookie coincide con la del JWT (24 h).
 */

export const SESSION_COOKIE_NAME = "tb_session";

/** El JWT firmado dura 24 h: la cookie debe vivir lo mismo. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const isProduction = process.env.NODE_ENV === "production";

export const sessionCookieOptions = () => {
  const sameSite = process.env.COOKIE_SAME_SITE?.trim() || "none";
  // `SameSite=None` sin `Secure` hace que el navegador RECHACE la cookie
  // entera: no es opcional.
  const secure = sameSite.toLowerCase() === "none" ? true : isProduction;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: SESSION_TTL_MS,
    ...(process.env.COOKIE_DOMAIN?.trim()
      ? { domain: process.env.COOKIE_DOMAIN.trim() }
      : {}),
  };
};

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
