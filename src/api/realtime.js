const EventEmitter = require('events');
const eventBus = new EventEmitter();

const clients = new Set();

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
      res: reply.raw
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
        client.res.write(payload);
      } catch (e) {
        clients.delete(client);
      }
    });
  }
};