/*
 * The demos as the page shows them: everything they hold verifies against their trust anchors, as of the time of their
 * recording. A red here after WWCP_POI.TS moved on means the demos have to follow it (README, "The demos").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paymentOptionName } from '@open-charging-cloud/wwcp-poi';

import { ownerOfChange } from '../src/analyze.js';
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
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 27, checkpoints: 4, errors: 0, warnings: 0 });
    assert.equal(summary.anchor, 'pinned');
    assert.deepEqual(summary.head, { epoch: 1, revision: 27 });
    assert.deepEqual(summary.epochs, [ { number: 1, commits: 27, checkpoints: 4, notTaken: 0 } ]);
    assert.deepEqual(summary.proofs, [ true, true, true ]);

});

test('Thuringia: the latecomer takes EV Taler along the A4, and the proof of its station says how its EVSEs are paid', async () => {

    const report   = await analyzeDemo('thuringia');
    const proofOf  = (operatorId) => report.proofs.find(result => String(result.station.operator['@id']) === operatorId);
    const highway  = proofOf('DE*XAG');

    // Its merchant as the proof gives it: one exchange in euros, one in Swiss francs.
    assert.equal(highway.evTaler.merchant.merchantBaseURL, 'https://taler.highway-hpc.example/instances/de-xag/');
    assert.deepEqual(highway.evTaler.merchant.exchanges.map(exchange => exchange.currency).sort(), [ 'CHF', 'EUR' ]);

    // Its EVSEs, in a pool naming EVTaler, by their tariff in euros: with the exchange in euros only.
    assert.deepEqual(highway.evTaler.evses.map(({ evseId, tariff, exchanges }) => [ evseId, String(tariff['@id']), exchanges.map(exchange => paymentOptionName(exchange)[0][1]) ]),
                     [ [ 'DE*XAG*E1*1', 'DE*XAG*T_HPC', [ 'EV Taler (Thuringia Test Exchange, EUR)' ] ],
                       [ 'DE*XAG*E1*2', 'DE*XAG*T_HPC', [ 'EV Taler (Thuringia Test Exchange, EUR)' ] ] ]);

    // The operators without a merchant: nothing to say.
    assert.equal(proofOf('DE*XAB').evTaler, undefined);
    assert.equal(proofOf('DE*XAA').evTaler, undefined);

    // The merchant is changed with a key for payments (EVTaler.md 4.4).
    assert.equal(ownerOfChange({ kind: 'UpdateProperty', entityType: 'ChargingStationOperator', entityId: 'DE*XAG', propertyName: 'evTaler' }).usage, 'payments');

});
