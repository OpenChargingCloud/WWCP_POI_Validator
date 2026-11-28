/*
 * The transparency software of the page for signed meter values in OCMF: the signature algorithms it verifies, how the
 * signature is written, and which of the readings of a value is the energy it says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVTalerSignedMeterValue, fromBase64, fromHex, toBase64 } from '@open-charging-cloud/wwcp-poi';
import { sha256 } from '@noble/hashes/sha2.js';

import { OCMF_ALGORITHMS, verifyOCMF } from '../src/ocmf.js';
import { readDemo } from './helpers.js';


const FILE  = 'evidence-DE_GEF_E1_1-evTaler.json';
const hexOf = (bytes) => [ ...bytes ].map(byte => byte.toString(16).padStart(2, '0')).join('');
const bytes = (...parts) => Uint8Array.from(parts.flatMap(part => typeof part === 'number' ? [ part ] : [ ...part ]));
const der   = (tag, ...content) => { const body = bytes(...content); return bytes(tag, ...(body.length < 0x80 ? [ body.length ] : [ 0x81, body.length ]), body); };

/** A key pair of the given algorithm of OCMF, its public key as a SubjectPublicKeyInfo with an uncompressed point. */
function keyOf(algorithm) {
    const { oid, curve } = OCMF_ALGORITHMS.get(algorithm);
    const { secretKey }  = curve.keygen();
    const spki           = der(0x30, der(0x30, der(0x06, fromHex('2a8648ce3d0201')), der(0x06, fromHex(oid))), der(0x03, 0x00, curve.getPublicKey(secretKey, false)));
    return { curve, secretKey, key: { id: 'key', key: spki, json: {} } };
}

/** An OCMF value of the given payload, signed with the given key pair: its signature object as `signature` makes it. */
function ocmfOf(pair, payload, signature = (data) => ({ SD: hexOf(data) }), method = 'ECDSA-secp256r1-SHA256') {
    const text = JSON.stringify(payload);
    const data = pair.curve.sign(sha256(new TextEncoder().encode(text)), pair.secretKey, { prehash: false, format: 'der', lowS: false });
    return EVTalerSignedMeterValue.create(toBase64(new TextEncoder().encode(`OCMF|${text}|${JSON.stringify(signature(data))}`)), 'OCMF', method, toBase64(pair.key.key));
}

const reading = (others = {}) => ({ TM: '2026-11-27T01:29:11,000+0000 S', TX: 'B', RV: 1234.567, RI: '1-b:1.8.0', RU: 'kWh', EF: '', ST: 'G', ...others });
const payload = (...readings) => ({ FV: '1.0', GI: 'Example meter', GS: 'DCM-2026-001-1', MS: 'DCM-2026-001-1', RD: readings });


test('OCMF: the signed meter value of example A16 verifies with its key, and not after its reading was changed', () => {

    const evidence = JSON.parse(readDemo('qa').files.get(FILE));
    const json     = evidence.settlement.meterValues[0];
    const key      = { id: 'key', key: fromBase64(json.publicKey), json: {} };
    const value    = EVTalerSignedMeterValue.parse(json);
    const result   = verifyOCMF(value, key);

    assert.equal(result.meterSerialNumber, 'DCM-2026-001-1');
    assert.equal(result.energy.toString(), '1234.567');
    assert.equal(result.timestamp, Date.parse('2026-11-27T01:29:11.000Z'));
    assert.equal(result.algorithm, 'ECDSA-secp256r1-SHA256');
    assert.equal(result.readings, 1);

    const changed = new TextDecoder().decode(fromBase64(json.signedMeterData)).replace('"RV":1234.567', '"RV":1230.567');
    assert.throws(() => verifyOCMF(EVTalerSignedMeterValue.create(toBase64(new TextEncoder().encode(changed)), 'OCMF', json.signingMethod, json.publicKey), key), /The OCMF signature is invalid!/);

    // With the key of another meter, and in another format.
    const other = { ...key, key: fromBase64(json.publicKey).map((byte, index, all) => index === all.length - 1 ? byte ^ 1 : byte) };
    assert.throws(() => verifyOCMF(value, other), /The OCMF signature is invalid!/);
    assert.throws(() => verifyOCMF(EVTalerSignedMeterValue.create(json.signedMeterData, 'EDL', json.signingMethod, json.publicKey), key), /in OCMF only/);

});

test('OCMF: every curve the page verifies, each with SHA-256, and only with a key on the curve the signature names', () => {

    const verified = [ ...OCMF_ALGORITHMS ].filter(([ , { curve } ]) => curve !== undefined).map(([ name ]) => name);

    assert.deepEqual(verified, [ 'ECDSA-secp256k1-SHA256', 'ECDSA-secp256r1-SHA256', 'ECDSA-brainpool256r1-SHA256', 'ECDSA-secp384r1-SHA256', 'ECDSA-brainpool384r1-SHA256' ]);

    for (const name of verified) {

        const pair   = keyOf(name);
        const signed = (data) => ({ SA: name, SD: hexOf(data) });
        const result = verifyOCMF(ocmfOf(pair, payload(reading()), signed, name), pair.key);

        assert.equal(result.algorithm, name);
        assert.equal(result.energy.toString(), '1234.567');

        // The same value with the key of another meter on that curve, and with a signature changed in its last byte.
        assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), signed, name), keyOf(name).key), /The OCMF signature is invalid!/, name);
        assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), (data) => signed(data.map((byte, index) => index === data.length - 1 ? byte ^ 1 : byte)), name), pair.key), /The OCMF signature is invalid!/, name);

    }

    // A signature naming one curve, a key on another: refused before anything is calculated.
    const p256 = keyOf('ECDSA-secp256r1-SHA256');
    assert.throws(() => verifyOCMF(ocmfOf(p256, payload(reading()), (data) => ({ SA: 'ECDSA-secp256k1-SHA256', SD: hexOf(data) })), p256.key), /signed with ECDSA-secp256k1-SHA256, but the measurement key is on another curve/);

    // Without a name it is secp256r1: a key on secp384r1 is none for it.
    const p384 = keyOf('ECDSA-secp384r1-SHA256');
    assert.throws(() => verifyOCMF(ocmfOf(p384, payload(reading())), p384.key), /signed with ECDSA-secp256r1-SHA256, but the measurement key is on another curve/);

    // What OCMF knows and the page does not verify, and what OCMF does not know.
    assert.throws(() => verifyOCMF(ocmfOf(p256, payload(reading()), (data) => ({ SA: 'ECDSA-secp192r1-SHA256', SD: hexOf(data) })), p256.key), /does not verify OCMF signed with ECDSA-secp192r1-SHA256/);
    assert.throws(() => verifyOCMF(ocmfOf(p256, payload(reading()), (data) => ({ SA: 'RSA-2048-SHA256',        SD: hexOf(data) })), p256.key), /'RSA-2048-SHA256', which OCMF does not know/);

    // A key that is none on an elliptic curve.
    assert.throws(() => verifyOCMF(ocmfOf(p256, payload(reading())), { ...p256.key, key: p256.key.key.subarray(0, 20) }), /no public key on an elliptic curve/);

});

test('OCMF: the signature in hexadecimal or in Base64, in DER only', () => {

    const pair = keyOf('ECDSA-secp256r1-SHA256');

    assert.equal(verifyOCMF(ocmfOf(pair, payload(reading()), (data) => ({ SA: 'ECDSA-secp256r1-SHA256', SE: 'hex',    SM: 'application/x-der', SD: hexOf(data).toUpperCase() })), pair.key).energy.toString(), '1234.567');
    assert.equal(verifyOCMF(ocmfOf(pair, payload(reading()), (data) => ({ SA: 'ECDSA-secp256r1-SHA256', SE: 'base64', SD: toBase64(data) })),                                     pair.key).energy.toString(), '1234.567');

    assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), (data) => ({ SD: toBase64(data) })),               pair.key), /no hexadecimal text/);
    assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), ()     => ({ SE: 'base64', SD: '***' })),          pair.key), /no Base64 text/);
    assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), (data) => ({ SE: 'base32', SD: hexOf(data) })),    pair.key), /encoded as 'base32', which OCMF does not know/);
    assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), (data) => ({ SM: 'text/plain', SD: hexOf(data) })), pair.key), /format 'text\/plain'/);
    assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), (data) => ({ SD: hexOf(data.subarray(0, 12)) })),  pair.key), /no ECDSA signature in DER/);
    assert.throws(() => verifyOCMF(ocmfOf(pair, payload(reading()), ()     => 'signed'),                               pair.key), /holds no signature/);

});

test('OCMF: of several readings the last one of energy counts, in kWh or Wh, with what it leaves out taken from the one before', () => {

    const pair   = keyOf('ECDSA-secp256r1-SHA256');
    const verify = (...readings) => verifyOCMF(ocmfOf(pair, payload(...readings)), pair.key);

    // The begin and the end of a transaction in one value: the end, which leaves out its register, its unit and its status.
    const both = verify(reading(), { TM: '2026-11-27T02:04:11,000+0000 S', TX: 'E', RV: 1242.781 });
    assert.equal(both.energy.toString(), '1242.781');
    assert.equal(both.timestamp, Date.parse('2026-11-27T02:04:11.000Z'));
    assert.deepEqual([ both.register, both.readings ], [ '1-b:1.8.0', 2 ]);

    // Watt hours are kilowatt hours by a thousand.
    assert.equal(verify(reading({ RV: 1234567, RU: 'Wh' })).energy.toString(), '1234.567');

    // A reading of something else after it, here the resistance of the cable, and one without a value, are passed over.
    assert.equal(verify(reading(), { RV: 12, RI: '1-b:99.0.0', RU: 'mOhm' }, { TX: 'T' }).energy.toString(), '1234.567');

    // Two registers of energy: the one taken from the grid, OBIS 1.8.0, wherever it stands; none of them, or both, is refused.
    assert.equal(verify(reading(), reading({ RV: 3.5, RI: '1-b:2.8.0' })).energy.toString(), '1234.567');
    assert.equal(verify(reading({ RV: 3.5, RI: '1-b:2.8.0' }), reading({ RV: 1240, RI: '01-00:01.08.00*FF' })).energy.toString(), '1240');
    assert.throws(() => verify(reading({ RI: '1-b:2.8.0' }), reading({ RI: '1-b:3.8.0' })), /readings of 2 registers, 1-b:2\.8\.0, 1-b:3\.8\.0/);
    assert.throws(() => verify(reading({ RI: '1-b:1.8.0' }), reading({ RI: '1-0:1.8.0' })), /readings of 2 registers/);

});

test('OCMF: a reading that is not good, a value without energy or without its meter is refused', () => {

    const pair   = keyOf('ECDSA-secp256r1-SHA256');
    const verify = (json) => verifyOCMF(ocmfOf(pair, json), pair.key);

    assert.throws(() => verify(payload(reading({ ST: 'T' }))),                               /status of this one is 'T', not 'G'/);
    assert.throws(() => verify(payload(reading(), { RV: 1242.781, ST: 'E' })),               /status of this one is 'E', not 'G'/);
    assert.throws(() => verify(payload(reading({ EF: 'Et' }))),                              /error flags 'Et'/);
    assert.throws(() => verify(payload(reading({ RU: 'mOhm' }))),                            /no reading of energy, in kWh or Wh/);
    assert.throws(() => verify(payload(reading({ RV: '1234.567' }))),                        /no reading of energy/);
    assert.throws(() => verify(payload()),                                                   /holds no reading!/);
    assert.throws(() => verify({ ...payload(reading()), RD: 'none' }),                       /holds no reading!/);
    assert.throws(() => verify({ ...payload(reading()), MS: undefined }),                    /names no serial number of its meter/);
    assert.throws(() => verify(payload(reading({ TM: '27.11.2026 01:29' }))),                /is no time as OCMF writes it/);

    // The first reading good, the last one of the same register not: the last one is what the value says.
    assert.equal(verify(payload(reading({ ST: 'T' }), reading({ RV: 1240 }))).energy.toString(), '1240');

});
