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

  const stats = db.cache.getStats();
  console.log(`📊 Cache initialized: ${stats.size}/${stats.maxSize} entries`);
}

module.exports = bootstrap;
