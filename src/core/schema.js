const db = require('./db');

class SchemaManager {
  
  get(collection) {
    let schema = db.meta.get(collection);
    
    // Auto-crear esquemas para colecciones de autenticación
    if (!schema && (collection === 'users' || collection === '_superusers')) {
      schema = {
        name: collection,
        type: 'auth',
        fields: [
          { name: 'email', type: 'string', required: true, indexed: true, unique: true },
          { name: 'password', type: 'string', required: true, private: true },
          { name: 'verified', type: 'boolean', default: false }
        ]
      };
      this.create(collection, schema);
    }
    
    return schema;
  }

  create(collection, definition) {
    if (!definition.fields) definition.fields = [];
    
    // Asegurar campos de sistema
    const systemFields = ['id', 'created', 'updated'];
    systemFields.forEach(field => {
      if (!definition.fields.find(f => f.name === field)) {
        definition.fields.push({ 
          name: field, 
          type: 'system', 
          indexed: field === 'updated' 
        });
      }
    });

    return db.meta.put(collection, definition);
  }

  validate(collection, data) {
    const schema = this.get(collection);
    if (!schema || !schema.fields) return true;
    
    const errors = [];
    
    schema.fields.forEach(field => {
      const value = data[field.name];
      
      // Required check
      if (field.required && (value === undefined || value === null || value === '')) {
        errors.push(`Field '${field.name}' is required`);
      }
      
      // Type check
      if (value !== undefined && value !== null && field.type && field.type !== 'system') {
        const actualType = typeof value;
        const expectedType = field.type;
        
        if (expectedType === 'string' && actualType !== 'string') {
          errors.push(`Field '${field.name}' must be a string`);
        } else if (expectedType === 'number' && actualType !== 'number') {
          errors.push(`Field '${field.name}' must be a number`);
        } else if (expectedType === 'boolean' && actualType !== 'boolean') {
          errors.push(`Field '${field.name}' must be a boolean`);
        }
      }
    });
    
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    
    return true;
  }
}

module.exports = new SchemaManager();