const engine = require('../core/engine');
const enforcer = require('../security/enforcer');
const realtime = require('./realtime');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nanodb-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE) || 100;

async function routes(fastify, options) {

  // ═══════════════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.post('/api/auth/login', async (req, reply) => {
    const { email, password, collection = 'users' } = req.body;
    
    if (!email || !password) {
      return reply.code(400).send({ 
        error: 'Email and password are required' 
      });
    }
    
    try {
      const result = await engine.list(collection, { 
        filter: { email }, 
        perPage: 1 
      });
      
      const user = result.items[0];

      if (!user) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }
      
      const rawUser = require('../core/db').main.get(`${collection}:${user.id}`);
      const valid = await bcrypt.compare(password, rawUser.password);
      
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ 
        id: user.id, 
        collection, 
        isAdmin: collection === '_superusers' 
      }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

      return { token, user };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Login failed' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REALTIME
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.get('/api/realtime', (req, reply) => {
    realtime.subscribe(req, reply);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // MIDDLEWARE: AUTH
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/api/auth') || req.url.startsWith('/api/realtime')) {
      return;
    }
    
    const token = req.headers.authorization?.split(' ')[1];
    
    if (token) {
      try {
        req.user = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        // Token inválido - continuar como anónimo
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD: LIST
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.get('/api/collections/:collection/records', async (req, reply) => {
    const { collection } = req.params;
    
    try {
      const securityFilter = await enforcer.enforceList(collection, req.user);
      const userFilter = parseFilter(req.query.filter);
      const finalFilter = { ...userFilter, ...securityFilter };

      return engine.list(collection, {
        filter: finalFilter,
        sort: req.query.sort,
        page: req.query.page,
        perPage: req.query.perPage
      });
    } catch (error) {
      throw error;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD: VIEW
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.get('/api/collections/:collection/records/:id', async (req, reply) => {
    const { collection, id } = req.params;
    
    try {
      const record = await engine.get(collection, id);
      
      if (!record) {
        return reply.code(404).send({ error: 'Record not found' });
      }

      await enforcer.enforceSingle('view', collection, req.user, record);
      
      return record;
    } catch (error) {
      throw error;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD: CREATE
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.post('/api/collections/:collection/records', async (req, reply) => {
    const { collection } = req.params;
    const data = req.body;

    try {
      await enforcer.enforceSingle('create', collection, req.user, null);

      // Hash password para colecciones de auth
      if ((collection === 'users' || collection === '_superusers') && data.password) {
        data.password = await bcrypt.hash(data.password, 10);
      }

      // Auto-asignar owner_id
      if (req.user && !data.owner_id) {
        data.owner_id = req.user.id;
      }

      return engine.create(collection, data);
    } catch (error) {
      throw error;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD: UPDATE
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.patch('/api/collections/:collection/records/:id', async (req, reply) => {
    const { collection, id } = req.params;
    const data = req.body;

    try {
      const record = await engine.get(collection, id);
      
      if (!record) {
        return reply.code(404).send({ error: 'Record not found' });
      }

      await enforcer.enforceSingle('update', collection, req.user, record);
      
      // Proteger campos de sistema
      if (req.user && !req.user.isAdmin) {
        delete data.id;
        delete data.created;
        delete data.owner_id;
      }

      return engine.update(collection, id, data);
    } catch (error) {
      throw error;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD: DELETE
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.delete('/api/collections/:collection/records/:id', async (req, reply) => {
    const { collection, id } = req.params;
    
    try {
      const record = await engine.get(collection, id);
      
      if (!record) {
        return reply.code(404).send({ error: 'Record not found' });
      }

      await enforcer.enforceSingle('delete', collection, req.user, record);
      
      await engine.delete(collection, id);
      
      return { success: true, id };
    } catch (error) {
      throw error;
    }
  });
  
  // ═══════════════════════════════════════════════════════════════════════
  // BATCH OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.post('/api/batch', async (req, reply) => {
    const { requests = [] } = req.body;
    
    if (!Array.isArray(requests) || requests.length === 0) {
      return reply.code(400).send({ error: 'Invalid batch request' });
    }
    
    if (requests.length > MAX_BATCH_SIZE) {
      return reply.code(400).send({ 
        error: `Max ${MAX_BATCH_SIZE} operations per batch` 
      });
    }
    
    const results = [];
    
    for (const op of requests) {
      try {
        const { method, collection, id, data } = op;
        
        let result;
        
        switch (method) {
          case 'create':
            await enforcer.enforceSingle('create', collection, req.user, null);
            
            if ((collection === 'users' || collection === '_superusers') && data.password) {
              data.password = await bcrypt.hash(data.password, 10);
            }
            
            if (req.user && !data.owner_id) {
              data.owner_id = req.user.id;
            }
            
            result = await engine.create(collection, data);
            break;
            
          case 'update':
            const record = await engine.get(collection, id);
            if (!record) throw new Error('Record not found');
            
            await enforcer.enforceSingle('update', collection, req.user, record);
            
            if (req.user && !req.user.isAdmin) {
              delete data.id;
              delete data.created;
              delete data.owner_id;
            }
            
            result = await engine.update(collection, id, data);
            break;
            
          case 'delete':
            const delRecord = await engine.get(collection, id);
            if (!delRecord) throw new Error('Record not found');
            
            await enforcer.enforceSingle('delete', collection, req.user, delRecord);
            result = await engine.delete(collection, id);
            break;
            
          default:
            throw new Error(`Unknown method: ${method}`);
        }
        
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    
    return { results };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STATS (DEBUG)
  // ═══════════════════════════════════════════════════════════════════════
  
  fastify.get('/api/stats', async (req, reply) => {
    const db = require('../core/db');
    return db.cache.getStats();
  });
}

function parseFilter(filterStr) {
  if (!filterStr) return {};
  
  try {
    return JSON.parse(filterStr);
  } catch (e) {
    const parts = filterStr.split('=');
    if (parts.length === 2) {
      return { [parts[0]]: parts[1] };
    }
    return {};
  }
}

module.exports = routes;