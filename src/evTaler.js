/*
 * The file an app kept of a charging session paid with EV Taler (WWCP_POI example A16, concepts/EVTaler.md 7): the proof of
 * the charging station as the session began, the price statements the app held, the contract terms of every step it paid,
 * and the settlement statement of the operator. Months later, when the session is disputed, the file alone decides it.
 *
 * Every verdict is the library's (`verifyChargingStation`, `EVTalerContractTerms.verify`, `EVTalerSettlement.verify`). What
 * this file adds is the order an app checks them in, which part fails where one does, and the transparency software the
 * library asks for: the signed meter values are OCMF, verified here as far as the example needs it.
 */

import { Decimal, EVTalerContractTerms, EVTalerSettlement, NetDecimal, fromBase64, fromHex, get, isArray, isObject, parseJSON, toBase64, verifySignature } from '@open-charging-cloud/wwcp-poi';
import { CoseCurves, CoseKey } from '@vanaheimr/cose';

import { ocmfTime } from './sessions.js';


const message = (e) => e instanceof Error ? e.message : String(e);

/** The DER of a SubjectPublicKeyInfo of a key on P-256 up to its point: id-ecPublicKey, prime256v1, then 04 ‖ x ‖ y. */
const P256_SPKI_PREFIX = fromHex('3059301306072a8648ce3d020106082a8648ce3d030107034200');

/** The public key on P-256 of the given SubjectPublicKeyInfo, uncompressed; refused where it is another kind of key. */
function p256KeyOf(spki) {

    if (spki.length !== P256_SPKI_PREFIX.length + 65 || P256_SPKI_PREFIX.some((byte, index) => spki[index] !== byte) || spki[P256_SPKI_PREFIX.length] !== 0x04)
        throw new Error('The measurement key is no uncompressed public key on secp256r1!');

    const point = spki.subarray(P256_SPKI_PREFIX.length + 1);
    return CoseKey.fromCoordinates(CoseCurves.P256, point.subarray(0, 32), point.subarray(32));

}

/** The signature r ‖ s, 32 bytes each, of an ECDSA signature on P-256 in DER: SEQUENCE { INTEGER r, INTEGER s }. */
function p256SignatureOf(der) {

    const invalid = () => new Error('The OCMF signature is no ECDSA signature in DER!');

    if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2)
        throw invalid();

    const integers = [];
    let offset = 2;

    while (offset < der.length) {
        const length = der[offset + 1];
        if (der[offset] !== 0x02 || length === undefined || length === 0 || length > 33 || offset + 2 + length > der.length)
            throw invalid();
        let bytes = der.subarray(offset + 2, offset + 2 + length);
        while (bytes.length > 1 && bytes[0] === 0)
            bytes = bytes.subarray(1);
        if (bytes.length > 32)
            throw invalid();
        integers.push(bytes);
        offset += 2 + length;
    }

    if (integers.length !== 2)
        throw invalid();

    const signature = new Uint8Array(64);
    signature.set(integers[0], 32 - integers[0].length);
    signature.set(integers[1], 64 - integers[1].length);
    return signature;

}

/**
 * The transparency software of this page, as the library asks for one (`EVTalerMeterValueVerifier`): OCMF of one good
 * reading in kWh, signed with ECDSA-secp256r1-SHA256, as `VerifyOCMF` of example A16 takes it. What the value says, or an
 * Error saying why it is not valid; Chargy verifies OCMF in full and the other formats of meters.
 */
export function verifyOCMF(value, key) {

    const ocmf = value.encodingMethod === 'OCMF' ? new TextDecoder().decode(fromBase64(value.signedMeterData)) : '';
    const last = ocmf.lastIndexOf('|');

    if (!ocmf.startsWith('OCMF|') || last <= 5)
        throw new Error(`This page verifies signed meter values in OCMF only, not in '${value.encodingMethod}'!`);

    const payload   = ocmf.slice(5, last);
    const signature = parseJSON(ocmf.slice(last + 1));
    const algorithm = isObject(signature) ? get(signature, 'SA') : undefined;

    if (algorithm !== undefined && algorithm !== 'ECDSA-secp256r1-SHA256')
        throw new Error(`This page verifies OCMF signed with ECDSA-secp256r1-SHA256 only, not with '${String(algorithm)}'!`);

    const signatureData = isObject(signature) ? get(signature, 'SD') : undefined;

    if (typeof signatureData !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(signatureData))
        throw new Error('The OCMF signature is no hexadecimal text!');

    try {
        verifySignature('ES256', p256KeyOf(key.key), new TextEncoder().encode(payload), toBase64(p256SignatureOf(fromHex(signatureData.toLowerCase()))));
    }
    catch (e) {
        throw new Error(/OCMF|measurement key/.test(message(e)) ? message(e) : 'The OCMF signature is invalid!');
    }

    const json     = parseJSON(payload);
    const readings = isObject(json) ? get(json, 'RD') : undefined;
    const reading  = isArray(readings) && readings.length === 1 ? readings[0] : undefined;

    if (!isObject(json) || !isObject(reading))
        throw new Error('The OCMF value holds not one reading!');

    if (reading['ST'] !== 'G' || reading['RU'] !== 'kWh')
        throw new Error('Only a good reading in kWh is taken!');

    if (typeof reading['RV'] !== 'number' && !(reading['RV'] instanceof Decimal))
        throw new Error('The OCMF reading names no energy!');

    return {
        meterSerialNumber:  String(json['MS']),
        timestamp:          ocmfTime(reading['TM']),
        energy:             NetDecimal.of(reading['RV']),
    };

}


/**
 * Checks the files apps kept of sessions paid with EV Taler, each as its app would: the station proof at the time the
 * session began, with `verifyStation(proof, { at, evseId })`, which gives `{ station, basis }` or throws; then every step
 * after the one before; then the settlement statement against the steps. A part that fails ends it: the parts after it are
 * not checked, since each builds on the one before. Every finding goes to `issue`.
 */
export function analyzeEVTalerEvidence(documents, { verifyStation }, issue) {

    return documents.map(document => {

        const json   = document.json;
        const result = {
            document,
            ok:             false,
            evseId:         String(get(json, 'EVSEId') ?? ''),
            sessionStarted: typeof get(json, 'sessionStarted') === 'string' ? get(json, 'sessionStarted') : undefined,
            steps:          [],
        };

        const refuse = (part, e) => {
            result.failedAt = part;
            result.error    = message(e);
            issue('error', `The EV Taler session of '${document.name}' is refused, at ${part}: ${result.error}`, document);
            return result;
        };

        if (result.sessionStarted === undefined || Number.isNaN(Date.parse(result.sessionStarted)))
            return refuse('the file', new Error('It does not say when the session started.'));

        // The station as the app checked it then: at the time the session began, not at the time checked here, since its
        // attestations end minutes after they were signed.
        try {
            const { station, basis } = verifyStation(get(json, 'stationProof'), { at: result.sessionStarted, evseId: result.evseId });
            result.station = station;
            result.basis   = basis;
        }
        catch (e) {
            return refuse('the proof of its charging station', e);
        }

        const terms      = get(json, 'contractTerms');
        const statements = get(json, 'priceStatements') ?? [];

        if (!isArray(terms) || terms.length === 0)
            return refuse('its steps', new Error('It holds no contract terms: no step was paid.'));

        for (const [ index, item ] of terms.entries()) {
            const step = { index, orderId: isObject(item) && typeof item['order_id'] === 'string' ? item['order_id'] : undefined };
            result.steps.push(step);
            try {
                step.terms    = EVTalerContractTerms.parse(item);
                step.verified = step.terms.verify(result.station, statements, result.steps[index - 1]?.verified, verifyOCMF);
                step.ok       = true;
            }
            catch (e) {
                step.ok    = false;
                step.error = message(e);
                return refuse(`step ${index + 1}`, e);
            }
        }

        if (get(json, 'settlement') === undefined) {
            result.ok     = undefined;
            result.detail = 'It holds no settlement statement: its steps are those of the operator, at the price as the session began, but nothing says what was delivered and refunded.';
            issue('warning', `The EV Taler session of '${document.name}' holds no settlement statement: its steps verify, what was delivered and refunded is not said.`, document);
            return result;
        }

        try {
            result.settlement   = EVTalerSettlement.parse(get(json, 'settlement'));
            result.verification = result.settlement.verify(result.station, result.steps.map(step => step.verified), verifyOCMF);
        }
        catch (e) {
            return refuse('its settlement statement', e);
        }

        result.ok = true;
        return result;

    });

}
