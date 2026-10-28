import "./env.js";
import express from "express";
import cors from "cors";
import * as Visit from "./models/visit.js";
import guestRoutes from "./routes/guests.js";
import statsRoutes from "./routes/stats.js";
import authRoutes from "./routes/auth.js";
import settingsRoutes from "./routes/settings.js";
import tableRoutes from "./routes/tables.js";
import financeRoutes from "./routes/finances.js";
import todoRoutes from "./routes/todos.js";
import aiRoutes from "./routes/ai.js";
import contactRoutes from "./routes/contacts.js";
import contactMessageRoutes from "./routes/contact-message.js";
import categoryRoutes from "./routes/categories.js";
import musicPlaylistRoutes from "./routes/music-playlist.routes.js";
import userRoutes from "./routes/users.js";
import adminRoutes from "./routes/admin.js";
import landingQuestionnaireRoutes from "./routes/landingQuestionnaire.js";
import invitationMediaRoutes from "./routes/invitation-media.js";
import paymentRoutes from "./routes/payment.js";
import { MEDIA_ROOT } from "./constants/media.js";
import { initializeEmailService } from "./services/emailService.js";
import { initializeWhatsAppService } from "./services/whatsappService.js";
import { initializeStripeService } from "./services/stripeService.js";
import { initializeDiscountService } from "./services/discountService.js";
import helmet from "helmet";
import multer from "multer";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import compression from "compression";
import { jsonErrorHandler } from "./middleware/validation.js";
import { cookieParser } from "./middleware/cookies.js";
import { verifyOrigin } from "./middleware/csrf.js";
import { isAllowedOrigin } from "./config/origins.js";
import { SESSION_COOKIE_NAME } from "./services/sessionCookie.js";
import { logError } from "./utils/logger.js";

const app = express();

initializeEmailService();
initializeWhatsAppService();
initializeStripeService();
initializeDiscountService();

const isProduction = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy del backend.
 *
 * IMPORTANTE: al pasar `directives` a Helmet, los valores por defecto
 * **se reemplazan**, no se fusionan. Los que faltaban aquí eran:
 * `base-uri`, `form-action`, `frame-ancestors`, `script-src-attr` y
 * `upgrade-insecure-requests`.
 *
 * La allowlist de Stripe sigue la documentación oficial
 * (https://docs.stripe.com/security/guide):
 *   · `https://*.js.stripe.com` en script-src/frame-src permite que Stripe.js
 *     arranque frames en orígenes distintos.
 *   · `https://q.stripe.com` en connect-src es el origen al que Stripe.js
 *     hace XHR.
 *   · `https://*.3dsecure.io` en frame-src cubre el caso en que el challenge
 *     3-D Secure se embeba en un iframe de la propia página (no es el flujo
 *     actual del frontend, que usa `redirect: 'if_required'`).
 *
 * El backend sirve sobre todo JSON y medios; esta CSP protege las respuestas
 * que el navegador carga directamente desde aquí.
 */
const contentSecurityPolicyDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
  scriptSrc: ["'self'", "https://js.stripe.com", "https://*.js.stripe.com"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  fontSrc: ["'self'", "data:"],
  imgSrc: ["'self'", "data:", "https://*.stripe.com"],
  mediaSrc: ["'self'"],
  connectSrc: ["'self'", "https://api.stripe.com", "https://q.stripe.com"],
  frameSrc: [
    "'self'",
    "https://js.stripe.com",
    "https://*.js.stripe.com",
    "https://hooks.stripe.com",
    "https://*.3dsecure.io",
  ],
  upgradeInsecureRequests: [],
};

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicyDirectives,
    },
    hsts: isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: false,
        }
      : false,
  }),
);

app.use(
  compression({
    filter: (req, res) => {
      if (req.originalUrl?.includes("/api/ai")) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

/**
 * Clasifica la petición en uno de los dos buckets del limitador.
 * Se memoiza en el propio `req` para no verificar la firma dos veces
 * (`max` y `keyGenerator` se evalúan por separado).
 */
const AUTH_BUCKET = Symbol("authBucket");
const resolveAuthBucket = (req) => {
  if (req[AUTH_BUCKET]) return req[AUTH_BUCKET];

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;
  // La sesión del navegador viaja en la cookie `httpOnly`, así que también
  // cuenta como petición autenticada.
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  const token = bearerToken || cookieToken;

  let authenticated = false;
  if (token && process.env.JWT_SECRET) {
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      authenticated = true;
    } catch {}
  }

  req[AUTH_BUCKET] = authenticated ? "auth" : "pub";
  return req[AUTH_BUCKET];
};

/**
 * Limitador general de la API.
 *
 * Dos contadores INDEPENDIENTES por IP:
 *   - `auth:<ip>` → peticiones con un JWT válido (límite 500 / 15 min).
 *   - `pub:<ip>`  → peticiones sin token válido (límite 300 / 15 min).
 *
 * Antes ambos compartían el mismo contador mientras el umbral dependía de si
 * la petición llevaba token. Eso producía dos problemas:
 *   1. Acoplamiento: el tráfico público de una IP agotaba la cuota del tráfico
 *      autenticado de esa misma IP (y al revés), de modo que un visitante
 *      anónimo podía provocar 429 a un usuario legítimo.
 *   2. Con CGNAT (móviles, redes corporativas) miles de invitados de una boda
 *      comparten IP pública: un límite de 100/15 min bloqueaba la web de
 *      invitaciones en eventos grandes.
 *
 * El bucket se elige por la validez del token, no por la presencia de la
 * cabecera: un token caducado o manipulado cuenta como tráfico público.
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (resolveAuthBucket(req) === "auth" ? 500 : 300),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // `ipKeyGenerator` espera un string (la IP), no el Request. Hay que extraerla.
  // Si se le pasa `req` directamente, lo devuelve tal cual y el hash de
  // `setDraft8Headers` revienta con ERR_INVALID_ARG_TYPE.
  keyGenerator: (req) =>
    `${resolveAuthBucket(req)}:${ipKeyGenerator(req.ip)}`,
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
});

// (Los limiters de /api/auth se aplican dentro de src/routes/auth.js:
//  authLimiter a login/register, checkUsernameLimiter a check-username.)

const corsOptions = {
  // Con `credentials: true` el navegador exige que `Access-Control-Allow-Origin`
  // sea el origen EXACTO de la petición (nunca `*`). La lista de orígenes
  // permitidos es la misma que usa la protección CSRF
  // (`src/config/origins.js`): así los dos controles no se contradicen.
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    console.warn(`[security] CORS blocked origin "${origin}"`);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true,
};

app.set("trust proxy", 1);
app.use(cors(corsOptions));
// `verify` captura el cuerpo crudo para que el handler del webhook de
// Stripe pueda validar la firma. Express ya habrá parseado el JSON
// para el resto de rutas (no afecta a su funcionamiento).
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// El token de sesión viaja en una cookie `httpOnly`. El parser va antes de
// cualquier ruta que use `authenticateJWT`.
app.use(cookieParser);
// Un body con JSON inválido es un error del cliente, no del servidor:
// sin este middleware `express.json()` lanza un SyntaxError que acaba en el
// manejador global como 500. Con él, la respuesta es 400.
app.use(jsonErrorHandler);
// Protección CSRF: las peticiones que mutan estado deben venir de un origen
// permitido. Solo afecta a las peticiones de navegador (las que llevan
// `Origin`); el webhook de Stripe y los clientes no navegador no lo envían.
app.use("/api/", verifyOrigin);
app.use(
  "/media/photos",
  (req, res, next) => {
    // Helmet sets Cross-Origin-Resource-Policy: same-origin by default, which blocks
    // cross-origin image loads (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin).
    // Override it to allow the frontend (different port/origin) to load these assets.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(MEDIA_ROOT, { index: false, fallthrough: false, maxAge: 0 }),
);
app.use("/api/", generalLimiter);

app.get("/health", (req, res) => {
  // Trackear visita única por IP: fire-and-forget, nunca bloquea la respuesta.
  // Solo registra si el request viene con el header x-app-visit que el frontend
  // envía al arrancar, evitando que pings de monitorización externos cuenten.
  if (req.headers["x-app-visit"] === "1") {
    const ip = req.ip ?? "unknown";
    const ua = req.headers["user-agent"] ?? null;
    Visit.track(ip, ua).catch((err) => {
      console.warn("[health] visit track failed:", err?.message);
    });
  }
  res.json({ status: "OK", message: "Wedding API is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/table", tableRoutes);
app.use("/api/guests", guestRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/finances", financeRoutes);
app.use("/api/todos", todoRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/contact-message", contactMessageRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/music-playlist", musicPlaylistRoutes);
app.use("/api/users", userRoutes);
app.use("/api/landing-questionnaire", landingQuestionnaireRoutes);
app.use("/api/invitation-media", invitationMediaRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.path,
  });
});

app.use((err, req, res, next) => {
  logError(`Error in ${req.method} ${req.path}`, err);

  const production = process.env.NODE_ENV === "production";

  // Errores de multer: tamaño máximo o número de archivos. Son errores del
  // cliente, no del servidor: devuelven 413/400 en vez de un 500.
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      success: false,
      error: err.code === "LIMIT_FILE_SIZE" ? "File is too large" : "Invalid upload",
      message:
        err.code === "LIMIT_FILE_SIZE"
          ? "The file exceeds the maximum allowed size"
          : "Invalid upload",
    });
  }

  // Un error con `status` 4xx lo ha generado el propio backend (validación de
  // contenido, MIME no admitido, etc.): el mensaje es para el cliente y no
  // filtra nada del servidor, así que se devuelve tal cual.
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 400 && status < 500) {
    return res.status(status).json({
      success: false,
      error: err.message || "Bad request",
      ...(production ? {} : { stack: err.stack }),
    });
  }

  res.status(500).json({
    success: false,
    error: "Internal server error",
    ...(production ? {} : { message: err.message, stack: err.stack }),
  });
});

export default app;
