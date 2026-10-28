/**
 * Protección CSRF por verificación de `Origin`.
 *
 * ¿Por qué hace falta si la cookie es `SameSite=None`?
 * Porque `SameSite` depende de la topología y aquí NO protege:
 *   · `onrender.com` está en la Public Suffix List, así que el frontend
 *     (`tubodaonline.onrender.com`) y el backend
 *     (`boda-backend-4e6z.onrender.com`) son **sitios distintos** para el
 *     navegador. La cookie de sesión necesita `SameSite=None` para viajar en
 *     las XHR, y con `SameSite=None` un sitio de terceros **sí** puede
 *     enviarla.
 *   · Por eso esta verificación de `Origin` es la que protege de verdad, no
 *     el atributo `SameSite`.
 *
 * La verificación de `Origin` no requiere estado en servidor:
 *   · Los navegadores **siempre** envían `Origin` en POST/PUT/PATCH/DELETE.
 *   · Una petición CSRF desde otro sitio lleva el `Origin` del atacante, que
 *     no está en la lista de permitidos → 403.
 *   · Las peticiones que no vienen de un navegador (curl, apps móviles,
 *     servidor a servidor, el webhook de Stripe) no llevan `Origin` → se
 *     permiten. Esa combinación (cookie + cabecera `Authorization` explícita)
 *     no es susceptible a CSRF.
 */

import {
  allowedOrigins as sharedAllowedOrigins,
  isAllowedOrigin,
} from "../config/origins.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Orígenes permitidos a hacer peticiones mutantes.
 *
 * La lista es la misma que usa el CORS (`src/config/origins.js`): `ORIGIN_URL`
 * más los extras de `ALLOWED_ORIGINS`. Que los dos controles compartan la
 * allowlist evita que el CORS deje pasar una petición que el CSRF bloquea
 * (o al revés).
 */
const allowedOrigins = () => sharedAllowedOrigins();

export const verifyOrigin = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const origin = req.headers.origin;

  // Sin `Origin` no es una petición de navegador: no hay CSRF que evitar.
  if (!origin) {
    return next();
  }

  if (isAllowedOrigin(origin)) {
    return next();
  }

  console.warn(
    `[security] CSRF blocked: ${req.method} ${req.originalUrl} from origin "${origin}"`,
  );

  return res.status(403).json({
    success: false,
    message: "Origin not allowed",
  });
};

export { allowedOrigins };
