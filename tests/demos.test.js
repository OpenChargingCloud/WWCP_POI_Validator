/*
 * The demos as the page shows them: everything they hold verifies against their trust anchors, as of the time of their
 * recording. A red here after WWCP_POI.TS moved on means the demos have to follow it (README, "The demos").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrustAnchor, paymentOptionName } from '@open-charging-cloud/wwcp-poi';

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

test('QA: with the trust anchor of the ML-DSA keys of epoch 2, the history is anchored at the first checkpoint it carries', async () => {

    const { manifest } = readDemo('qa');
    const report       = await analyzeDemo('qa', { settings: { trustAnchorText: manifest.alternativeTrustAnchors[0].text } });
    const summary      = summaryOf(report);

    // As with the trust anchor of the genesis: everything verifies.
    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 24, checkpoints: 8, errors: 0, warnings: 0 });
    assert.deepEqual(summary.proofs,   [ true, true, true, true ]);
    assert.ok(report.proofs.every(result => result.basis === 'pinned'));

    // The key statement of the genesis names the keys of epoch 1 only. Checkpoint 0 of epoch 2 is the first one the trust
    // anchor carries: it binds the genesis of epoch 1, its 16 commits and 7 checkpoints, and the derived genesis of epoch 2
    // with its first 2 commits.
    const { from, epoch, sequence, revision, commits, checkpoints, hashes } = report.lateAnchor;
    assert.deepEqual({ from, epoch, sequence, revision, commits, checkpoints, hashes }, { from: { epoch: 1, revision: 0 }, epoch: 2, sequence: 0, revision: 2, commits: 20, checkpoints: 7, hashes: [ 'sha256', 'sha512' ] });
    assert.equal(report.epochs[0].steps[0].trust.basis, 'later');

    const bound = (step) => step.checks.some(check => check.label.startsWith('Bound by checkpoint 0 of epoch 2'));
    const at    = report.epochs[1].steps.findIndex(step => step.anchors !== undefined);
    assert.ok(report.epochs[0].steps.every(bound));
    assert.deepEqual(report.epochs[1].steps.map(bound), report.epochs[1].steps.map((step, index) => index < at));

    // Before it, each commit is signed by the quorum of the keys the history states itself.
    assert.ok(report.epochs[0].steps.filter(step => step.type === 'commit').every(step => step.operatorCheck.ok === true));

});

test('QA: with a trust anchor no checkpoint carries, the history is refused, and no proof verifies by the keys it states itself', async () => {

    const { manifest } = readDemo('qa');
    const later        = TrustAnchor.parse(manifest.alternativeTrustAnchors[0].text);
    const nobody       = TrustAnchor.create(later.id, later.urls, [ [ 'a'.repeat(64) ], [ 'b'.repeat(64) ] ], 2);
    const report       = await analyzeDemo('qa', { settings: { trustAnchorText: nobody.toQRCode() } });
    const summary      = summaryOf(report);

    assert.equal(report.lateAnchor, undefined);
    assert.match(summary.errors[0], /^The key statement of the roaming network operator of revision 0 of epoch 1 does not verify against the trust anchor: .+ Nor does the trust anchor carry a later checkpoint/);
    assert.equal(report.followedAnchor, undefined);
    assert.deepEqual(summary.proofs, [ false, false, false, false ]);

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
