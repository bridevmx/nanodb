const db = require('./db');

class Indexer {
  
  getKey(collection, field, value, id) {
    let normalizedVal = value;
    
    if (typeof value === 'number') {
      normalizedVal = value.toString().padStart(20, '0');
    }
    
    return `idx:${collection}:${field}:${normalizedVal}:${id}`;
  }

  getBatchOperations(collection, id, newData, oldData, schema) {
    const ops = [];
    if (!schema) return ops;

    schema.fields.forEach(field => {
      if (!field.indexed) return;

      const name = field.name;
      const newVal = newData ? newData[name] : undefined;
      const oldVal = oldData ? oldData[name] : undefined;

      if (newVal === oldVal) return;

      // Borrar índice viejo
      if (oldVal !== undefined && oldVal !== null) {
        const key = this.getKey(collection, name, oldVal, id);
        ops.push({ type: 'del', key, db: db.indexes });
        
        if (field.unique) {
          ops.push({ 
            type: 'del', 
            key: `uniq:${collection}:${name}:${oldVal}`, 
            db: db.indexes 
          });
        }
      }

      // Crear índice nuevo
      if (newVal !== undefined && newVal !== null) {
        const key = this.getKey(collection, name, newVal, id);
        ops.push({ type: 'put', key, value: id, db: db.indexes });

        if (field.unique) {
          ops.push({ 
            type: 'put', 
            key: `uniq:${collection}:${name}:${newVal}`, 
            value: id, 
            db: db.indexes 
          });
        }
      }
    });

    return ops;
  }
  
  async checkUniqueness(collection, data, schema, currentId = null) {
    if (!schema) return;
    
    for (const field of schema.fields) {
      if (field.unique && data[field.name]) {
        const uniqKey = `uniq:${collection}:${field.name}:${data[field.name]}`;
        const existingId = db.indexes.get(uniqKey);
        
        if (existingId && existingId !== currentId) {
          throw new Error(
            `Field '${field.name}' must be unique. Value '${data[field.name]}' already exists.`
          );
        }
      }
    }
  }
}

module.exports = new Indexer();