#!/usr/bin/env node

/**
 * VPS Limit Finder - Encuentra los límites reales del servidor
 * 
 * Este script:
 * 1. Monitorea CPU y memoria del VPS en tiempo real
 * 2. Limpia la base de datos (excepto colecciones del sistema)
 * 3. Ejecuta tests progresivos hasta encontrar el punto de ruptura
 * 4. Genera reporte detallado de límites
 */

require('dotenv').config();

const VPS_TOKEN = process.env.VPSTOKEN;
const PROJECT_ID = 'cmkj2z83s000aeri1jn4bdt3k';
const DEPLOYMENT_ID = 'cmkj2z858000deri1e19v35g2';
const API_URL = process.env.API_URL || 'https://nanodb.on.shiper.app';
const EMAIL = process.env.EMAIL || 'admin@local.host';
const PASSWORD = process.env.PASSWORD || 'password123';

let authToken = null;

// ═══════════════════════════════════════════════════════════════════════
// VPS MONITORING
// ═══════════════════════════════════════════════════════════════════════

async function getVPSMetrics() {
    if (!VPS_TOKEN) {
        console.warn('⚠️  VPSTOKEN no configurado - métricas de VPS no disponibles');
        return null;
    }

    try {
        const [cpuResponse, memoryResponse] = await Promise.all([
            fetch(`https://shiper.app/api/project/${PROJECT_ID}/analytics/${DEPLOYMENT_ID}/cpu`, {
                headers: {
                    'cookie': `token=${VPS_TOKEN}`,
                    'accept': 'application/json'
                }
            }),
            fetch(`https://shiper.app/api/project/${PROJECT_ID}/analytics/${DEPLOYMENT_ID}/memory`, {
                headers: {
                    'cookie': `token=${VPS_TOKEN}`,
                    'accept': 'application/json'
                }
            })
        ]);

        const cpuData = await cpuResponse.json();
        const memoryData = await memoryResponse.json();

        // Obtener último valor de cada métrica
        const latestCPU = cpuData.values?.[cpuData.values.length - 1];
        const latestMemory = memoryData.values?.[memoryData.values.length - 1];

        return {
            cpu: latestCPU?.value || 0,
            memory: latestMemory?.value || 0,
            timestamp: Date.now()
        };
    } catch (error) {
        console.error('❌ Error obteniendo métricas VPS:', error.message);
        return null;
    }
}

function formatMetrics(metrics) {
    if (!metrics) return 'N/A';
    return `CPU: ${metrics.cpu.toFixed(1)}% | RAM: ${metrics.memory.toFixed(1)}%`;
}

// ═══════════════════════════════════════════════════════════════════════
// DATABASE CLEANUP
// ═══════════════════════════════════════════════════════════════════════

async function login() {
    console.log('🔐 Autenticando...');

    const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, collection: '_superusers' })
    });

    const data = await response.json();

    if (response.ok) {
        authToken = data.token;
        console.log('✅ Autenticado correctamente\n');
        return true;
    } else {
        console.error('❌ Error de autenticación:', data.error);
        return false;
    }
}

async function getCollections() {
    const response = await fetch(`${API_URL}/api/collections/_collections/records`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    });

    const data = await response.json();
    return data.items || [];
}

async function deleteCollection(collectionName) {
    // No eliminar colecciones del sistema
    const systemCollections = ['_superusers', '_collections', '_rules'];
    if (systemCollections.includes(collectionName)) {
        return { skipped: true, reason: 'Sistema' };
    }

    try {
        // Obtener todos los registros
        const listResponse = await fetch(
            `${API_URL}/api/collections/${collectionName}/records?perPage=10000`,
            { headers: { 'Authorization': `Bearer ${authToken}` } }
        );

        const listData = await listResponse.json();
        const records = listData.items || [];

        // Eliminar todos los registros
        let deleted = 0;
        for (const record of records) {
            const deleteResponse = await fetch(
                `${API_URL}/api/collections/${collectionName}/records/${record.id}`,
                {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${authToken}` }
                }
            );

            if (deleteResponse.ok) deleted++;
        }

        return { deleted, total: records.length };
    } catch (error) {
        return { error: error.message };
    }
}

async function cleanDatabase() {
    console.log('🧹 Limpiando base de datos...\n');

    const collections = await getCollections();
    const results = [];

    for (const collection of collections) {
        process.stdout.write(`  Limpiando ${collection.name}... `);

        const result = await deleteCollection(collection.name);

        if (result.skipped) {
            console.log(`⏭️  Omitido (${result.reason})`);
        } else if (result.error) {
            console.log(`❌ Error: ${result.error}`);
        } else {
            console.log(`✅ ${result.deleted}/${result.total} registros eliminados`);
        }

        results.push({ collection: collection.name, ...result });
    }

    console.log('\n✅ Limpieza completada\n');
    return results;
}

// ═══════════════════════════════════════════════════════════════════════
// PROGRESSIVE STRESS TESTING
// ═══════════════════════════════════════════════════════════════════════

const STRESS_LEVELS = [
    { name: 'warm', ops: 100, concurrent: 10 },
    { name: 'medium', ops: 500, concurrent: 50 },
    { name: 'high', ops: 2000, concurrent: 100 },
    { name: 'extreme', ops: 5000, concurrent: 200 },
    { name: 'breaking', ops: 10000, concurrent: 500 }
];

async function runStressTest(level) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🔥 NIVEL: ${level.name.toUpperCase()} (${level.ops} ops, ${level.concurrent} concurrent)`);
    console.log('═'.repeat(70));

    const metricsStart = await getVPSMetrics();
    console.log(`📊 VPS Inicial: ${formatMetrics(metricsStart)}\n`);

    // Ejecutar stress test usando el módulo existente
    const { spawn } = require('child_process');
    const path = require('path');

    // Ruta correcta: desde nanodb/ ejecutar test/stress-test.js
    const scriptPath = path.join(__dirname, 'stress-test.js');

    return new Promise((resolve) => {
        const child = spawn('node', [scriptPath, level.name, 'crud'], {
            cwd: path.join(__dirname, '..'), // Ejecutar desde nanodb/
            stdio: 'inherit'
        });

        // Capturar métricas a mitad del test
        let metricsMid = null;
        const midCaptureTimeout = setTimeout(async () => {
            metricsMid = await getVPSMetrics();
            console.log(`\n📊 VPS Medio: ${formatMetrics(metricsMid)}`);
        }, 15000); // 15 segundos después de iniciar

        child.on('close', async (code) => {
            clearTimeout(midCaptureTimeout);

            const metricsEnd = await getVPSMetrics();
            console.log(`\n📊 VPS Final: ${formatMetrics(metricsEnd)}`);

            // Calcular tendencia
            if (metricsStart && metricsEnd) {
                const cpuDelta = metricsEnd.cpu - metricsStart.cpu;
                const ramDelta = metricsEnd.memory - metricsStart.memory;

                console.log(`\n📈 Tendencia: CPU ${cpuDelta > 0 ? '+' : ''}${cpuDelta.toFixed(1)}% | RAM ${ramDelta > 0 ? '+' : ''}${ramDelta.toFixed(1)}%`);
            }

            resolve({
                level: level.name,
                ops: level.ops,
                concurrent: level.concurrent,
                exitCode: code,
                success: code === 0,
                metricsStart,
                metricsMid,
                metricsEnd
            });
        });
    });
}

async function findLimits() {
    console.log('\n🎯 BUSCANDO LÍMITES DEL VPS...\n');

    const results = [];
    let lastSuccessLevel = null;

    for (const level of STRESS_LEVELS) {
        const result = await runStressTest(level);
        results.push(result);

        if (result.success) {
            lastSuccessLevel = level;
            console.log(`\n✅ ${level.name} completado exitosamente`);

            // Esperar 5 segundos entre tests para que el VPS se estabilice
            console.log('\n⏳ Esperando 5 segundos antes del siguiente test...\n');
            await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
            console.log(`\n❌ ${level.name} FALLÓ - Límite encontrado`);
            break;
        }

        // Si CPU o memoria superan 90%, detener
        if (result.metricsEnd && (result.metricsEnd.cpu > 90 || result.metricsEnd.memory > 90)) {
            console.log('\n⚠️  VPS cerca del límite (>90% uso) - Deteniendo tests');
            break;
        }
    }

    return { results, lastSuccessLevel };
}

// ═══════════════════════════════════════════════════════════════════════
// REPORTING
// ═══════════════════════════════════════════════════════════════════════

function generateReport(cleanupResults, testResults) {
    console.log('\n' + '═'.repeat(70));
    console.log('📊 REPORTE FINAL - LÍMITES DEL VPS');
    console.log('═'.repeat(70));

    console.log('\n🧹 LIMPIEZA DE BASE DE DATOS:');
    let totalDeleted = 0;
    cleanupResults.forEach(r => {
        if (r.deleted) {
            console.log(`  ${r.collection}: ${r.deleted} registros eliminados`);
            totalDeleted += r.deleted;
        }
    });
    console.log(`  Total: ${totalDeleted} registros eliminados`);

    console.log('\n🔥 RESULTADOS DE STRESS TESTS:');
    testResults.results.forEach(r => {
        const status = r.success ? '✅' : '❌';
        const cpu = r.metricsEnd ? `${r.metricsEnd.cpu.toFixed(1)}%` : 'N/A';
        const mem = r.metricsEnd ? `${r.metricsEnd.memory.toFixed(1)}%` : 'N/A';

        console.log(`  ${status} ${r.level.padEnd(12)} - ${r.ops} ops, ${r.concurrent} concurrent | CPU: ${cpu} | RAM: ${mem}`);
    });

    if (testResults.lastSuccessLevel) {
        console.log('\n🎯 LÍMITES MÁXIMOS ENCONTRADOS:');
        console.log(`  Operaciones: ${testResults.lastSuccessLevel.ops}`);
        console.log(`  Concurrencia: ${testResults.lastSuccessLevel.concurrent}`);
        console.log(`  Nivel: ${testResults.lastSuccessLevel.name}`);
    }

    console.log('\n' + '═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('🚀 VPS LIMIT FINDER - NanoDB');
    console.log('═'.repeat(70));
    console.log(`Servidor: ${API_URL}`);
    console.log(`Monitoreo VPS: ${VPS_TOKEN ? '✅ Habilitado' : '❌ Deshabilitado'}`);
    console.log('═'.repeat(70));

    // 1. Autenticar
    const loginSuccess = await login();
    if (!loginSuccess) {
        process.exit(1);
    }

    // 2. Limpiar base de datos
    const cleanupResults = await cleanDatabase();

    // 3. Buscar límites
    const testResults = await findLimits();

    // 4. Generar reporte
    generateReport(cleanupResults, testResults);

    console.log('\n✅ Proceso completado\n');
}

main().catch(error => {
    console.error('\n❌ Error fatal:', error);
    process.exit(1);
});
