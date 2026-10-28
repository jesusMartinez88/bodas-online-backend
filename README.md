# Boda Backend API

API REST para gestionar invitados de boda con funcionalidades de RSVP, transporte, alergias y preferencias.

## Características

- ✅ Gestión completa de invitados
- 🚌 Control de requerimientos de transporte
- 🥗 Registro de intolerancias y alergias
- 👨‍👩‍👧‍👦 Confirmación de asistencia
- 📊 Estadísticas de invitados
- 🔍 Búsqueda y filtrado avanzado

## Instalación

```bash
npm install
```

## Configuración

Crear archivo `.env` en la raíz del proyecto:

```
PORT=3000
NODE_ENV=development
DB_PATH=./data/wedding.db
```

### Envío de emails (Resend)

```
RESEND_API_KEY=re_your_api_key_here
RESEND_FROM_EMAIL="Tu Boda Online <codigo@tu-dominio>"
```

`RESEND_FROM_EMAIL` es **opcional**, pero sin ella el remitente por defecto es
`onboarding@resend.dev`, el dominio de prueba de Resend: ese dominio **solo
permite enviar al email del titular de la cuenta**, así que cualquier otro
tenant se queda sin recibir los correos (confirmación de invitado, invitaciones
y código de borrado masivo).

Para que el correo funcione para todos, hay que verificar un dominio propio en
<https://resend.com/domains> y fijar `RESEND_FROM_EMAIL` con ese remitente.

### Sesión y orígenes permitidos

```
# Origen principal del frontend (CORS + protección CSRF)
ORIGIN_URL=https://tubodaonline.onrender.com

# Orígenes adicionales separados por comas (opcional)
ALLOWED_ORIGINS=https://panel.tubodaonline.com,https://www.tubodaonline.com

# Política de la cookie de sesión (opcional)
COOKIE_SAME_SITE=none
# COOKIE_DOMAIN=.tubodaonline.com
```

La sesión viaja en una cookie `httpOnly` (`tb_session`), no en `localStorage`.

`COOKIE_SAME_SITE` debe ser `none` mientras frontend y backend estén en
dominios de Render: **`onrender.com` está en la Public Suffix List**, así que
`tubodaonline.onrender.com` y `boda-backend-4e6z.onrender.com` son sitios
**distintos** para el navegador (Chrome envía `sec-fetch-site: cross-site`).
Con `lax` el navegador guarda la cookie pero no la envía en las XHR, y la
sesión muere en la primera llamada a `/api/auth/me`. `none` exige `Secure`
—que ya se fuerza en producción— y la protección frente a CSRF la aporta la
verificación de `Origin`, no el atributo `SameSite`.

Si el frontend pasa a un dominio propio (mismo registrable para ambos hosts),
el valor puede volver a `lax`, y ese origen conviene añadirlo a
`ALLOWED_ORIGINS`.

### Pagos (Stripe)

```
STRIPE_SECRET_KEY=sk_test_...          # clave privada del servidor
STRIPE_PUBLISHABLE_KEY=pk_test_...      # clave pública para el navegador
STRIPE_WEBHOOK_SECRET=whsec_...         # secreto de firma del webhook
```

`STRIPE_WEBHOOK_SECRET` es **obligatorio** para que el webhook funcione: sin
él el backend responde `500` a propósito y no acepta ningún evento (es
preferible a aceptar eventos sin verificar).

En el panel de Stripe hay que crear el endpoint
`https://<tu-backend>/api/payments/webhook` con los eventos
`payment_intent.succeeded`, `payment_intent.processing`,
`payment_intent.payment_failed` y `payment_intent.canceled`, y copiar el
`whsec_…` a `STRIPE_WEBHOOK_SECRET`.

El webhook **verifica la firma** sobre el cuerpo crudo de la petición
(`stripe.webhooks.constructEvent`) y es **idempotente**: cada evento se
reclama en la tabla `webhook_events` por su `eventId`, de modo que los
reintentos de Stripe no reprocesan el pago ni reenvían el email de
confirmación. Si el procesamiento falla, se devuelve `500` (y se libera el
reclamo) para que Stripe reintente. Detalle completo en `SECURITY.md` §11.

## Uso

Modo desarrollo:

```bash
npm run dev
```

Modo producción:

```bash
npm start
```

## Estructura del Proyecto

```
src/
├── index.js              # Punto de entrada
├── db.js                 # Inicialización de BD
├── routes/
│   └── guests.js         # Rutas de invitados
├── controllers/
│   └── guestController.js # Controladores de invitados
└── models/
    └── guest.js          # Modelo de invitado
data/
└── wedding.db            # Base de datos SQLite
```

## API Endpoints

### Invitados

- `GET /api/guests` - Obtener todos los invitados
- `GET /api/guests/:id` - Obtener invitado específico
- `POST /api/guests` - Crear nuevo invitado
- `PUT /api/guests/:id` - Actualizar invitado
- `DELETE /api/guests/:id` - Eliminar invitado
- `POST /api/guests/request-delete` - **Solicitar código de confirmación** para borrado masivo; el código llega por email al propietario.
- `DELETE /api/guests?code=<6 dígitos>` - Eliminar **todos** los invitados con el código válido (autenticado). Reinicia el contador autoincrement.

### Mesas

- `GET /api/tables` - Obtener todas las mesas
- `GET /api/tables/:id` - Obtener mesa específica
- `POST /api/tables` - Crear nueva mesa
- `PATCH /api/tables/:id` - Actualizar mesa
- `DELETE /api/tables/:id` - Eliminar mesa
- `POST /api/tables/request-delete` - **Solicitar código de confirmación** para borrado masivo de mesas; el código llega por email al propietario (en desarrollo también se retorna en la respuesta).
- `DELETE /api/tables?code=<6 dígitos>` - Eliminar **todas** las mesas con el código válido (autenticado). Desasigna los invitados de las mesas y reinicia el contador autoincrement.

### Estadísticas

- `GET /api/stats` - Obtener estadísticas generales
- `GET /api/stats/attendance` - Estadísticas de asistencia
- `GET /api/stats/transportation` - Estadísticas de transporte
- `GET /api/stats/allergies` - Estadísticas de alergias

### Playlist de música (JWT requerido)

- `GET /api/music-playlist` - Lista canciones ordenadas por `order_index`
- `POST /api/music-playlist` - Crea canción y autocalcula `youtube_id` + orden final
- `PATCH /api/music-playlist/:id` - Actualización parcial de canción
- `DELETE /api/music-playlist/:id` - Elimina canción por id
- `PUT /api/music-playlist/reorder` - Reordena canciones en transacción

Formato de respuesta uniforme:

```json
{
  "success": true,
  "data": {}
}
```

```json
{
  "success": false,
  "message": "Validation error",
  "code": "VALIDATION_ERROR"
}
```

Ejemplos `curl`:

```bash
curl -X POST "{{API_BASE_URL}}/api/music-playlist" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Perfect",
    "artist": "Ed Sheeran",
    "youtube_url": "https://www.youtube.com/watch?v=2Vv-BfVoq4g",
    "note": "Baile principal"
  }'
```

```bash
curl -X PUT "{{API_BASE_URL}}/api/music-playlist/reorder" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "songs": [
      { "id": 4, "order": 0 },
      { "id": 1, "order": 1 }
    ]
  }'
```

Notas:

- En local usa `DB_PATH` (`file:data/wedding.db` por defecto).
- En producción usa `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.
- Además, `src/db.js` crea la tabla automáticamente con `CREATE TABLE IF NOT EXISTS` para mantener compatibilidad incremental.

### Pagos (Stripe)

- `GET /api/payments/config` - Clave publicable y flags de habilitación (público)
- `POST /api/payments/create-intent` - Crea el PaymentIntent (JWT requerido)
- `POST /api/payments/create-checkout-session` - Crea una Checkout Session alojada (JWT requerido)
- `POST /api/payments/validate-discount` - Valida un código de descuento (JWT requerido)
- `GET /api/payments/me` - Historial de pagos del usuario (JWT requerido)
- `POST /api/payments/webhook` - **Endpoint público de Stripe.** Verifica la firma (`stripe-signature`) sobre el cuerpo crudo, es idempotente por `eventId` y devuelve `500` si el procesamiento falla, para que Stripe reintente

## Ejemplo de Respuesta

```json
{
  "id": 1,
  "name": "Juan García",
  "email": "juan@example.com",
  "phone": "123456789",
  "attending": true,
  "mealType": "normal",
  "needsTransport": true,
  "allergies": "Lactosa",
  "notes": "Vegano",
  "createdAt": "2025-01-25T10:00:00Z"
}
```
