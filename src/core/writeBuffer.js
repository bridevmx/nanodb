/**
 * Write Buffer - Group Commit Pattern
 * 
 * Acumula operaciones de escritura en RAM y las vuelca a disco en batch
 * para reducir la contención de I/O y eliminar el cuello de botella de fsync.
 * 
 * Características:
 * - Buffer en memoria con flush automático cada 20-50ms
 * - Flush forzado al alcanzar 100 operaciones
 * - Graceful shutdown para prevenir pérdida de datos
 * - Callbacks para notificar cuando la operación se persiste
 */

const db = require('./db');

class WriteBuffer {
    constructor(options = {}) {
        this.buffer = [];
        this.cacheUpdates = [];
        this.callbacks = [];
        this.timer = null;

        // Configuración
        this.flushInterval = options.flushInterval || 20; // 20ms por defecto
        this.maxBufferSize = options.maxBufferSize || 100; // 100 ops por defecto
        this.isShuttingDown = false;

        // Métricas
        this.stats = {
            totalOps: 0,
            totalFlushes: 0,
            avgBatchSize: 0,
            lastFlushTime: Date.now()
        };

        // Registrar handler de shutdown
        this._setupShutdownHandlers();
    }

    /**
     * Agregar operación al buffer
     */
    async add(ops, cacheUpdates, callback) {
        if (this.isShuttingDown) {
            // Durante shutdown, escribir inmediatamente
            await this._flushNow([ops], [cacheUpdates], [callback]);
            return;
        }

        // Agregar al buffer
        this.buffer.push(ops);
        this.cacheUpdates.push(cacheUpdates);
        this.callbacks.push(callback);
        this.stats.totalOps++;

        // Programar flush si no existe
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.flushInterval);
        }

        // Flush inmediato si buffer lleno
        if (this.buffer.length >= this.maxBufferSize) {
            clearTimeout(this.timer);
            this.timer = null;
            await this.flush();
        }
    }

    /**
     * Flush del buffer a disco
     */
    async flush() {
        if (this.buffer.length === 0) {
            this.timer = null;
            return;
        }

        // Extraer todo el buffer
        const opsToFlush = this.buffer.splice(0);
        const cacheToFlush = this.cacheUpdates.splice(0);
        const callbacksToFlush = this.callbacks.splice(0);

        this.timer = null;

        await this._flushNow(opsToFlush, cacheToFlush, callbacksToFlush);
    }

    /**
     * Flush inmediato (interno)
     */
    async _flushNow(opsArray, cacheArray, callbackArray) {
        if (opsArray.length === 0) return;

        try {
            // Combinar todas las operaciones en un solo batch
            const allOps = [];
            const allCacheUpdates = [];

            for (let i = 0; i < opsArray.length; i++) {
                allOps.push(...opsArray[i]);
                allCacheUpdates.push(...cacheArray[i]);
            }

            // 1 SOLA transacción LMDB para todas las ops
            await db.root.batch(allOps);

            // Actualizar caché DESPUÉS de commit exitoso
            for (const [key, value] of allCacheUpdates) {
                if (value === null) {
                    db.cache.del(key);
                } else {
                    db.cache.set(key, value);
                }
            }

            // Notificar a todos los callbacks
            for (const callback of callbackArray) {
                if (callback) {
                    try {
                        callback(null); // Success
                    } catch (e) {
                        console.error('Callback error:', e);
                    }
                }
            }

            // Actualizar métricas
            this.stats.totalFlushes++;
            this.stats.avgBatchSize =
                (this.stats.avgBatchSize * (this.stats.totalFlushes - 1) + opsArray.length) /
                this.stats.totalFlushes;
            this.stats.lastFlushTime = Date.now();

        } catch (error) {
            console.error('❌ Flush error:', error);

            // Notificar error a todos los callbacks
            for (const callback of callbackArray) {
                if (callback) {
                    try {
                        callback(error);
                    } catch (e) {
                        console.error('Callback error:', e);
                    }
                }
            }

            throw error;
        }
    }

    /**
     * Configurar handlers de shutdown
     */
    _setupShutdownHandlers() {
        const gracefulShutdown = async (signal) => {
            if (this.isShuttingDown) return;

            console.log(`\n⚠️  Received ${signal}. Flushing write buffer...`);
            this.isShuttingDown = true;

            // Cancelar timer
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }

            // Flush final
            try {
                await this.flush();
                console.log('✅ Write buffer flushed successfully');
                console.log(`📊 Stats: ${this.stats.totalOps} ops, ${this.stats.totalFlushes} flushes, avg batch: ${this.stats.avgBatchSize.toFixed(1)}`);
            } catch (error) {
                console.error('❌ Error flushing buffer during shutdown:', error);
            }

            process.exit(0);
        };

        // Registrar handlers
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('beforeExit', async () => {
            if (!this.isShuttingDown) {
                await gracefulShutdown('beforeExit');
            }
        });
    }

    /**
     * Obtener estadísticas
     */
    getStats() {
        return {
            ...this.stats,
            bufferSize: this.buffer.length,
            flushInterval: this.flushInterval,
            maxBufferSize: this.maxBufferSize
        };
    }
}

// Singleton global
let writeBufferInstance = null;

module.exports = {
    getWriteBuffer: (options) => {
        if (!writeBufferInstance) {
            writeBufferInstance = new WriteBuffer(options);
        }
        return writeBufferInstance;
    },

    WriteBuffer
};
