const db = require('./db');

class WriteBuffer {
    constructor(options = {}) {
        this.buffer = [];
        this.timer = null;

        // Cola para serializar escrituras y evitar "Concurrency Storm"
        this.flushQueue = [];
        this.isFlushing = false;

        // Golden Ratio Config (Modo Volátil)
        this.flushInterval = options.flushInterval || 500;    // 500ms para bloques grandes
        this.maxBufferSize = options.maxBufferSize || 20000;  // Buffer grande para ráfagas

        this.optimistic = true;
        this.isShuttingDown = false;

        this.stats = { totalOps: 0, totalFlushes: 0, lastBatchSize: 0, queueLength: 0 };
        this._setupShutdownHandlers();
    }

    async add(ops, cacheUpdates, callback) {
        if (this.isShuttingDown) {
            // En shutdown, forzamos escritura síncrona/serial
            await this._flushNow([ops]);
            this._applyCache([cacheUpdates]);
            callback(null);
            return;
        }

        // 🛡️ VÁLVULA DE SEGURIDAD: Backpressure
        // Si tenemos más de 50 lotes pendientes, el disco no da abasto
        if (this.flushQueue.length > 50) {
            const error = new Error('System overloaded: Disk I/O lag');
            error.code = 'EOVERLOAD';
            callback(error);
            return;
        }

        this.buffer.push(ops);
        this.stats.totalOps++;

        // Modo Optimista: Respuesta inmediata
        if (this.optimistic) {
            this._applyCache([cacheUpdates]);
            callback(null);
        } else {
            // Modo Seguro simplificado (en producción real, usar cola de callbacks)
            callback(null);
        }

        // Timer para flush periódico
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), this.flushInterval);
        }

        // Flush por llenado
        if (this.buffer.length >= this.maxBufferSize) {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            // No esperamos el flush, solo lo encolamos
            this.flush().catch(err => console.error('Auto-flush failed:', err));
        }
    }

    async flush() {
        if (this.buffer.length === 0) {
            this.timer = null;
            return;
        }

        // 1. "Swap" atómico del buffer
        const opsToFlush = this.buffer;
        this.buffer = [];
        this.timer = null;

        // 2. Encolar el lote para procesamiento serial
        this.flushQueue.push(opsToFlush);
        this.stats.queueLength = this.flushQueue.length;

        // 3. Procesar la cola (si no se está procesando ya)
        this._processFlushQueue();
    }

    // ⚡ EL SECRETO: Procesamiento Serial Estricto
    async _processFlushQueue() {
        if (this.isFlushing) return; // Ya hay un trabajador escribiendo
        this.isFlushing = true;

        try {
            while (this.flushQueue.length > 0) {
                // Tomar el siguiente lote
                const batch = this.flushQueue.shift();
                this.stats.queueLength = this.flushQueue.length;

                // Escribir y ESPERAR a que termine antes de seguir
                await this._flushNow(batch);

                // Pequeño respiro al Event Loop si la cola es muy larga
                if (this.flushQueue.length > 5) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        } catch (error) {
            console.error('❌ Critical Flush Queue Error:', error);
        } finally {
            this.isFlushing = false;
            // Doble check por si entraron más items mientras salíamos
            if (this.flushQueue.length > 0) this._processFlushQueue();
        }
    }

    _applyCache(cacheUpdatesArray) {
        for (const updates of cacheUpdatesArray) {
            for (const [key, val] of updates) {
                if (val === null) db.cache.del(key);
                else db.cache.set(key, val);
            }
        }
    }

    async _flushNow(opsArray) {
        if (!opsArray || opsArray.length === 0) return;

        try {
            const allOps = [];
            for (let i = 0; i < opsArray.length; i++) {
                const reqOps = opsArray[i];
                for (let j = 0; j < reqOps.length; j++) {
                    allOps.push(reqOps[j]);
                }
            }

            // Escritura física
            await db.root.batch(allOps);

            this.stats.totalFlushes++;
            this.stats.lastBatchSize = opsArray.length;

        } catch (error) {
            console.error('❌ Background Flush Failed:', error);
        }
    }

    _setupShutdownHandlers() {
        const gracefulShutdown = async (signal) => {
            if (this.isShuttingDown) return;
            console.log(`\n⚠️ ${signal}. Processing queue (${this.flushQueue.length} batches) + buffer...`);
            this.isShuttingDown = true;

            if (this.timer) clearTimeout(this.timer);

            // Mover buffer remanente a la cola
            if (this.buffer.length > 0) {
                this.flushQueue.push(this.buffer);
                this.buffer = [];
            }

            // Esperar a que se vacíe la cola
            while (this.flushQueue.length > 0 || this.isFlushing) {
                await new Promise(r => setTimeout(r, 100));
            }

            console.log('✅ All writes flushed.');
            process.exit(0);
        };
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }

    getStats() {
        return { ...this.stats, currentBufferSize: this.buffer.length };
    }
}

let writeBufferInstance = null;
module.exports = {
    getWriteBuffer: (options) => {
        if (!writeBufferInstance) writeBufferInstance = new WriteBuffer(options);
        return writeBufferInstance;
    },
    WriteBuffer
};