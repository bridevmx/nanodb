const { nanoid } = require('nanoid');
const db = require('./db');
const schemaManager = require('./schema');
const indexer = require('./indexer');

const MAX_SCAN_LIMIT = parseInt(process.env.MAX_SCAN_LIMIT) || 100;

class Engine {
  
  async get(collection, id) {
    const key = `${collection}:${id}`;
    
    // 1. Intentar cache primero
    let data = db.cache.get(key);
    
    // 2. Si no está en cache, leer de disco
    if (!data) {
      data = db.main.get(key);
      if (data) db.cache.set(key, data);
    }
    
    return this._sanitize(collection, data);
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
    const record = { ...data, id, created: now, updated: now };

    // Validar unicidad
    await indexer.checkUniqueness(collection, record, schema);

    // Preparar transacción
    const ops = [
      { type: 'put', key: `${collection}:${id}`, value: record, db: db.main }
    ];
    
    const indexOps = indexer.getBatchOperations(collection, id, record, null, schema);
    ops.push(...indexOps);

    // Ejecutar transacción
    await db.root.batch(ops);

    // Guardar en cache
    db.cache.set(`${collection}:${id}`, record);

    // Broadcast realtime
    const realtime = require('../api/realtime');
    realtime.broadcast(collection, 'create', this._sanitize(collection, record));

    return this._sanitize(collection, record);
  }

  async update(collection, id, data) {
    const key = `${collection}:${id}`;
    const oldRecord = db.main.get(key);

    if (!oldRecord) throw new Error('Record not found');

    const schema = schemaManager.get(collection);
    const now = new Date().toISOString();
    
    const newRecord = { 
      ...oldRecord, 
      ...data, 
      id, 
      updated: now, 
      created: oldRecord.created 
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

    await db.root.batch(ops);

    // Actualizar cache
    db.cache.set(key, newRecord);

    const realtime = require('../api/realtime');
    realtime.broadcast(collection, 'update', this._sanitize(collection, newRecord));

    return this._sanitize(collection, newRecord);
  }

  async delete(collection, id) {
    const key = `${collection}:${id}`;
    const oldRecord = db.main.get(key);

    if (!oldRecord) throw new Error('Record not found');

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

    await db.root.batch(ops);

    // Eliminar de cache
    db.cache.del(key);

    const realtime = require('../api/realtime');
    realtime.broadcast(collection, 'delete', { id });

    return true;
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
}

module.exports = new Engine();