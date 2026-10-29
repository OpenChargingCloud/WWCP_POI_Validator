/*
 * "Load from its servers": the stand-in of tools/mock-poi-server.mjs serves the QA demo below the paths POI_API serves,
 * and what the page asks it for verifies as the demo does. Node's fetch is the browser's, without CORS.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { loadFromServers } from '../src/sources.js';
import { DocumentPool } from '../src/documents.js';
import { analyze } from '../src/analyze.js';

import { ROOT, readDemo, settingsOf, summaryOf } from './helpers.js';


const STATION_IDS = [ 'DE*GEF*S1', 'DE*GEF*E3*2' ];

let server;
let trustAnchor;


/** A port nobody listens on, to start the stand-in on: it names its own URL in its trust anchor. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

before(async () => {

    const port = await freePort();
    server     = spawn(process.execPath, [ join(ROOT, 'tools', 'mock-poi-server.mjs'), 'qa', String(port) ], { stdio: [ 'ignore', 'pipe', 'inherit' ] });

    // It replays the history of the demo first, and says so when it listens.
    await new Promise((resolve, reject) => {
        let output = '';
        server.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('Its trust anchor'))
                resolve();
        });
        server.once('exit', code => reject(new Error(`The stand-in exited with ${code} before it listened:\n${output}`)));
    });

    trustAnchor = (await (await fetch(`http://localhost:${port}/`)).json()).trustAnchor;

});

after(() => server?.kill());


/** Loads from the stand-in, with `fetch` replaced where given, and analyzes what came, as of the recording of the demo. */
async function load({ fetchWith } = {}) {

    const original = globalThis.fetch;
    const pool     = new DocumentPool();
    const progress = [];

    if (fetchWith)
        globalThis.fetch = (input, init) => fetchWith(input, init, original);

    try {
        await loadFromServers(trustAnchor, pool, { stationIds: STATION_IDS, onProgress: line => progress.push(line) });
    }
    finally {
        globalThis.fetch = original;
    }

    const report = await analyze(pool, settingsOf(readDemo('qa').manifest, { trustAnchorText: trustAnchor }));
    return { pool, progress, report, failures: pool.documents.filter(document => document.error !== undefined) };

}


test('Everything POI_API serves of the QA network verifies from the trust anchor alone', async () => {

    const { pool, report, failures } = await load();
    const summary = summaryOf(report);

    assert.deepEqual(failures.map(document => `${document.name}: ${document.error}`), []);
    assert.ok(pool.size > 20, `only ${pool.size} documents`);

    assert.deepEqual(summary.errors, []);
    assert.equal(summary.verdict.commits, 24);
    assert.equal(summary.verdict.checkpoints, 8);
    assert.deepEqual(summary.head, { epoch: 2, revision: 8 });
    assert.deepEqual(summary.proofs, [ true, true ]);
    assert.deepEqual(summary.attestations, [ true, true, true ]);
    assert.equal(summary.archive, true);

});

test('A server answering 429 is waited for as long as it asks, and asked again', async () => {

    let refused = 0;

    const { progress, report, failures } = await load({
        fetchWith: (input, init, fetch) => {
            if (String(input).endsWith('/history/snapshot?runtimeStatus=true') && refused++ === 0)
                return new Response('{"description":"Too many heavy reads: try again in 1 seconds!"}', { status: 429, headers: { 'Retry-After': '1' } });
            return fetch(input, init);
        },
    });

    assert.equal(refused, 2);
    assert.ok(progress.includes('GET /history/snapshot?runtimeStatus=true: the server asks to wait (429), asking again in 1 s …'), progress.join('\n'));
    assert.deepEqual(failures.map(document => document.error), []);
    assert.deepEqual(summaryOf(report).head, { epoch: 2, revision: 8 });

});

test('Where Retry-After can not be read, the seconds the description of the 429 names are waited', async () => {

    let refused = 0;

    const { progress, failures } = await load({
        fetchWith: (input, init, fetch) => {
            if (String(input).endsWith('/history/snapshot?runtimeStatus=true') && refused++ === 0)
                return new Response('{"description":"Too many heavy reads: try again in 2 seconds!"}', { status: 429 });
            return fetch(input, init);
        },
    });

    assert.ok(progress.includes('GET /history/snapshot?runtimeStatus=true: the server asks to wait (429), asking again in 2 s …'), progress.join('\n'));
    assert.ok(progress.includes('GET /history/snapshot?runtimeStatus=true: the server asks to wait (429), asking again in 1 s …'), progress.join('\n'));
    assert.deepEqual(failures.map(document => document.error), []);

});

test('A server answering nothing but 429 is given up after six times', async () => {

    let asked = 0;
    const pool = new DocumentPool();
    const original = globalThis.fetch;

    globalThis.fetch = async () => {
        asked++;
        return new Response('{"description":"Too many heavy reads!"}', { status: 429, headers: { 'Retry-After': '0' } });
    };

    try {
        await assert.rejects(loadFromServers(trustAnchor, pool), /^Error: No server of the trust anchor answered: .+: no answer$/);
    }
    finally {
        globalThis.fetch = original;
    }

    // The epochs, then the current epoch: six times each.
    assert.equal(asked, 12);
    assert.deepEqual(pool.documents.map(document => document.error), [
        'HTTP 429: {"description":"Too many heavy reads!"} (asked 6 times)',
        'HTTP 429: {"description":"Too many heavy reads!"} (asked 6 times)',
    ]);

});
