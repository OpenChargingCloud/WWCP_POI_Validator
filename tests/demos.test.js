/*
 * The demos as the page shows them: everything they hold verifies against their trust anchors, as of the time of their
 * recording. A red here after WWCP_POI.TS moved on means the demos have to follow it (README, "The demos").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDemo, readDemo, summaryOf } from './helpers.js';


test('QA: the roaming network of the WWCP_POI examples A1 to A14 verifies', async () => {

    const summary = summaryOf(await analyzeDemo('qa'));

    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 24, checkpoints: 8, errors: 0, warnings: 0 });
    assert.equal(summary.anchor, 'pinned');
    assert.deepEqual(summary.head, { epoch: 2, revision: 8 });

    // Two epochs, ECDSA/SHA-256 and then ML-DSA/SHA-512, every commit and checkpoint taken.
    assert.deepEqual(summary.epochs, [
        { number: 1, commits: 16, checkpoints: 7, notTaken: 0 },
        { number: 2, commits:  8, checkpoints: 1, notTaken: 0 },
    ]);

    assert.deepEqual(summary.proofs,               [ true, true, true, true ]);
    assert.deepEqual(summary.evidence,             [ true ]);
    assert.deepEqual(summary.commitProofs,         [ true, true, true, true ]);
    assert.deepEqual(summary.priceStatementProofs, [ true ]);
    assert.deepEqual(summary.attestations,         [ true, true, true ]);
    assert.deepEqual(summary.qiDigital,            [ true, true, true, true ]);
    assert.equal(summary.archive, true);

});

test('QA: a day after the recording, the station proofs are refused, as their attestations expired', async () => {

    const { manifest } = readDemo('qa');
    const summary      = summaryOf(await analyzeDemo('qa', { settings: { at: Date.parse(manifest.recordedAt) + 24 * 3600 * 1000 } }));

    assert.equal(summary.verdict.level, 'error');
    assert.deepEqual(summary.proofs, [ false, false, false, false ]);
    assert.ok(summary.errors.every(text => /^The proof '.+' does not verify: Valid attestations of trusted keys of 0 holders/.test(text)), summary.errors.join('\n'));

    // The history itself does not expire.
    assert.equal(summary.verdict.commits, 24);
    assert.equal(summary.verdict.checkpoints, 8);

});

test('Thuringia: the generated test network verifies', async () => {

    const summary = summaryOf(await analyzeDemo('thuringia'));

    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 25, checkpoints: 4, errors: 0, warnings: 0 });
    assert.equal(summary.anchor, 'pinned');
    assert.deepEqual(summary.head, { epoch: 1, revision: 25 });
    assert.deepEqual(summary.epochs, [ { number: 1, commits: 25, checkpoints: 4, notTaken: 0 } ]);
    assert.deepEqual(summary.proofs, [ true, true, true ]);

});
