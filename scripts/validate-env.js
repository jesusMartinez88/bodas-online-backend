import crypto from 'crypto';

// Cargar variables de entorno
try {
  process.loadEnvFile();
} catch (e) {
  console.error("❌ No se pudo cargar .env");
}

console.log("🔒 Validando configuración de seguridad...\n");

// 1. Verificar JWT_SECRET
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  console.error("❌ CRÍTICO: JWT_SECRET no está definido en .env");
  console.log("\n💡 Genera uno con:");
  console.log("   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

if (jwtSecret.length < 32) {
  console.error(`❌ CRÍTICO: JWT_SECRET es muy corto (${jwtSecret.length} caracteres)`);
  console.log("   Debe tener al menos 32 caracteres (256 bits)");
  console.log("\n💡 Genera uno nuevo con:");
  console.log("   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

// Verificar que no sea un valor débil común
const weakSecrets = [
  'secret', 'password', '123456', 'admin', 'test', 'development',
  'mysecret', 'jwt_secret', 'your_secret_here', 'change_me'
];

if (weakSecrets.some(weak => jwtSecret.toLowerCase().includes(weak))) {
  console.error("❌ CRÍTICO: JWT_SECRET parece ser un valor débil o de ejemplo");
  console.log("\n💡 Genera uno seguro con:");
  console.log("   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

console.log(`✅ JWT_SECRET: ${jwtSecret.length} caracteres (seguro)`);

// 2. Verificar ORIGIN_URL
const originUrl = process.env.ORIGIN_URL;

if (!originUrl) {
  console.warn("⚠️  ORIGIN_URL no está definido (usando default: http://localhost:4200)");
} else {
  if (originUrl.endsWith('/')) {
    console.warn("⚠️  ORIGIN_URL tiene trailing slash - puede causar problemas con CORS");
    console.log(`   Actual: ${originUrl}`);
    console.log(`   Debería ser: ${originUrl.slice(0, -1)}`);
  } else {
    console.log(`✅ ORIGIN_URL: ${originUrl}`);
  }
}

// 3. Verificar NODE_ENV
const nodeEnv = process.env.NODE_ENV;

if (!nodeEnv) {
  console.warn("⚠️  NODE_ENV no está definido (usando default: development)");
} else {
  console.log(`✅ NODE_ENV: ${nodeEnv}`);
  
  if (nodeEnv === 'production') {
    console.log("\n🔒 Modo PRODUCCIÓN detectado - verificaciones adicionales:");
    
    // En producción, verificar que no se usen valores de desarrollo
    if (originUrl && originUrl.includes('localhost')) {
      console.error("❌ ORIGIN_URL apunta a localhost en producción!");
    }
    
    if (!process.env.TURSO_DATABASE_URL) {
      console.warn("⚠️  TURSO_DATABASE_URL no está definido (usando SQLite local)");
    } else {
      console.log("✅ TURSO_DATABASE_URL configurado");
    }
    
    if (!process.env.TURSO_AUTH_TOKEN) {
      console.warn("⚠️  TURSO_AUTH_TOKEN no está definido");
    } else {
      console.log("✅ TURSO_AUTH_TOKEN configurado");
    }
  }
}

console.log("\n✅ Validación completada");

// Generar un nuevo JWT_SECRET de ejemplo
console.log("\n💡 Para generar un nuevo JWT_SECRET seguro, ejecuta:");
console.log("   node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
console.log("\n   Ejemplo generado ahora:");
console.log(`   ${crypto.randomBytes(32).toString('hex')}`);
