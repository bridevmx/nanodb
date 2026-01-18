const db = require('./core/db');
const schemaManager = require('./core/schema');
const engine = require('./core/engine');

async function bootstrap() {
  console.log('⚡ Bootstrapping NanoDB...');

  // SOLUCIÓN: Verificar directamente en la DB sin reglas de seguridad
  let hasAdmin = false;

  // Escanear directamente la colección _superusers
  const prefix = '_superusers:';
  for (const { key } of db.main.getRange({
    start: prefix,
    end: prefix + '\xFF',
    limit: 1
  })) {
    hasAdmin = true;
    break;
  }

  if (!hasAdmin) {
    console.log('⚠️  No admins found. Creating default root user...');

    try {
      // Crear admin directamente (bypass de engine para evitar reglas)
      const { nanoid } = require('nanoid');
      const bcrypt = require('bcryptjs');
      const now = new Date().toISOString();

      const adminRecord = {
        id: nanoid(15),
        email: 'admin@local.host',
        password: await bcrypt.hash('password123', 10),
        verified: true,
        created: now,
        updated: now
      };

      // Escribir directamente en DB
      await db.main.put(`_superusers:${adminRecord.id}`, adminRecord);

      // Crear índice de email manualmente
      const emailIndexKey = `idx:_superusers:email:admin@local.host:${adminRecord.id}`;
      await db.indexes.put(emailIndexKey, adminRecord.id);

      // Índice de unicidad
      await db.indexes.put('uniq:_superusers:email:admin@local.host', adminRecord.id);

      console.log('✅ Admin created: admin@local.host / password123');
      console.log('⚠️  IMPORTANT: Change this password in production!');
    } catch (e) {
      console.error('❌ Failed to create admin:', e.message);
    }
  } else {
    console.log('✅ System healthy. Admin user exists.');
  }

  // Crear colección de sistema _rate_limits si no existe
  try {
    const rateLimitsCollection = await engine.get('_collections', '_rate_limits');

    if (!rateLimitsCollection) {
      console.log('⚙️  Creating _rate_limits system collection...');

      // Crear colección
      await engine.create('_collections', {
        id: '_rate_limits',
        name: '_rate_limits',
        fields: [
          { name: 'path', type: 'text', required: true },
          { name: 'method', type: 'text', required: false },
          { name: 'max', type: 'number', required: true },
          { name: 'timeWindow', type: 'number', required: true },
          { name: 'enabled', type: 'boolean', required: true },
          { name: 'skipOnError', type: 'boolean', required: false }
        ]
      });

      // Crear límite por defecto (100 requests/minuto global)
      await engine.create('_rate_limits', {
        path: '*',
        method: '*',
        max: 100,
        timeWindow: 60000, // 1 minuto
        enabled: false, // Deshabilitado por defecto
        skipOnError: true
      });

      console.log('✅ Rate limits collection created');
    }
  } catch (error) {
    console.warn('⚠️  Could not initialize rate limits:', error.message);
  }

  const stats = db.cache.getStats();
  console.log(`📊 Cache initialized: ${stats.size}/${stats.maxSize} entries`);
}

module.exports = bootstrap;
