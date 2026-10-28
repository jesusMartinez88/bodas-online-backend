/**
 * Parser mínimo de cookies.
 *
 * La API solo necesita leer su propia cookie de sesión, así que no hace falta
 * `cookie-parser` (y su dependencia transitiva) para un caso tan acotado.
 *
 * Nota de seguridad: este parser NO descifra ni valida nada. Solo separa los
 * pares `clave=valor`. El valor de la cookie de sesión es un JWT, que
 * después verifica `middleware/auth.js` con la firma; un valor manipulado
 * simplemente no valida.
 */

const parseCookieHeader = (header) => {
  const cookies = {};
  if (!header || typeof header !== "string") return cookies;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    if (!name) continue;

    const raw = part.slice(separator + 1).trim();
    let value = raw;
    // El valor puede venir percent-encoded. Si no es válido, se usa tal cual
    // (un cookie corrupto no debe romper la petición).
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    cookies[name] = value;
  }

  return cookies;
};

/** Middleware que expone `req.cookies`. */
export const cookieParser = (req, res, next) => {
  req.cookies = parseCookieHeader(req.headers.cookie);
  next();
};

export { parseCookieHeader };
