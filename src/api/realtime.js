const EventEmitter = require('events');
const eventBus = new EventEmitter();

const clients = new Set();

// ═══════════════════════════════════════════════════════════════════════
// HEARTBEAT & TIMEOUT (Prevenir memory leaks)
// ═══════════════════════════════════════════════════════════════════════

const HEARTBEAT_INTERVAL = 30000; // 30s
const CLIENT_TIMEOUT = 60000;     // 60s

// Ping periódico para mantener conexiones vivas
setInterval(() => {
  const now = Date.now();
  const ping = 'event: ping\ndata: {}\n\n';

  clients.forEach(client => {
    try {
      // Verificar timeout
      if (now - client.lastActivity > CLIENT_TIMEOUT) {
        console.log(`⏱️ Client ${client.id} timed out`);
        client.res.end();
        clients.delete(client);
        return;
      }

      // Enviar ping
      const canWrite = client.res.write(ping);
      if (!canWrite) {
        // Backpressure: el cliente está lento, desconectar
        console.log(`🚫 Client ${client.id} backpressure detected`);
        client.res.end();
        clients.delete(client);
      } else {
        client.lastActivity = now;
      }
    } catch (e) {
      clients.delete(client);
    }
  });
}, HEARTBEAT_INTERVAL);

module.exports = {

  subscribe: (req, reply) => {
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    };

    reply.raw.writeHead(200, headers);

    const clientId = Date.now();
    const newClient = {
      id: clientId,
      res: reply.raw,
      lastActivity: Date.now()
    };

    clients.add(newClient);

    reply.raw.write('event: connected\ndata: {}\n\n');

    req.raw.on('close', () => {
      clients.delete(newClient);
    });
  },

  broadcast: (collection, action, data) => {
    const message = JSON.stringify({ collection, action, data });
    const payload = `event: message\ndata: ${message}\n\n`;

    clients.forEach(client => {
      try {
        const canWrite = client.res.write(payload);
        if (!canWrite) {
          // Backpressure: desconectar cliente lento
          console.log(`🚫 Client ${client.id} disconnected (backpressure on broadcast)`);
          client.res.end();
          clients.delete(client);
        } else {
          // Actualizar actividad
          client.lastActivity = Date.now();
        }
      } catch (e) {
        clients.delete(client);
      }
    });
  }
};