/**
 * Middleware de validación de entrada y de errores de parseo JSON.
 *
 * Objetivo (hallazgo #2 de la revisión de seguridad):
 *   `POST /api/auth/login` con body `{}` o con JSON roto devolvía 500.
 *   El 500 es un error del servidor ante una entrada de cliente inválida:
 *   lo correcto es 400 con un mensaje accionable.
 *
 * Dos piezas:
 *   1. `jsonErrorHandler` — convierte los errores de `express.json()` en 400.
 *   2. `validateBody`     — valida el body contra un esquema declarativo y
 *                           devuelve 400 si no cumple, sin llegar al controlador.
 */

/**
 * Errores de parseo del body → 400 en vez de 500.
 *
 * `express.json()` lanza un `SyntaxError` con `type: 'entity.parse.failed'`
 * y `status: 400` cuando el body no es JSON válido. Sin este middleware el
 * manejador global lo convertiría en 500, porque su único criterio es
 * `err.status || 500` y el `status` de body-parser no siempre llega intacto.
 *
 * Debe montarse INMEDIATAMENTE después de `express.json()`.
 */
export const jsonErrorHandler = (err, _req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON body",
      message: "El cuerpo de la petición no es JSON válido.",
    });
  }
  return next(err);
};

/**
 * @typedef {object} FieldRule
 * @property {'string'|'number'|'boolean'|'email'|'array'} [type]
 * @property {boolean} [required]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} [pattern]
 * @property {string} [message]  - Mensaje de error específico del campo.
 */

/**
 * Valida `req.body` contra un esquema declarativo.
 *
 * A diferencia de `express-validator`, no muta la request: devuelve 400
 * directamente si algo falla y deja pasar la request intacta si todo es
 * correcto. Mantiene el controlador limpio y garantiza que ningún handler
 * reciba tipos inesperados.
 *
 * @param {Record<string, FieldRule>} schema
 * @returns {import('express').RequestHandler}
 */
export const validateBody = (schema) => (req, res, next) => {
  const body = req.body;

  // `express.json()` deja `req.body` como `{}` cuando no hay body, pero si
  // el cliente envía `Content-Type: application/json` con un body no-objeto
  // (por ejemplo `"texto"` o `[1,2]`) puede llegar un valor que no es
  // objeto. En ese caso la validación falla con un mensaje claro.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      success: false,
      error: "Invalid request body",
      message: "El cuerpo de la petición debe ser un objeto JSON.",
    });
  }

  const errors = [];

  for (const [field, rule] of Object.entries(schema)) {
    const value = body[field];
    const label = field;

    const fail = (message) => {
      errors.push(rule.message ?? `${label}: ${message}`);
    };

    // --- requerido -------------------------------------------------------
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");

    if (rule.required && isEmpty) {
      fail("es obligatorio");
      continue;
    }

    // Si no es requerido y viene vacío, no hay nada más que validar.
    if (isEmpty) continue;

    // --- tipo ------------------------------------------------------------
    if (rule.type) {
      const typeOk = (() => {
        switch (rule.type) {
          case "string":
            return typeof value === "string";
          case "number":
            return typeof value === "number" && Number.isFinite(value);
          case "boolean":
            return typeof value === "boolean";
          case "array":
            return Array.isArray(value);
          case "email":
            return (
              typeof value === "string" &&
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
            );
          default:
            return true;
        }
      })();

      if (!typeOk) {
        fail(`debe ser de tipo ${rule.type}`);
        continue;
      }
    }

    // --- longitud --------------------------------------------------------
    if (typeof value === "string") {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        fail(`debe tener al menos ${rule.minLength} caracteres`);
        continue;
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        fail(`debe tener máximo ${rule.maxLength} caracteres`);
        continue;
      }
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
        fail("no tiene un formato válido");
        continue;
      }
    }

    // --- rango numérico --------------------------------------------------
    if (typeof value === "number") {
      if (rule.min !== undefined && value < rule.min) {
        fail(`debe ser mayor o igual que ${rule.min}`);
        continue;
      }
      if (rule.max !== undefined && value > rule.max) {
        fail(`debe ser menor o igual que ${rule.max}`);
        continue;
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      message: "Los datos enviados no son válidos.",
      errors,
    });
  }

  return next();
};
