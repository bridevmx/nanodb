const { open } = require('lmdb');
const path = require('path');
const fs = require('fs');
const LRUCache = require('../utils/cache');

// Configuración
const DATA_PATH = process.env.DB_PATH || path.join(__dirname, '../../data');
const MAX_CACHE_SIZE = parseInt(process.env.MAX_CACHE_SIZE) || 1000;

// Crear directorio de datos
if (!fs.existsSync(DATA_PATH)) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
}

// Abrir base de datos LMDB
const rootDb = open({
  path: DATA_PATH,
  compression: true,
  cache: true,
  maxDbs: 20,
  mapSize: parseInt(process.env.DB_MAX_SIZE) || 2 * 1024 * 1024 * 1024
});

// Inicializar cache
const cache = new LRUCache(MAX_CACHE_SIZE);

// Estructura de base de datos
const db = {
  root: rootDb,
  main: rootDb.openDB({ name: 'main', encoding: 'json' }),
  indexes: rootDb.openDB({ name: 'indexes', encoding: 'json' }),
  meta: rootDb.openDB({ name: 'meta', encoding: 'json' }),
  cache
};

module.exports = db;