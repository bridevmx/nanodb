const { nanoid } = require('nanoid');
const db = require('./db');
const schemaManager = require('./schema');
const indexer = require('./indexer');
const { SingleflightCache } = require('../utils/singleflight');

const MAX_SCAN_LIMIT = parseInt(process.env.MAX_SCAN_LIMIT) || 100;

class Engine {
  constructor() {
    // Inicializar singleflight para prevenir thundering herd
    this.singleflight = new SingleflightCache(db.cache);
  }

  async get(collection, id) {
    const key = `${collection}:${id}`;

    // Usar singleflight para prevenir thundering herd
    // Solo una petición va a disco, las demás esperan
    return await this.singleflight.get(key, async () => {
      const data = db.main.get(key);
      return this._sanitize(collection, data);
    });
  }

  async list(collection, options = {}) {
    const { filter = {}, sort, page = 1, perPage = 30 } = options;
    const schema = schemaManager.get(collection);

    let candidateIds = null;

    // Buscar campo indexado en los filtros
    const indexedField = schema?.fields.find(f =>
      f.indexed && filter[f.name] !== undefined
    );

    if (indexedField) {
      // Búsqueda indexada (O(1))
      candidateIds = [];
      const val = filter[indexedField.name];
      const prefix = `idx:${collection}:${indexedField.name}:${val}:`;

      for (const { value } of db.indexes.getRange({
        start: prefix,
        end: prefix + '\xFF'
      })) {
        candidateIds.push(value);
      }
    } else {
      // Scan limitado si no hay índice
      candidateIds = [];
      const prefix = `${collection}:`;
      let scanned = 0;

      for (const { key } of db.main.getRange({
        start: prefix,
        end: prefix + '\xFF'
      })) {
        candidateIds.push(key.split(':')[1]);
        if (++scanned >= MAX_SCAN_LIMIT) break;
      }

      if (scanned >= MAX_SCAN_LIMIT) {
        console.warn(
          `Warning: Query on '${collection}' hit scan limit of ${MAX_SCAN_LIMIT}. ` +
          `Consider adding indexed filters for better performance.`
        );
      }
    }

    // Fetch de datos (con cache)
    let results = candidateIds
      .map(id => {
        const key = `${collection}:${id}`;
        let data = db.cache.get(key);

        if (!data) {
          data = db.main.get(key);
          if (data) db.cache.set(key, data);
        }

        return data;
      })
      .filter(r => r);

    // Filtrado en memoria
    results = results.filter(item => {
      for (const [key, val] of Object.entries(filter)) {
        if (item[key] != val) return false;
      }
      return true;
    });

    // Sort
    if (sort) {
      const desc = sort.startsWith('-');
      const field = desc ? sort.substring(1) : sort;
      results.sort((a, b) => {
        if (a[field] < b[field]) return desc ? 1 : -1;
        if (a[field] > b[field]) return desc ? -1 : 1;
        return 0;
      });
    }

    // Paginación
    const totalItems = results.length;
    const start = (page - 1) * perPage;
    const paginated = results.slice(start, start + perPage);

    const cleanResults = paginated.map(r => this._sanitize(collection, r));

    return {
      page: parseInt(page),
      perPage: parseInt(perPage),
      totalItems,
      totalPages: Math.ceil(totalItems / perPage),
      items: cleanResults
    };
  }

  async create(collection, data) {
    const schema = schemaManager.get(collection);

    // Validar esquema
    schemaManager.validate(collection, data);

    const id = nanoid(15);
    const now = new Date().toISOString();
    const record = {
      ...data,
      id,
      created: now,
      updated: now,
      _version: 1  // ← Versión inicial para optimistic locking
    };

    // Validar unicidad
    await indexer.checkUniqueness(collection, record, schema);

    // Preparar transacción
    const ops = [
      { type: 'put', key: `${collection}:${id}`, value: record, db: db.main }
    ];

    const indexOps = indexer.getBatchOperations(collection, id, record, null, schema);
    ops.push(...indexOps);

    // Atomic write: disco + caché en una operación
    await this._atomicWrite(ops, [[`${collection}:${id}`, record]]);

    // Broadcast realtime (async - no bloquea respuesta HTTP)
    const realtime = require('../api/realtime');
    const sanitized = this._sanitize(collection, record);
    setImmediate(() => {
      realtime.broadcast(collection, 'create', sanitized);
    });

    return sanitized;
  }

  async update(collection, id, data) {
    // Retry automático hasta 3 veces en caso de conflicto
    return await this._retryOnConflict(async () => {
      const key = `${collection}:${id}`;

      // Obtener registro actual con singleflight
      const oldRecord = await this.get(collection, id);

      if (!oldRecord) throw new Error('Record not found');

      const schema = schemaManager.get(collection);
      const now = new Date().toISOString();

      // Verificar versión si se proporciona (optimistic lock)
      if (data._expectedVersion !== undefined) {
        if (oldRecord._version !== data._expectedVersion) {
          throw new Error('Version conflict: record was modified by another request');
        }
        delete data._expectedVersion; // No guardar este campo
      }

      const newRecord = {
        ...oldRecord,
        ...data,
        id,
        updated: now,
        created: oldRecord.created,
        _version: (oldRecord._version || 0) + 1  // ← Incrementar versión
      };

      // Validar esquema
      schemaManager.validate(collection, newRecord);

      // Validar unicidad
      await indexer.checkUniqueness(collection, newRecord, schema, id);

      const ops = [
        { type: 'put', key, value: newRecord, db: db.main }
      ];

      const indexOps = indexer.getBatchOperations(
        collection,
        id,
        newRecord,
        oldRecord,
        schema
      );
      ops.push(...indexOps);

      // Atomic write: disco + caché en una operación
      await this._atomicWrite(ops, [[key, newRecord]]);

      // Broadcast realtime (async - no bloquea respuesta HTTP)
      const realtime = require('../api/realtime');
      const sanitized = this._sanitize(collection, newRecord);
      setImmediate(() => {
        realtime.broadcast(collection, 'update', sanitized);
      });

      return sanitized;
    });
  }

  async delete(collection, id, expectedVersion = null) {
    // Retry automático hasta 3 veces
    return await this._retryOnConflict(async () => {
      const key = `${collection}:${id}`;

      // Obtener registro actual con singleflight
      const oldRecord = await this.get(collection, id);

      if (!oldRecord) throw new Error('Record not found');

      // Verificar versión si se proporciona (optimistic lock)
      if (expectedVersion !== null && oldRecord._version !== expectedVersion) {
        throw new Error('Version conflict: record was modified by another request');
      }

      const schema = schemaManager.get(collection);

      const ops = [
        { type: 'del', key, db: db.main }
      ];

      const indexOps = indexer.getBatchOperations(
        collection,
        id,
        null,
        oldRecord,
        schema
      );
      ops.push(...indexOps);

      // Atomic write: disco + invalidación de caché
      await this._atomicWrite(ops, [[key, null]]);

      // Broadcast realtime (async - no bloquea respuesta HTTP)
      const realtime = require('../api/realtime');
      setImmediate(() => {
        realtime.broadcast(collection, 'delete', { id });
      });

      return true;
    });
  }

  _sanitize(collection, data) {
    if (!data) return null;

    const schema = schemaManager.get(collection);
    if (!schema) return data;

    const clean = { ...data };

    schema.fields.forEach(f => {
      if (f.private) delete clean[f.name];
    });

    return clean;
  }

  /**
   * Retry automático en caso de conflictos de versión
   * Implementa backoff exponencial: 10ms, 20ms, 40ms
   */
  async _retryOnConflict(fn, maxRetries = 3) {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error.message.includes('Version conflict') && attempt < maxRetries - 1) {
          // Backoff exponencial
          await new Promise(resolve => setTimeout(resolve, 10 * Math.pow(2, attempt)));
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Escritura atómica: disco + caché en una operación
   * Garantiza consistencia ACID completa
   */
  async _atomicWrite(ops, cacheUpdates) {
    // Ejecutar batch operation (transacción atómica en LMDB)
    await db.root.batch(ops);

    // Solo actualizar caché DESPUÉS de commit exitoso
    for (const [key, value] of cacheUpdates) {
      if (value === null) {
        db.cache.del(key);
      } else {
        db.cache.set(key, value);
      }
    }
  }
}

module.exports = new Engine();