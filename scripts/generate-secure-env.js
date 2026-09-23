import crypto from 'crypto';
import fs from 'fs';

console.log("🔐 Generando configuración segura para .env\n");

// Generar JWT_SECRET seguro (256 bits)
const jwtSecret = crypto.randomBytes(32).toString('hex');

// Plantilla de .env
const envTemplate = `# ============================================
# CONFIGURACIÓN DE SEGURIDAD
# ============================================
# ⚠️  NUNCA COMMITEAR ESTE ARCHIVO A GIT
# ⚠️  CAMBIAR ESTOS VALORES EN PRODUCCIÓN

# JWT Secret (256 bits) - CAMBIAR EN PRODUCCIÓN
JWT_SECRET=${jwtSecret}

# El usuario admin por defecto (admin/admin) se crea automáticamente desde
# src/db.js en el primer arranque si no existe en la BD. La contraseña debe
# cambiarse en el primer login desde la app.

# ============================================
# CONFIGURACIÓN DE APLICACIÓN
# ============================================

# Puerto del servidor
PORT=3000

# Origen permitido para CORS (sin trailing slash)
ORIGIN_URL=http://localhost:4200

# Entorno (development | production)
NODE_ENV=development

# ============================================
# BASE DE DATOS (PRODUCCIÓN)
# ============================================
# Descomentar y configurar para usar Turso en producción

# TURSO_DATABASE_URL=libsql://your-database.turso.io
# TURSO_AUTH_TOKEN=your-auth-token-here

# ============================================
# BASE DE DATOS (LOCAL)
# ============================================
# Ruta a la base de datos SQLite local
DB_PATH=file:data/wedding.db

# ============================================
# EMAIL SERVICE (OPCIONAL)
# ============================================
# Descomentar si usas Resend para envío de emails

# RESEND_API_KEY=re_your_api_key_here
# RESEND_FROM_EMAIL=noreply@yourdomain.com

# ============================================
# AI SERVICE (OPCIONAL)
# ============================================
# Descomentar si usas OpenAI

# OPENAI_API_KEY=sk-your-openai-key-here
`;

console.log("📝 Contenido generado:\n");
console.log("━".repeat(60));
console.log(envTemplate);
console.log("━".repeat(60));

console.log("\n💾 ¿Deseas guardar esto en .env.example? (El archivo .env actual NO será modificado)");
console.log("\n📋 Valores generados:");
console.log(`   JWT_SECRET: ${jwtSecret}`);

// Guardar en .env.example
try {
  fs.writeFileSync('.env.example', envTemplate);
  console.log("\n✅ Archivo .env.example creado exitosamente");
  console.log("\n📝 Próximos pasos:");
  console.log("   1. Copia .env.example a .env");
  console.log("   2. Revisa y ajusta los valores según tu entorno");
  console.log("   3. En producción, genera nuevos valores con este script");
  console.log("   4. NUNCA commitees el archivo .env a git");
} catch (error) {
  console.error("\n❌ Error al crear .env.example:", error.message);
}

console.log("\n🔒 Recuerda:");
console.log("   - JWT_SECRET debe ser diferente en cada entorno");
console.log("   - El usuario admin por defecto es admin/admin; cámbialo en el primer login");
console.log("   - En producción, usa variables de entorno del hosting (no .env)");
