const fastify = require('fastify')({
  logger: {
    level: process.env.NODE_ENV === 'development' ? 'info' : 'error'
  }
});

const routes = require('./api/routes');
const bootstrap = require('./bootstrap');

// CORS
fastify.register(require('@fastify/cors'), {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});

// Routes
fastify.register(routes);

// Error Handler
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);

  if (error.message.includes('Forbidden')) {
    return reply.code(403).send({ error: error.message });
  }

  if (error.message.includes('Validation failed')) {
    return reply.code(400).send({ error: error.message });
  }

  if (error.message.includes('not found')) {
    return reply.code(404).send({ error: error.message });
  }

  if (error.message.includes('must be unique')) {
    return reply.code(409).send({ error: error.message });
  }

  return reply.code(500).send({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// Health check
fastify.get('/health', async (req, reply) => {
  return {
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };
});

// Start
const start = async () => {
  try {
    await bootstrap();

    const port = parseInt(process.env.PORT) || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║              🚀 NanoDB Server Running 🚀                 ║');
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  ➜  Local:   http://localhost:${port}`);
    console.log(`  ➜  Network: http://0.0.0.0:${port}`);
    console.log('');
    console.log('  API Endpoints:');
    console.log(`    POST   /api/auth/login`);
    console.log(`    GET    /api/collections/:collection/records`);
    console.log(`    POST   /api/collections/:collection/records`);
    console.log(`    PATCH  /api/collections/:collection/records/:id`);
    console.log(`    DELETE /api/collections/:collection/records/:id`);
    console.log(`    POST   /api/batch`);
    console.log(`    GET    /api/realtime`);
    console.log(`    GET    /api/stats`);
    console.log(`    GET    /health`);
    console.log('');
    console.log('  Press Ctrl+C to stop');
    console.log('');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();