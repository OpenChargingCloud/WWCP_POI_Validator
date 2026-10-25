/*
 * Who holds a key: the directory of all keys a version of a roaming network names (SPECIFICATION.md 4.1 and 8.6), so that
 * a signature by `keyId` can be shown as "AlphaOrg, signing key of OCC" rather than as 64 hexadecimal digits.
 */

import { CHILD_ARRAYS, POIPublicKey, get, isArray, isObject } from '@open-charging-cloud/wwcp-poi';

import { i18n } from './dom.js';


/** The party types of the arrays of a roaming network, e.g. `chargingStationOperators` → `ChargingStationOperator`. */
export const PARTY_TYPES = {
    chargingStationOperators:           'ChargingStationOperator',
    chargingStationManufacturers:       'ChargingStationManufacturer',
    eMobilityProviders:                 'EMobilityProvider',
    gridOperators:                      'GridOperator',
    parkingOperators:                   'ParkingOperator',
    energyMeterManufacturers:           'EnergyMeterManufacturer',
    transparencySoftwareManufacturers:  'TransparencySoftwareManufacturer',
    conformityAssessmentBodies:         'ConformityAssessmentBody',
};

export const PARTY_LABELS = {
    RoamingNetworkOperator:             'roaming network operator',
    ChargingStationOperator:            'charging station operator',
    ChargingStationManufacturer:        'charging station manufacturer',
    EMobilityProvider:                  'e-mobility provider',
    GridOperator:                       'grid operator',
    ParkingOperator:                    'parking operator',
    EnergyMeterManufacturer:            'energy meter manufacturer',
    TransparencySoftwareManufacturer:   'transparency software manufacturer',
    ConformityAssessmentBody:           'conformity assessment body',
    Witness:                            'witness',
};


/** The signature algorithm a key of a curve signs with, where the key names none (section 4). */
const CURVE_ALGORITHMS = { 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512', 'secp256k1': 'ES256K', 'Ed25519': 'Ed25519', 'Ed448': 'Ed448' };

/** The algorithm of a COSE key, as people know it: `ES256 · P-256`, `Ed25519`, `ML-DSA-65`. */
export function keyAlgorithm(key) {
    const cose      = key.key;
    const curve     = cose?.curve?.name;
    const algorithm = cose?.algorithm?.name ?? CURVE_ALGORITHMS[curve];
    if (algorithm && curve && algorithm !== curve)
        return `${algorithm} · ${curve}`;
    return algorithm ?? curve ?? 'unknown';
}

function entry(key, kind, owner, extra = {}) {
    return {
        id:         key.id,
        key,
        kind,
        ownerType:  owner.type,
        ownerId:    owner.id,
        ownerName:  owner.name,
        holder:     key.holder,
        usages:     key.usages ?? [],
        notBefore:  key.notBefore,
        notAfter:   key.notAfter,
        algorithm:  keyAlgorithm(key),
        ...extra,
    };
}


/**
 * Every key of a version: the identity keys of the roaming network operator and the signing keys its certificates
 * certify, the signing and identity keys of every party, and the keys of the witnesses a verifier trusts. Keyed by `@id`.
 */
export function keyDirectory(network, { anchor, witnesses = [] } = {}) {

    const directory = new Map();
    const pinned    = new Set(anchor?.keys ?? []);
    const operator  = network?.operator;

    if (operator !== undefined) {

        const owner     = { type: 'RoamingNetworkOperator', id: operator.id, name: i18n(get(operator.json, 'name')) };
        const statement = operator.keyStatement;
        const stated    = new Set(statement?.identityKeys.map(key => key.id) ?? []);
        const signedBy  = new Set(statement?.signatures.map(signature => signature.keyId) ?? []);

        for (const key of operator.identityKeys)
            directory.set(key.id, entry(key, 'identity', owner, { pinned: pinned.has(key.id), inKeyStatement: stated.has(key.id), signedKeyStatement: signedBy.has(key.id) }));

        for (const certificate of operator.signingKeyCertificates)
            directory.set(certificate.signingKey.id, entry(certificate.signingKey, 'signing', owner, { certifiedBy: certificate.keyId, certifiedAt: certificate.signedAt }));

    }

    const content = network?.content ?? {};

    for (const [ property, type ] of Object.entries(PARTY_TYPES)) {

        const parties = get(content, property);

        if (!isArray(parties))
            continue;

        for (const party of parties) {

            if (!isObject(party))
                continue;

            const owner = { type, id: String(party['@id']), name: i18n(party['name']) };

            for (const [ kind, property ] of [ [ 'signing', 'signingKeys' ], [ 'identity', 'identityKeys' ] ]) {
                let keys = [];
                try {
                    keys = POIPublicKey.parseAll(get(party, property), `${property} of ${owner.id}`);
                }
                catch {
                    continue;
                }
                for (const key of keys)
                    directory.set(key.id, entry(key, kind, owner));
            }

        }

    }

    for (const witness of witnesses)
        if (!directory.has(witness.key.id))
            directory.set(witness.key.id, entry(witness.key, 'witness', { type: 'Witness', id: witness.witness, name: witness.witness }, { trustedWitness: true }));

    return directory;

}


/** The parties of a version that hold keys, grouped by type: for the table of keys. */
export function partiesWithKeys(network) {

    const result  = [];
    const content = network?.content ?? {};

    for (const [ property, type ] of Object.entries(PARTY_TYPES)) {
        const parties = get(content, property);
        if (!isArray(parties))
            continue;
        for (const party of parties)
            if (isObject(party))
                result.push({ type, id: String(party['@id']), name: i18n(party['name']), json: party });
    }

    return result;

}

export { CHILD_ARRAYS };
