/*
 * The demos as the page shows them: everything they hold verifies against their trust anchors, as of the time of their
 * recording. A red here after WWCP_POI.TS moved on means the demos have to follow it (README, "The demos").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrustAnchor, paymentOptionName } from '@open-charging-cloud/wwcp-poi';

import { ownerOfChange } from '../src/analyze.js';
import { offersSessionsURL, webPaymentPageOf } from '../src/payments.js';
import { analyzeDemo, readDemo, summaryOf } from './helpers.js';


test('QA: the roaming network of the WWCP_POI examples A1 to A16 verifies', async () => {

    const report  = await analyzeDemo('qa');
    const summary = summaryOf(report);

    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 29, checkpoints: 8, errors: 0, warnings: 0 });
    assert.equal(summary.anchor, 'pinned');
    assert.deepEqual(summary.head, { epoch: 2, revision: 11 });

    // The genesis is of AlphaOrg alone, which the trust anchor of the three holders of today does not verify as it is:
    // the history is anchored at the first checkpoint the trust anchor carries, checkpoint 0 of epoch 1 at revision 9.
    const { from, epoch, sequence, revision, commits } = report.lateAnchor;
    assert.deepEqual({ from, epoch, sequence, revision, commits }, { from: { epoch: 1, revision: 0 }, epoch: 1, sequence: 0, revision: 9, commits: 10 });

    // The holders of OCC join one by one (A1): revision 1 is signed by AlphaOrg and BetaOrg, two of two, revision 2 by
    // all three, two of three, each by the keys it states anew; every commit since by the keys trusted before it.
    const signed = report.epochs[0].steps.filter(step => step.type === 'commit').map(step => step.operatorCheck);
    assert.deepEqual(signed.slice(0, 3).map(({ ok, holders, required, byKeysStatedAnew }) => ({ ok, holders, required, byKeysStatedAnew })),
                     [ { ok: true, holders: [ 'AlphaOrg', 'BetaOrg' ],             required: 2, byKeysStatedAnew: true      },
                       { ok: true, holders: [ 'AlphaOrg', 'BetaOrg', 'GammaOrg' ], required: 2, byKeysStatedAnew: true      },
                       { ok: true, holders: [ 'AlphaOrg', 'BetaOrg', 'GammaOrg' ], required: 2, byKeysStatedAnew: undefined } ]);
    assert.ok(signed.slice(2).every(check => check.ok === true && check.byKeysStatedAnew === undefined));

    // The URLs of its copies, part of what the operator signs.
    assert.deepEqual(readDemo('qa').manifest.alternativeTrustAnchors.map(anchor => TrustAnchor.parse(anchor.text).urls.length), [ 3, 1, 2 ]);

    // Two epochs, ECDSA/SHA-256 and then ML-DSA/SHA-512, every commit and checkpoint taken.
    assert.deepEqual(summary.epochs, [
        { number: 1, commits: 18, checkpoints: 7, notTaken: 0 },
        { number: 2, commits: 11, checkpoints: 1, notTaken: 0 },
    ]);

    assert.deepEqual(summary.proofs,               [ true, true, true, true, true ]);
    assert.deepEqual(summary.evidence,             [ true ]);
    assert.deepEqual(summary.commitProofs,         [ true, true, true, true ]);
    assert.deepEqual(summary.priceStatementProofs, [ true ]);
    assert.deepEqual(summary.attestations,         [ true, true, true ]);
    assert.deepEqual(summary.qiDigital,            [ true, true, true, true ]);
    assert.equal(summary.archive, true);

    // EV Taler at the pool DE*GEF*P1 (A15): its EVSEs paid with the exchange in euros, as the proof of revision 11 gives
    // them; those of the other pools not with EV Taler. The proof of revision 7 is from before DE*GEF had a merchant.
    const evTaler = (name) => report.proofs.find(result => result.document.name === name).evTaler;
    assert.equal(evTaler('QA-DE-GEF-E1-1-proof.json'), undefined);
    assert.equal(evTaler('QA-DE-GEF-E1-1-evTaler-proof.json').merchant.merchantBaseURL, 'https://taler.gef.example/instances/de-gef/');
    assert.deepEqual(evTaler('QA-DE-GEF-E1-1-evTaler-proof.json').evses.map(({ evseId, exchanges }) => [ evseId, exchanges.map(exchange => paymentOptionName(exchange)[0][1]) ]),
                     [ [ 'DE*GEF*E1*1', [ 'EV Taler (Example Exchange, EUR)' ] ], [ 'DE*GEF*E1*2', [ 'EV Taler (Example Exchange, EUR)' ] ] ]);
    assert.ok(evTaler('QA-proof-station-DE_GEF_S6.json').evses.every(({ exchanges }) => exchanges.length === 0));

    // Where an app asks DE*GEF for offers, and where a driver pays ad hoc: at the page of Jena Paradies for its
    // stations, before the one of DE*GEF, which is the one of every other station. Revision 7 knew neither.
    const webPaymentPage = (name) => report.proofs.find(result => result.document.name === name).webPaymentPage;
    assert.equal(evTaler('QA-DE-GEF-E1-1-evTaler-proof.json').merchant.offersURL, 'https://poi.gef.example/RNs/QA/');
    assert.equal(offersSessionsURL(evTaler('QA-DE-GEF-E1-1-evTaler-proof.json').merchant.offersURL, 'DE*GEF*E1*1'), 'https://poi.gef.example/RNs/QA/EVSEs/DE*GEF*E1*1/evTaler/sessions');
    assert.deepEqual(webPaymentPage('QA-DE-GEF-E1-1-evTaler-proof.json'), { url: 'https://pay.gef.example/pools/P1', type: 'ChargingPool',            id: 'DE*GEF*P1' });
    assert.deepEqual(webPaymentPage('QA-proof-station-DE_GEF_S6.json'),   { url: 'https://pay.gef.example/',         type: 'ChargingStationOperator', id: 'DE*GEF' });
    assert.equal(webPaymentPage('QA-DE-GEF-E1-1-proof.json'), undefined);

    // The one-time password an EV Taler session names: the stations of Jena Paradies give it on their display, as the
    // pool says since it takes EV Taler; a pool that does not take it names no secure dynamic QR code.
    const proof = (name) => report.proofs.find(result => result.document.name === name);
    assert.deepEqual(proof('QA-DE-GEF-E1-1-evTaler-proof.json').secureDynamicQRCode, { poolId: 'DE*GEF*P1', channels: [ 'Display' ] });
    assert.ok(proof('QA-DE-GEF-E1-1-evTaler-proof.json').authenticationModes.some(mode => mode.type === 'SecureDynamicQRCode'));
    assert.equal(proof('QA-DE-GEF-E1-1-proof.json').secureDynamicQRCode, undefined);
    assert.equal(proof('QA-proof-station-DE_GEF_S6.json').secureDynamicQRCode, undefined);

});

test('QA: a day after the recording, the station proofs are refused, as their attestations expired', async () => {

    const { manifest } = readDemo('qa');
    const summary      = summaryOf(await analyzeDemo('qa', { settings: { at: Date.parse(manifest.recordedAt) + 24 * 3600 * 1000 } }));

    assert.equal(summary.verdict.level, 'error');
    assert.deepEqual(summary.proofs, [ false, false, false, false, false ]);
    assert.ok(summary.errors.every(text => /^The proof '.+' does not verify: Valid attestations of trusted keys of 0 holders/.test(text)), summary.errors.join('\n'));

    // The history itself does not expire.
    assert.equal(summary.verdict.commits, 29);
    assert.equal(summary.verdict.checkpoints, 8);

});

test('QA: with the trust anchor of the ML-DSA keys of epoch 2, the history is anchored at the first checkpoint it carries', async () => {

    const { manifest } = readDemo('qa');
    const report       = await analyzeDemo('qa', { settings: { trustAnchorText: manifest.alternativeTrustAnchors[0].text } });
    const summary      = summaryOf(report);

    // As with the trust anchor of the genesis: everything verifies.
    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 29, checkpoints: 8, errors: 0, warnings: 0 });
    assert.deepEqual(summary.proofs,   [ true, true, true, true, true ]);
    assert.ok(report.proofs.every(result => result.basis === 'pinned'));

    // The key statement of the genesis names the keys of epoch 1 only. Checkpoint 0 of epoch 2 is the first one the trust
    // anchor carries: it binds the genesis of epoch 1, its 18 commits and 7 checkpoints, and the derived genesis of epoch 2
    // with its first 2 commits.
    const { from, epoch, sequence, revision, commits, checkpoints, hashes } = report.lateAnchor;
    assert.deepEqual({ from, epoch, sequence, revision, commits, checkpoints, hashes }, { from: { epoch: 1, revision: 0 }, epoch: 2, sequence: 0, revision: 2, commits: 22, checkpoints: 7, hashes: [ 'sha256', 'sha512' ] });
    assert.equal(report.epochs[0].steps[0].trust.basis, 'later');

    const bound = (step) => step.checks.some(check => check.label.startsWith('Bound by checkpoint 0 of epoch 2'));
    const at    = report.epochs[1].steps.findIndex(step => step.anchors !== undefined);
    assert.ok(report.epochs[0].steps.every(bound));
    assert.deepEqual(report.epochs[1].steps.map(bound), report.epochs[1].steps.map((step, index) => index < at));

    // Before it, each commit is signed by the quorum of the keys the history states itself.
    assert.ok(report.epochs[0].steps.filter(step => step.type === 'commit').every(step => step.operatorCheck.ok === true));

});

test('QA: with the trust anchor of its genesis, of AlphaOrg alone, the history is followed to the keys of today', async () => {

    const { manifest } = readDemo('qa');
    const anchor       = manifest.alternativeTrustAnchors.find(({ label }) => label.startsWith('QA at its genesis'));
    const report       = await analyzeDemo('qa', { settings: { trustAnchorText: anchor.text } });
    const summary      = summaryOf(report);

    // One holder, one of one: the genesis verifies against it as it is, nothing is anchored later.
    assert.equal(TrustAnchor.parse(anchor.text).keys.length, 1);
    assert.equal(report.lateAnchor, undefined);
    assert.equal(report.epochs[0].steps[0].trust.basis, 'pinned');

    // Each key statement since is signed by the quorum trusted before it (8.6): BetaOrg and GammaOrg joining, the ML-DSA
    // keys of epoch 2. Everything verifies, the proofs of today among it.
    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.deepEqual(summary.verdict,  { level: 'ok', commits: 29, checkpoints: 8, errors: 0, warnings: 0 });
    assert.deepEqual(summary.proofs,   [ true, true, true, true, true ]);

    const followed = report.epochs[0].steps.filter(step => step.trustFollowed !== undefined).slice(0, 2);
    assert.deepEqual(followed.map(step => [ step.trustFollowed.ok, step.trustFollowed.identityKeys.map(key => key.holder).sort() ]),
                     [ [ true, [ 'AlphaOrg', 'BetaOrg' ] ], [ true, [ 'AlphaOrg', 'BetaOrg', 'GammaOrg' ] ] ]);

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
    assert.deepEqual(summary.proofs, [ false, false, false, false, false ]);

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

    // The one-time password a session names: the stations of its first charging park give it over all three channels,
    // and read RFID cards; the stations of the operators without a merchant give none.
    assert.deepEqual(highway.secureDynamicQRCode, { poolId: 'DE*XAG*P1', channels: [ 'BLE', 'Display', 'NFC' ] });
    assert.deepEqual(highway.authenticationModes.map(mode => [ mode.type, mode.cardTypes ]), [ [ 'RFID', [ 'MifareDESFire' ] ], [ 'SecureDynamicQRCode', [] ] ]);
    assert.equal(proofOf('DE*XAB').secureDynamicQRCode, undefined);

    // The operators without a merchant: nothing to say.
    assert.equal(proofOf('DE*XAB').evTaler, undefined);
    assert.equal(proofOf('DE*XAA').evTaler, undefined);

    // The merchant is changed with a key for payments (EVTaler.md 4.4).
    assert.equal(ownerOfChange({ kind: 'UpdateProperty', entityType: 'ChargingStationOperator', entityId: 'DE*XAG', propertyName: 'evTaler' }).usage, 'payments');

    // Where an app asks it for offers, and where a driver pays ad hoc at this station: at the page of its charging park,
    // which comes before the operator's.
    assert.equal(highway.evTaler.merchant.offersURL, 'https://poi.highway-hpc.example/RNs/TH/');
    assert.equal(offersSessionsURL(highway.evTaler.merchant.offersURL, 'DE*XAG*E1*1'), 'https://poi.highway-hpc.example/RNs/TH/EVSEs/DE*XAG*E1*1/evTaler/sessions');
    assert.deepEqual(highway.webPaymentPage, { url: 'https://pay.highway-hpc.example/parks/P1', type: 'ChargingPool', id: 'DE*XAG*P1' });
    assert.equal(proofOf('DE*XAB').webPaymentPage, undefined);

    // At its other charging parks the operator's, as the head of the history has them.
    const operator = report.head.version.network.effectiveContent.chargingStationOperators.find(item => item['@id'] === 'DE*XAG');
    assert.deepEqual(webPaymentPageOf({ operator, chargingPool: operator.chargingPools[1], chargingStation: operator.chargingPools[1].chargingStations[0] }),
                     { url: 'https://pay.highway-hpc.example/', type: 'ChargingStationOperator', id: 'DE*XAG' });

    // A web payment page is changed with a key for payments, and a pool is added with one by a key for both.
    const before = { content: report.head.version.network.content };
    assert.equal(ownerOfChange({ kind: 'UpdateProperty', entityType: 'ChargingStationOperator', entityId: 'DE*XAG',    propertyName: 'webPaymentURL' }, before).usage, 'payments');
    assert.equal(ownerOfChange({ kind: 'UpdateProperty', entityType: 'ChargingPool',            entityId: 'DE*XAG*P2', propertyName: 'webPaymentURL' }, before).usage, 'payments');
    assert.equal(ownerOfChange({ kind: 'UpdateProperty', entityType: 'ChargingPool',            entityId: 'DE*XAG*P2', propertyName: 'hotline' },       before).usage, 'infrastructure');
    assert.equal(ownerOfChange({ kind: 'Add', entityType: 'ChargingPool', entityId: 'DE*XAG*P99', newValue: { '@id': 'DE*XAG*P99', chargingStations: [ { '@id': 'DE*XAG*S99', webPaymentURL: 'https://pay.highway-hpc.example/s99' } ] } }, before).usage,
                 'infrastructure and payments');
    assert.equal(ownerOfChange({ kind: 'Add', entityType: 'ChargingPool', entityId: 'DE*XAG*P98', newValue: { '@id': 'DE*XAG*P98' } }, before).usage, 'infrastructure');

});
