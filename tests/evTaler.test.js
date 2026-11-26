/*
 * The file an app kept of a session paid with EV Taler (WWCP_POI example A16), as the page checks it: the station proof as
 * the session began, the steps one after the other, the settlement statement; and what is refused where a part of it was
 * changed after it was signed or made.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVTalerSignedMeterValue, fromBase64, toBase64 } from '@open-charging-cloud/wwcp-poi';

import { verifyOCMF } from '../src/evTaler.js';
import { analyzeDemo, readDemo, replaceOnce, summaryOf } from './helpers.js';


const FILE = 'evidence-DE_GEF_E1_1-evTaler.json';

const sessionOf = (report) => {
    assert.equal(report.evTalerEvidence.length, 1);
    return report.evTalerEvidence[0];
};


test('EV Taler, A16: the session paid in two steps verifies from the file alone', async () => {

    const report  = await analyzeDemo('qa');
    const session = sessionOf(report);

    assert.deepEqual(summaryOf(report).errors, []);
    assert.equal(session.ok, true);
    assert.equal(session.evseId, 'DE*GEF*E1*1');

    // The trust anchor of the demo names the keys of epoch 1: the station is verified with those the history followed it to.
    assert.equal(session.basis, 'followed');
    assert.equal(String(session.station.chargingStation['@id']), 'DE*GEF*S1');

    // Two steps of 5 kWh each, the second after the first, both recalculated.
    assert.deepEqual(session.steps.map(step => [ step.ok, step.terms.orderId, step.terms.step.covers.toString(), step.terms.amount.toFixed(2), step.verified.amountCheck ]),
                     [ [ true, '2026.309-01GEF1', '0 to 5 kWh', '3.95', 'exact' ], [ true, '2026.309-02GEF1', '5 to 10 kWh', '2.95', 'exact' ] ]);
    assert.equal(session.steps[0].verified.priceStatement.digest, '8d96537e64fe90933dcc0f6d257e9318843f7b2372e5d96c0aba50a1e925ec9e');
    assert.equal(session.steps[1].verified.start.reading.energy.toString(), '1234.567');

    // 8.214 kWh by the signed meter values, 4.85 of 6.90 paid, 2.05 refunded.
    assert.equal(session.verification.energy.toString(), '8.214');
    assert.equal(session.verification.start.reading.meterSerialNumber, 'DCM-2026-001-1');
    assert.equal(session.verification.priceCheck, 'exact');
    assert.deepEqual([ session.settlement.price, session.settlement.paid, session.settlement.refunded ].map(amount => amount.toFixed(2)), [ '4.85', '6.90', '2.05' ]);

});

test('EV Taler, A16: with the ML-DSA trust anchor of epoch 2, the station is verified against the trust anchor itself', async () => {

    const anchor  = readDemo('qa').manifest.alternativeTrustAnchors.find(({ label }) => label.includes('ML-DSA'));
    const session = sessionOf(await analyzeDemo('qa', { settings: { trustAnchorText: anchor.text } }));

    assert.equal(session.ok, true);
    assert.equal(session.basis, 'pinned');

});

test('EV Taler, A16: with the trust anchor of the genesis alone and no history, the station proof is refused, and nothing after it is checked', async () => {

    const { manifest, files } = readDemo('qa');
    const anchor  = manifest.alternativeTrustAnchors.find(({ label }) => label.startsWith('QA at its genesis'));
    const report  = await analyzeDemo('qa', { settings: { trustAnchorText: anchor.text }, change: all => { for (const name of [ ...all.keys() ]) if (name !== FILE) all.delete(name); } });
    const session = sessionOf(report);

    assert.ok(files.has(FILE));
    assert.equal(session.ok, false);
    assert.equal(session.failedAt, 'the proof of its charging station');
    assert.deepEqual(session.steps, []);

});

test('EV Taler, A16: a price lowered in the settlement statement after it was signed is refused', async () => {

    const report  = await analyzeDemo('qa', { change: files => replaceOnce(files, FILE, '"price": "4.85"', '"price": "4.84"') });
    const session = sessionOf(report);

    assert.equal(session.ok, false);
    assert.equal(session.failedAt, 'its settlement statement');
    assert.deepEqual(session.steps.map(step => step.ok), [ true, true ]);
    assert.match(summaryOf(report).errors.join('\n'), /The EV Taler session of 'evidence-DE_GEF_E1_1-evTaler\.json' is refused, at its settlement statement: /);

});

test('EV Taler, A16: step 1 at less than its 5 kWh at the price of the session is refused, and step 2 is not checked', async () => {

    // 5 kWh at 0.59 are 2.95: what step 1 takes above it is its reserve, less than it is no price of the operator.
    const session = sessionOf(await analyzeDemo('qa', { change: files => replaceOnce(files, FILE, '"amount": "EUR:3.95"', '"amount": "EUR:2.00"') }));

    assert.equal(session.ok, false);
    assert.equal(session.failedAt, 'step 1');
    assert.deepEqual(session.steps.map(step => step.ok), [ false ]);
    assert.equal(session.settlement, undefined);

});

test('EV Taler, A16: without its settlement statement the steps verify, and the page says what is not known', async () => {

    const report = await analyzeDemo('qa', { change: files => {
        const text = files.get(FILE);
        const from = text.lastIndexOf(',', text.indexOf('\n  "settlement": {'));
        files.set(FILE, text.slice(0, from) + '\n}\n');
    } });
    const session = sessionOf(report);

    assert.equal(session.ok, undefined);
    assert.deepEqual(session.steps.map(step => step.ok), [ true, true ]);
    assert.deepEqual(summaryOf(report).errors, []);
    assert.match(summaryOf(report).warnings.join('\n'), /holds no settlement statement/);

});

test('OCMF: a signed meter value verifies with its key, and not after its reading was changed', () => {

    const evidence = JSON.parse(readDemo('qa').files.get(FILE));
    const json     = evidence.settlement.meterValues[0];
    const key      = { id: 'key', key: fromBase64(json.publicKey), json: {} };
    const value    = EVTalerSignedMeterValue.parse(json);
    const reading  = verifyOCMF(value, key);

    assert.equal(reading.meterSerialNumber, 'DCM-2026-001-1');
    assert.equal(reading.energy.toString(), '1234.567');
    assert.equal(reading.timestamp, Date.parse('2026-11-16T20:31:22.000Z'));

    const changed = new TextDecoder().decode(fromBase64(json.signedMeterData)).replace('"RV":1234.567', '"RV":1230.567');
    assert.throws(() => verifyOCMF(EVTalerSignedMeterValue.create(toBase64(new TextEncoder().encode(changed)), 'OCMF', json.signingMethod, json.publicKey), key), /The OCMF signature is invalid!/);

    // With the key of another meter, and in another format.
    const other = { ...key, key: fromBase64(json.publicKey).map((byte, index, bytes) => index === bytes.length - 1 ? byte ^ 1 : byte) };
    assert.throws(() => verifyOCMF(value, other), /The OCMF signature is invalid!/);
    assert.throws(() => verifyOCMF(EVTalerSignedMeterValue.create(json.signedMeterData, 'EDL', json.signingMethod, json.publicKey), key), /in OCMF only/);

});
