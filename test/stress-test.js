#!/usr/bin/env node

/**
 * NanoDB Stress Test - Extreme Load Testing
 * 
 * Tests NanoDB under extreme conditions to find breaking points:
 * - Maximum concurrent connections
 * - Sustained high throughput
 * - Memory pressure
 * - Cache saturation
 * - VPS CPU/RAM monitoring
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const API_URL = 'https://nanodb.on.shiper.app';
// const API_URL = 'http://localhost:3000';
const EMAIL = process.env.EMAIL || 'admin@local.host';
const PASSWORD = process.env.PASSWORD || 'password123';

// VPS Monitoring
const VPS_TOKEN = process.env.VPSTOKEN;
const PROJECT_ID = 'cmkj2z83s000aeri1jn4bdt3k';
const DEPLOYMENT_ID = 'cmkj2z858000deri1e19v35g2';

let authToken = null;

// Test configurations
const STRESS_LEVELS = {
    warm: {
        name: 'WARM UP',
        operations: 100,
        concurrent: 10,
        duration: 10000 // 10s
    },
    medium: {
        name: 'MEDIUM STRESS',
        operations: 500,
        concurrent: 50,
        duration: 30000 // 30s
    },
    high: {
        name: 'HIGH STRESS',
        operations: 2000,
        concurrent: 100,
        duration: 60000 // 1min
    },
    extreme: {
        name: 'EXTREME STRESS',
        operations: 5000,
        concurrent: 200,
        duration: 120000 // 2min
    },
    breaking: {
        name: 'BREAKING POINT',
        operations: 10000,
        concurrent: 500,
        duration: 300000 // 5min
    }
};

// Metrics
const metrics = {
    totalOps: 0,
    successOps: 0,
    failedOps: 0,
    totalLatency: 0,
    minLatency: Infinity,
    maxLatency: 0,
    errors: {},
    startTime: null,
    endTime: null,
    vpsMetrics: {
        start: null,
        mid: null,
        end: null
    }
};

// ═══════════════════════════════════════════════════════════════════════
// VPS MONITORING
// ═══════════════════════════════════════════════════════════════════════

async function getVPSMetrics() {
    if (!VPS_TOKEN) return null;

    try {
        const [cpuResponse, memoryResponse] = await Promise.all([
            fetch(`https://shiper.app/api/project/${PROJECT_ID}/analytics/${DEPLOYMENT_ID}/cpu`, {
                headers: { 'cookie': `token=${VPS_TOKEN}`, 'accept': 'application/json' }
            }),
            fetch(`https://shiper.app/api/project/${PROJECT_ID}/analytics/${DEPLOYMENT_ID}/memory`, {
                headers: { 'cookie': `token=${VPS_TOKEN}`, 'accept': 'application/json' }
            })
        ]);

        const cpuData = await cpuResponse.json();
        const memoryData = await memoryResponse.json();

        const latestCPU = cpuData.values?.[cpuData.values.length - 1];
        const latestMemory = memoryData.values?.[memoryData.values.length - 1];

        return {
            cpu: latestCPU?.value || 0,
            memory: latestMemory?.value || 0,
            timestamp: Date.now()
        };
    } catch (error) {
        return null;
    }
}

function formatVPSMetrics(m) {
    if (!m) return 'N/A';
    return `CPU: ${m.cpu.toFixed(1)}% | RAM: ${m.memory.toFixed(1)}%`;
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function log(level, message) {
    const timestamp = new Date().toLocaleTimeString();
    const colors = {
        info: '\x1b[36m',    // Cyan
        success: '\x1b[32m', // Green
        error: '\x1b[31m',   // Red
        warn: '\x1b[33m',    // Yellow
        reset: '\x1b[0m'
    };

    console.log(`${colors[level]}[${timestamp}] ${message}${colors.reset}`);
}

function resetMetrics() {
    metrics.totalOps = 0;
    metrics.successOps = 0;
    metrics.failedOps = 0;
    metrics.totalLatency = 0;
    metrics.minLatency = Infinity;
    metrics.maxLatency = 0;
    metrics.errors = {};
    metrics.startTime = Date.now();
    metrics.endTime = null;
    metrics.vpsMetrics = { start: null, mid: null, end: null };
}

function printMetrics() {
    const duration = (metrics.endTime - metrics.startTime) / 1000;
    const avgLatency = metrics.totalOps > 0 ? (metrics.totalLatency / metrics.totalOps).toFixed(2) : 0;
    const throughput = duration > 0 ? (metrics.totalOps / duration).toFixed(2) : 0;
    const successRate = metrics.totalOps > 0 ? ((metrics.successOps / metrics.totalOps) * 100).toFixed(2) : 0;

    // Construir reporte
    let report = '';
    report += '\n' + '═'.repeat(70) + '\n';
    report += '📊 METRICS SUMMARY\n';
    report += '═'.repeat(70) + '\n';
    report += `Duration:        ${duration.toFixed(2)}s\n`;
    report += `Total Ops:       ${metrics.totalOps}\n`;
    report += `Success:         ${metrics.successOps} (${successRate}%)\n`;
    report += `Failed:          ${metrics.failedOps}\n`;
    report += `Throughput:      ${throughput} ops/s\n`;
    report += `Avg Latency:     ${avgLatency}ms\n`;
    report += `Min Latency:     ${metrics.minLatency === Infinity ? 0 : metrics.minLatency}ms\n`;
    report += `Max Latency:     ${metrics.maxLatency}ms\n`;

    // VPS Metrics
    if (metrics.vpsMetrics.start || metrics.vpsMetrics.end) {
        report += '\n' + '─'.repeat(70) + '\n';
        report += '📈 VPS METRICS\n';
        report += '─'.repeat(70) + '\n';
        report += `Start:           ${formatVPSMetrics(metrics.vpsMetrics.start)}\n`;
        if (metrics.vpsMetrics.mid) {
            report += `Mid:             ${formatVPSMetrics(metrics.vpsMetrics.mid)}\n`;
        }
        report += `End:             ${formatVPSMetrics(metrics.vpsMetrics.end)}\n`;

        // Tendencia
        if (metrics.vpsMetrics.start && metrics.vpsMetrics.end) {
            const cpuDelta = metrics.vpsMetrics.end.cpu - metrics.vpsMetrics.start.cpu;
            const ramDelta = metrics.vpsMetrics.end.memory - metrics.vpsMetrics.start.memory;
            report += `Trend:           CPU ${cpuDelta > 0 ? '+' : ''}${cpuDelta.toFixed(1)}% | RAM ${ramDelta > 0 ? '+' : ''}${ramDelta.toFixed(1)}%\n`;
        }
    }

    if (Object.keys(metrics.errors).length > 0) {
        report += '\n🔴 ERRORS:\n';
        Object.entries(metrics.errors).forEach(([error, count]) => {
            report += `  ${error}: ${count}\n`;
        });
    }

    report += '═'.repeat(70) + '\n';

    // Guardar en archivo
    const outputPath = path.join(__dirname, 'metrics.llm.txt');
    fs.writeFileSync(outputPath, report, 'utf8');

    console.log(`\n✅ Métricas guardadas en: ${outputPath}`);
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════

async function makeRequest(method, url, data = null) {
    const start = Date.now();

    try {
        const headers = {
            'Authorization': authToken ? `Bearer ${authToken}` : '',
            'X-Skip-Rate-Limit': 'true', // Bypass rate limiting para tests
            'User-Agent': 'stress-test'
        };

        if (data) {
            headers['Content-Type'] = 'application/json';
        }

        const options = {
            method,
            headers
        };

        if (data) options.body = JSON.stringify(data);

        const response = await fetch(`${API_URL}${url}`, options);
        const latency = Date.now() - start;

        metrics.totalOps++;
        metrics.totalLatency += latency;
        metrics.minLatency = Math.min(metrics.minLatency, latency);
        metrics.maxLatency = Math.max(metrics.maxLatency, latency);

        if (response.ok) {
            metrics.successOps++;

            if (response.status === 204) {
                return { success: true, data: null, latency };
            }

            try {
                const result = await response.json();
                return { success: true, data: result, latency };
            } catch (e) {
                return { success: true, data: null, latency };
            }
        } else {
            metrics.failedOps++;
            const errorKey = `HTTP ${response.status}`;
            metrics.errors[errorKey] = (metrics.errors[errorKey] || 0) + 1;
            return { success: false, error: errorKey, latency };
        }
    } catch (error) {
        metrics.totalOps++;
        metrics.failedOps++;
        const latency = Date.now() - start;
        metrics.totalLatency += latency;

        const errorKey = error.message;
        metrics.errors[errorKey] = (metrics.errors[errorKey] || 0) + 1;

        return { success: false, error: errorKey, latency };
    }
}

// ═══════════════════════════════════════════════════════════════════════
// CONCURRENCY POOL
// ═══════════════════════════════════════════════════════════════════════

class ConcurrencyPool {
    constructor(limit) {
        this.limit = limit;
        this.running = 0;
        this.queue = [];
    }

    async run(fn) {
        while (this.running >= this.limit) {
            await new Promise(resolve => this.queue.push(resolve));
        }

        this.running++;

        try {
            return await fn();
        } finally {
            this.running--;
            const resolve = this.queue.shift();
            if (resolve) resolve();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

async function login() {
    log('info', `Logging in as ${EMAIL}...`);

    try {
        const response = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: EMAIL, password: PASSWORD, collection: '_superusers' })
        });

        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            log('success', '✅ Login successful');
            return true;
        } else {
            log('error', `❌ Login failed: ${data.error}`);
            return false;
        }
    } catch (error) {
        log('error', `❌ Connection error: ${error.message}`);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STRESS TESTS
// ═══════════════════════════════════════════════════════════════════════

async function stressCRUD(config) {
    console.log(`\n🚀 ${config.name}: ${config.operations} ops, ${config.concurrent} concurrent`);
    resetMetrics();

    // Capturar métricas VPS al inicio (sin mostrar)
    metrics.vpsMetrics.start = await getVPSMetrics();

    const pool = new ConcurrencyPool(config.concurrent);

    // Programar captura de métricas a mitad del test
    const midCaptureTimeout = setTimeout(async () => {
        metrics.vpsMetrics.mid = await getVPSMetrics();
    }, (config.operations / config.concurrent) * 500);
    const createdIds = [];

    // CREATE
    console.log(`📝 Creating ${config.operations} records...`);
    const createPromises = [];

    for (let i = 0; i < config.operations; i++) {
        createPromises.push(
            pool.run(async () => {
                const result = await makeRequest('POST', '/api/collections/stress_test/records', {
                    title: `Stress Test ${i + 1}`,
                    content: `Content ${i + 1}`,
                    index: i,
                    timestamp: new Date().toISOString()
                });

                if (result.success && result.data) {
                    createdIds.push(result.data.id);
                }

                return result;
            })
        );
    }

    await Promise.all(createPromises);
    log('success', `✅ Created ${createdIds.length}/${config.operations} records`);

    // READ
    log('info', `📖 Reading ${createdIds.length} records...`);
    const readPromises = [];

    for (const id of createdIds) {
        readPromises.push(
            pool.run(async () => {
                return await makeRequest('GET', `/api/collections/stress_test/records/${id}`);
            })
        );
    }

    await Promise.all(readPromises);
    log('success', `✅ Read complete`);

    // UPDATE
    log('info', `✏️ Updating ${createdIds.length} records...`);
    const updatePromises = [];

    for (const id of createdIds) {
        updatePromises.push(
            pool.run(async () => {
                return await makeRequest('PATCH', `/api/collections/stress_test/records/${id}`, {
                    updated_at: new Date().toISOString()
                });
            })
        );
    }

    await Promise.all(updatePromises);
    log('success', `✅ Update complete`);

    // DELETE
    log('info', `🗑️ Deleting ${createdIds.length} records...`);
    const deletePromises = [];

    for (const id of createdIds) {
        deletePromises.push(
            pool.run(async () => {
                return await makeRequest('DELETE', `/api/collections/stress_test/records/${id}`);
            })
        );
    }

    await Promise.all(deletePromises);
    console.log(`✅ Delete complete`);

    // Capturar métricas VPS al final (sin mostrar)
    clearTimeout(midCaptureTimeout);
    metrics.endTime = Date.now();
    metrics.vpsMetrics.end = await getVPSMetrics();

    printMetrics();
}

async function stressSustained(config) {
    log('info', `🚀 Starting ${config.name}: ${config.duration / 1000}s sustained load, ${config.concurrent} concurrent`);
    resetMetrics();

    const pool = new ConcurrencyPool(config.concurrent);
    const endTime = Date.now() + config.duration;
    let counter = 0;

    const workers = [];

    for (let i = 0; i < config.concurrent; i++) {
        workers.push(
            (async () => {
                while (Date.now() < endTime) {
                    const id = counter++;

                    // CREATE
                    const createResult = await pool.run(async () => {
                        return await makeRequest('POST', '/api/collections/stress_sustained/records', {
                            title: `Sustained ${id}`,
                            worker: i,
                            timestamp: new Date().toISOString()
                        });
                    });

                    if (createResult.success && createResult.data) {
                        const recordId = createResult.data.id;

                        // READ
                        await pool.run(async () => {
                            return await makeRequest('GET', `/api/collections/stress_sustained/records/${recordId}`);
                        });

                        // UPDATE
                        await pool.run(async () => {
                            return await makeRequest('PATCH', `/api/collections/stress_sustained/records/${recordId}`, {
                                updated: true
                            });
                        });

                        // DELETE
                        await pool.run(async () => {
                            return await makeRequest('DELETE', `/api/collections/stress_sustained/records/${recordId}`);
                        });
                    }
                }
            })()
        );
    }

    await Promise.all(workers);

    metrics.endTime = Date.now();
    printMetrics();
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('🔥 NanoDB EXTREME STRESS TEST 🔥');
    console.log('═'.repeat(70));
    console.log(`Server: ${API_URL}`);
    console.log(`User: ${EMAIL}`);
    console.log('═'.repeat(70) + '\n');

    // Login
    const loginSuccess = await login();
    if (!loginSuccess) {
        process.exit(1);
    }

    console.log('\n⏳ Waiting 2 seconds before starting...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Run stress tests
    const level = process.argv[2] || 'warm';
    const config = STRESS_LEVELS[level];

    if (!config) {
        log('error', `Unknown stress level: ${level}`);
        log('info', `Available levels: ${Object.keys(STRESS_LEVELS).join(', ')}`);
        process.exit(1);
    }

    // Choose test type
    const testType = process.argv[3] || 'crud';

    if (testType === 'crud') {
        await stressCRUD(config);
    } else if (testType === 'sustained') {
        await stressSustained(config);
    } else {
        log('error', `Unknown test type: ${testType}`);
        log('info', 'Available types: crud, sustained');
        process.exit(1);
    }

    log('success', '🎉 Stress test completed!');
}

main().catch(error => {
    log('error', `Fatal error: ${error.message}`);
    console.error(error);
    process.exit(1);
});
