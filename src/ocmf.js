/*
 * The transparency software of this page for signed meter values in OCMF, the Open Charge Metering Format:
 * `OCMF|{payload}|{signature}`, the payload a JSON object with the serial number of the meter (MS) and its readings (RD),
 * the signature a JSON object with its algorithm (SA), its encoding (SE), its format (SM) and its data (SD).
 *
 * What is verified: ECDSA with SHA-256 over the payload as it stands between the bars, on secp256r1, secp384r1, secp256k1,
 * brainpoolP256r1 and brainpoolP384r1, with the public key a station proof gives as a SubjectPublicKeyInfo, whose curve
 * has to be the one the signature names. What is read: the last good reading of energy the meter signed, in kWh or Wh.
 *
 * Chargy verifies OCMF in full, with what its versions and the meters of several makers differ in, and the other formats
 * of meters: this page reads what a session paid with EV Taler needs of a value, one energy at one time.
 */

import { Decimal, NetDecimal, fromBase64, fromHex, get, isArray, isObject, parseJSON } from '@open-charging-cloud/wwcp-poi';
import { brainpoolP256r1, brainpoolP384r1 } from '@noble/curves/misc.js';
import { p256, p384 } from '@noble/curves/nist.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { ocmfTime } from './sessions.js';


const message = (e) => e instanceof Error ? e.message : String(e);
const hexOf   = (bytes) => [ ...bytes ].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The signature algorithm of a value that names none (OCMF, SA). */
export const OCMF_DEFAULT_ALGORITHM = 'ECDSA-secp256r1-SHA256';

/**
 * The signature algorithms of OCMF, each with the object identifier of its curve as a SubjectPublicKeyInfo names it, the
 * length of a coordinate and the curve itself; without a curve where this page knows the algorithm and does not verify it.
 */
export const OCMF_ALGORITHMS = new Map([
    [ 'ECDSA-secp192k1-SHA256',      { oid: '2b8104001f',         size: 24 } ],
    [ 'ECDSA-secp256k1-SHA256',      { oid: '2b8104000a',         size: 32, curve: secp256k1       } ],
    [ 'ECDSA-secp192r1-SHA256',      { oid: '2a8648ce3d030101',   size: 24 } ],
    [ 'ECDSA-secp256r1-SHA256',      { oid: '2a8648ce3d030107',   size: 32, curve: p256            } ],
    [ 'ECDSA-brainpool256r1-SHA256', { oid: '2b2403030208010107', size: 32, curve: brainpoolP256r1 } ],
    [ 'ECDSA-secp384r1-SHA256',      { oid: '2b81040022',         size: 48, curve: p384            } ],
    [ 'ECDSA-brainpool384r1-SHA256', { oid: '2b240303020801010b', size: 48, curve: brainpoolP384r1 } ],
]);

/** id-ecPublicKey, 1.2.840.10045.2.1. */
const EC_PUBLIC_KEY = '2a8648ce3d0201';


/** The element of DER at the given offset: its tag, its content and where the next one begins; undefined where it is none. */
function derAt(bytes, offset) {

    const tag   = bytes[offset];
    const first = bytes[offset + 1];

    if (tag === undefined || first === undefined)
        return undefined;

    let length = first;
    let start  = offset + 2;

    if (first >= 0x80) {
        const count = first & 0x7f;
        if (count === 0 || count > 2 || start + count > bytes.length)
            return undefined;
        length = 0;
        for (let i = 0; i < count; i++)
            length = (length << 8) | bytes[start + i];
        start += count;
    }

    return start + length > bytes.length
               ? undefined
               : { tag, content: bytes.subarray(start, start + length), end: start + length };

}

/**
 * The public key of the given SubjectPublicKeyInfo, SEQUENCE { SEQUENCE { id-ecPublicKey, curve }, BIT STRING }: the
 * object identifier of its curve in hexadecimal, and its point, compressed or not. Refused where it is another kind of key.
 */
function ecKeyOf(spki) {

    const invalid   = () => new Error('The measurement key is no public key on an elliptic curve, as a SubjectPublicKeyInfo writes it!');
    const outer     = derAt(spki, 0);
    const algorithm = outer?.tag === 0x30 && outer.end === spki.length ? derAt(outer.content, 0) : undefined;
    const kind      = algorithm?.tag === 0x30 ? derAt(algorithm.content, 0) : undefined;
    const curve     = kind?.tag === 0x06 ? derAt(algorithm.content, kind.end) : undefined;
    const bits      = algorithm !== undefined ? derAt(outer.content, algorithm.end) : undefined;

    if (kind === undefined || hexOf(kind.content) !== EC_PUBLIC_KEY || curve?.tag !== 0x06 || bits?.tag !== 0x03 || bits.content[0] !== 0x00 || bits.content.length < 2)
        throw invalid();

    return { oid: hexOf(curve.content), point: bits.content.subarray(1) };

}

/** The signature r ‖ s, each of the given length, of an ECDSA signature in DER: SEQUENCE { INTEGER r, INTEGER s }. */
function compactSignatureOf(der, size) {

    const invalid  = () => new Error('The OCMF signature is no ECDSA signature in DER!');
    const sequence = derAt(der, 0);

    if (sequence?.tag !== 0x30 || sequence.end !== der.length)
        throw invalid();

    const integers = [];
    let offset = 0;

    while (offset < sequence.content.length) {
        const integer = derAt(sequence.content, offset);
        if (integer?.tag !== 0x02 || integer.content.length === 0)
            throw invalid();
        let bytes = integer.content;
        while (bytes.length > 1 && bytes[0] === 0)
            bytes = bytes.subarray(1);
        if (bytes.length > size)
            throw invalid();
        integers.push(bytes);
        offset = integer.end;
    }

    if (integers.length !== 2)
        throw invalid();

    const signature = new Uint8Array(2 * size);
    signature.set(integers[0], size - integers[0].length);
    signature.set(integers[1], 2 * size - integers[1].length);
    return signature;

}

/** The bytes of the signature data of an OCMF signature, in hexadecimal unless it names Base64 (SE). */
function signatureDataOf(signature) {

    const data     = get(signature, 'SD');
    const encoding = get(signature, 'SE') ?? 'hex';

    if (encoding === 'hex') {
        if (typeof data !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(data))
            throw new Error('The OCMF signature is no hexadecimal text!');
        return fromHex(data.toLowerCase());
    }

    if (encoding === 'base64') {
        try {
            if (typeof data === 'string' && data !== '')
                return fromBase64(data);
        }
        catch { /* refused below */ }
        throw new Error('The OCMF signature is no Base64 text!');
    }

    throw new Error(`The OCMF signature is encoded as '${String(encoding)}', which OCMF does not know: hex or base64!`);

}

/**
 * Verifies the signature of an OCMF value over its payload with the given SubjectPublicKeyInfo: the algorithm it names,
 * else ECDSA-secp256r1-SHA256, on the curve of the key. The name of the algorithm, or an Error saying why it is not valid.
 */
function verifySignatureOf(payload, signature, spki) {

    if (!isObject(signature))
        throw new Error('The OCMF value holds no signature!');

    const name      = get(signature, 'SA') ?? OCMF_DEFAULT_ALGORITHM;
    const algorithm = typeof name === 'string' ? OCMF_ALGORITHMS.get(name) : undefined;
    const format    = get(signature, 'SM') ?? 'application/x-der';

    if (algorithm === undefined)
        throw new Error(`The OCMF value is signed with '${String(name)}', which OCMF does not know!`);

    if (algorithm.curve === undefined)
        throw new Error(`This page does not verify OCMF signed with ${name}: of the algorithms of OCMF, those on secp192k1 and secp192r1 are not verified here!`);

    if (format !== 'application/x-der')
        throw new Error(`The OCMF signature is in the format '${String(format)}': this page reads application/x-der only!`);

    const data = signatureDataOf(signature);
    const key  = ecKeyOf(spki);

    if (key.oid !== algorithm.oid)
        throw new Error(`The OCMF value is signed with ${name}, but the measurement key is on another curve!`);

    let valid = false;

    try {
        // The digest is SHA-256 on every curve, as OCMF has it; a meter signs as it does, with a high s as well.
        valid = algorithm.curve.verify(compactSignatureOf(data, algorithm.size), sha256(new TextEncoder().encode(payload)), key.point, { prehash: false, format: 'compact', lowS: false });
    }
    catch (e) {
        if (/in DER!$/.test(message(e)))
            throw e;
    }

    if (!valid)
        throw new Error('The OCMF signature is invalid!');

    return name;

}

/** Kilowatt hours of a reading in the given unit of energy; undefined for another unit. */
function kWhOf(value, unit) {

    if ((typeof value !== 'number' && !(value instanceof Decimal)) || (unit !== 'kWh' && unit !== 'Wh'))
        return undefined;

    const energy = NetDecimal.of(value);
    return unit === 'kWh' ? energy : energy.dividedBy(NetDecimal.of(1000));

}

/** Whether a reading identification names the total of the energy taken from the grid, OBIS 1.8.0, written with leading zeros as well. */
const isImportRegister = (identification) => typeof identification === 'string' && /(^|[^0-9])0?1\.0?8\.0?0([^0-9]|$)/.test(identification);

/**
 * The energy an OCMF payload says: of its readings of energy, in kWh or Wh, the last one. A reading leaves out what the one
 * before said, but its value. Where they are of several registers, those of the energy taken from the grid (OBIS 1.8.0)
 * count; it has to be a good reading (ST "G") without an error flag. Refused where no reading says one energy.
 */
function readingOf(json) {

    const readings = get(json, 'RD');

    if (!isArray(readings) || readings.length === 0 || !readings.every(isObject))
        throw new Error('The OCMF value holds no reading!');

    const effective = [];
    let inherited   = {};

    for (const reading of readings) {
        const { RV, ...others } = reading;
        inherited = { ...inherited, ...others };
        effective.push({ ...inherited, RV });
    }

    const energies  = effective.flatMap(reading => {
        const energy = kWhOf(reading['RV'], reading['RU']);
        return energy === undefined ? [] : [ { reading, energy, register: typeof reading['RI'] === 'string' ? reading['RI'] : undefined } ];
    });

    if (energies.length === 0)
        throw new Error('The OCMF value holds no reading of energy, in kWh or Wh!');

    const registers = [ ...new Set(energies.map(({ register }) => register)) ];
    const imports   = registers.filter(isImportRegister);

    if (registers.length > 1 && imports.length !== 1)
        throw new Error(`The OCMF value holds readings of ${registers.length} registers, ${registers.map(register => register ?? 'one without a name').join(', ')}: which of them is the energy charged is not said!`);

    const register = registers.length > 1 ? imports[0] : registers[0];
    const last     = energies.filter(item => item.register === register).at(-1);

    if (last.reading['ST'] !== 'G')
        throw new Error(`Only a good reading is taken: the status of this one is '${String(last.reading['ST'] ?? '')}', not 'G'!`);

    if (typeof last.reading['EF'] === 'string' && last.reading['EF'] !== '')
        throw new Error(`The reading carries the error flags '${last.reading['EF']}'!`);

    return { ...last, register, readings: readings.length };

}

/**
 * The transparency software of this page, as WWCP_POI.TS asks for one (`EVTalerMeterValueVerifier`): what the signed meter
 * value says, verified with the given measurement key, or an Error saying why it is not valid. Besides what the library
 * reads of it, the serial number of the meter, the time and the energy in kWh: the algorithm it was verified with, the
 * register read, and how many readings the value holds.
 */
export function verifyOCMF(value, key) {

    let ocmf = '';

    try {
        ocmf = value.encodingMethod === 'OCMF' ? new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(value.signedMeterData)) : '';
    }
    catch { /* refused below */ }

    const last = ocmf.lastIndexOf('|');

    if (!ocmf.startsWith('OCMF|') || last <= 5)
        throw new Error(`This page verifies signed meter values in OCMF only, not in '${value.encodingMethod}'!`);

    const payload   = ocmf.slice(5, last);
    const algorithm = verifySignatureOf(payload, parseJSON(ocmf.slice(last + 1)), key.key);
    const json      = parseJSON(payload);

    if (!isObject(json))
        throw new Error('The OCMF value holds no payload!');

    if (typeof json['MS'] !== 'string' || json['MS'] === '')
        throw new Error('The OCMF value names no serial number of its meter!');

    const { reading, energy, register, readings } = readingOf(json);

    return {
        meterSerialNumber:  json['MS'],
        timestamp:          ocmfTime(reading['TM']),
        energy,
        algorithm,
        register,
        readings,
    };

}
