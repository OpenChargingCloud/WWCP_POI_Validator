/*
 * Generates the Thuringia test network: a roaming network of WWCP POI 3 of medium size, signed with test keys, so that
 * the validator shows what a network of several charging station operators and some hundred charging stations looks like.
 *
 *   node tools/generate-demo-network.mjs
 *
 * Everything is deterministic: the keys come from fixed seeds, the pools from a seeded random number generator, the
 * timestamps from a fixed calendar, so that running it again writes the same bytes. The ETags, identifications, trees and
 * signature inputs are calculated by WWCP_POI.TS itself, and at the end the whole history is replayed with it from the
 * trust anchor: what is written verifies, or nothing is written.
 *
 * The keys are test keys of seeds in this file: never trust them for anything.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as POI from '@open-charging-cloud/wwcp-poi';
import { CoseCurves, CoseKey, algorithmByName, signWith } from '@vanaheimr/cose';


const TARGET   = join(import.meta.dirname, '..', 'demo', 'thuringia');
const RN_ID    = 'TH';
const RNO_ID   = 'THNO';
const SERVER   = `https://poi.example/RNs/${RN_ID}`;
const encoder  = new TextEncoder();


//  ------------------------------------------------------------------
//  Determinism: seeds, a random number generator, a calendar
//  ------------------------------------------------------------------

function seedOf(text) {
    return POI.hash('sha256', encoder.encode(`wwcp-poi-validator test network: ${text}`));
}

/** mulberry32, seeded: the same network every run. */
function randomNumbers(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const random   = randomNumbers(20261020);
const pick     = (list) => list[Math.floor(random() * list.length)];
const between  = (low, high) => low + Math.floor(random() * (high - low + 1));
const round4   = (value) => Math.round(value * 10000) / 10000;

let clock = Date.parse('2026-09-01T08:00:00.000Z');
const now      = () => new Date(clock).toISOString();
const advance  = (minutes) => { clock += minutes * 60_000; return now(); };


//  ------------------------------------------------------------------
//  Keys
//  ------------------------------------------------------------------

const ALGORITHMS = {
    ES256:    { curve: CoseCurves.P256,    make: (seed) => CoseKey.fromPrivateScalar(CoseCurves.P256, seed) },
    ES384:    { curve: CoseCurves.P384,    make: (seed) => CoseKey.fromPrivateScalar(CoseCurves.P384, POI.hash('sha384', seed)) },
    Ed25519:  { curve: CoseCurves.Ed25519, make: (seed) => CoseKey.fromOkpPrivateKey(CoseCurves.Ed25519, seed) },
};

/** A key pair of a seed: the private half to sign with, the public one as POI writes it (4.1). */
function makeKey(name, algorithm, extra = {}) {
    const { curve, make } = ALGORITHMS[algorithm];
    const pair   = make(seedOf(name));
    const pub    = pair.publicKey();
    const json   = { '@id': POI.toHex(pub.thumbprint('sha256')), key: POI.toBase64(pub.toBytes()), ...extra };
    return { name, algorithm, curve, pair, json, id: json['@id'] };
}

/** Signs bytes with a key: ECDSA deterministic over the digest, EdDSA over the bytes, as POI verifies them (4). */
function sign(key, bytes) {
    return POI.toBase64(signWith(algorithmByName(key.algorithm), key.curve, bytes, key.pair.privateKeyBytes()));
}

const byId = (left, right) => left['@id'] < right['@id'] ? -1 : left['@id'] > right['@id'] ? 1 : 0;

const KEY_VALIDITY = '2028-09-01T00:00:00.000Z';


//  ------------------------------------------------------------------
//  The roaming network operator: three holders, a quorum of two
//  ------------------------------------------------------------------

const HOLDERS = [
    { holder: 'Kyffhaeuser Trust', identity: 'ES384',   signing: 'ES256' },
    { holder: 'Rennsteig Trust',   identity: 'Ed25519', signing: 'ES256' },
    { holder: 'Wartburg Trust',    identity: 'ES384',   signing: 'ES256' },
];

for (const holder of HOLDERS) {
    holder.identityKey = makeKey(`identity key of ${holder.holder}`, holder.identity, { holder: holder.holder });
    holder.signingKey  = makeKey(`signing key of ${holder.holder}`,  holder.signing,  { notAfter: KEY_VALIDITY, holder: holder.holder, usages: [ 'party' ] });
}

const WITNESSES = [
    { witness: 'witness.erfurt.example',   key: makeKey('witness Erfurt',   'Ed25519') },
    { witness: 'witness.ilmenau.example',  key: makeKey('witness Ilmenau',  'ES256') },
];

function rnoOperator(created) {

    const identityKeys = HOLDERS.map(holder => holder.identityKey.json).sort(byId);
    const signedAt     = created;

    const statement = {
        roamingNetworkId:          RN_ID,
        roamingNetworkOperatorId:  RNO_ID,
        identityKeys,
        minConsensus:              2,
        signedAt,
        validUntil:                '2028-08-31T00:00:00.000Z',
    };

    const statementContext = POI.CONTEXT_PREFIX + 'roamingNetwork/keyStatement/v3';
    statement.signatures = HOLDERS.map(holder => ({
        algorithm:  holder.identity,
        keyId:      holder.identityKey.id,
        value:      sign(holder.identityKey, POI.canonicalJSONBytes({ ...statement, '@context': statementContext, algorithm: holder.identity, keyId: holder.identityKey.id })),
    }));

    const certificateContext = POI.CONTEXT_PREFIX + 'roamingNetwork/signingKeyCertificate/v2';
    const certificates = HOLDERS.map(holder => {
        const certificate = { roamingNetworkOperatorId: RNO_ID, signingKey: holder.signingKey.json, signedAt, algorithm: holder.identity, keyId: holder.identityKey.id };
        certificate.value = sign(holder.identityKey, POI.canonicalJSONBytes({ ...certificate, '@context': certificateContext }));
        return certificate;
    }).sort((left, right) => byId(left.signingKey, right.signingKey));

    return {
        '@id':                   RNO_ID,
        name:                    { en: 'Thuringia Network Operator (test)' },
        minConsensus:            2,
        keyStatement:            statement,
        signingKeyCertificates:  certificates,
        identityKeys,
        created,
        lastChange:              created,
    };

}


//  ------------------------------------------------------------------
//  Charging station operators, their towns and pools
//  ------------------------------------------------------------------

const TOWNS = {
    'Erfurt':           [ 50.9787, 11.0328 ], 'Weimar':          [ 50.9795, 11.3235 ], 'Gotha':          [ 50.9489, 10.7018 ],
    'Arnstadt':         [ 50.8342, 10.9464 ], 'Soemmerda':       [ 51.1590, 11.1172 ], 'Apolda':         [ 51.0265, 11.5141 ],
    'Jena':             [ 50.9271, 11.5892 ], 'Rudolstadt':      [ 50.7196, 11.3401 ], 'Saalfeld':       [ 50.6484, 11.3653 ],
    'Kahla':            [ 50.8077, 11.5865 ], 'Poessneck':       [ 50.6930, 11.5960 ], 'Stadtroda':      [ 50.8567, 11.7268 ],
    'Gera':             [ 50.8805, 12.0820 ], 'Altenburg':       [ 50.9853, 12.4339 ], 'Greiz':          [ 50.6553, 12.1990 ],
    'Schmoelln':        [ 50.8950, 12.3540 ], 'Zeulenroda':      [ 50.6520, 11.9770 ], 'Ronneburg':      [ 50.8627, 12.1814 ],
    'Eisenach':         [ 50.9746, 10.3200 ], 'Bad Salzungen':   [ 50.8110, 10.2330 ], 'Muehlhausen':    [ 51.2090, 10.4540 ],
    'Bad Langensalza':  [ 51.1080, 10.6460 ], 'Suhl':            [ 50.6091, 10.6943 ], 'Ilmenau':        [ 50.6840, 10.9190 ],
    'Meiningen':        [ 50.5680, 10.4160 ], 'Schmalkalden':    [ 50.7220, 10.4500 ], 'Hildburghausen': [ 50.4250, 10.7310 ],
    'Sonneberg':        [ 50.3510, 11.1720 ], 'Nordhausen':      [ 51.5050, 10.7910 ], 'Sondershausen':  [ 51.3690, 10.8700 ],
    'Heiligenstadt':    [ 51.3770, 10.1380 ], 'Leinefelde':      [ 51.3880, 10.3230 ], 'Artern':         [ 51.3660, 11.2910 ],
    'Bad Frankenhausen':[ 51.3570, 11.1010 ], 'Hermsdorf':       [ 50.8970, 11.8560 ], 'Schleiz':        [ 50.5780, 11.8100 ],
};

const PLACES = [ 'Hauptbahnhof', 'Markt', 'Rathaus', 'Klinikum', 'Stadion', 'Einkaufszentrum', 'Park and Ride', 'Gewerbegebiet Nord',
                 'Gewerbegebiet Sued', 'Theater', 'Freibad', 'Stadtwerke', 'Bibliothek', 'Messe', 'Hochschule', 'Altstadt', 'Busbahnhof',
                 'Sporthalle', 'Baumarkt', 'Supermarkt', 'Hotel am Park', 'Zoo', 'Bergbad', 'Kino', 'Volkshochschule', 'Friedhof', 'Ostviertel',
                 'Westviertel', 'Feuerwehr', 'Kulturhaus' ];

const OPERATORS = [
    { id: 'DE*XAA', name: 'Thuringian E-Charging (test)', towns: [ 'Erfurt', 'Weimar', 'Arnstadt', 'Soemmerda', 'Apolda' ],               pools: 34 },
    { id: 'DE*XAB', name: 'Saale Charge (test)',          towns: [ 'Jena', 'Rudolstadt', 'Saalfeld', 'Kahla', 'Poessneck', 'Stadtroda' ], pools: 32 },
    { id: 'DE*XAC', name: 'Ostthueringen Mobil (test)',   towns: [ 'Gera', 'Altenburg', 'Greiz', 'Schmoelln', 'Zeulenroda', 'Ronneburg' ], pools: 30 },
    { id: 'DE*XAD', name: 'Wartburg Laden (test)',        towns: [ 'Eisenach', 'Bad Salzungen', 'Muehlhausen', 'Bad Langensalza', 'Gotha' ], pools: 28 },
    { id: 'DE*XAE', name: 'Rennsteig Energie (test)',     towns: [ 'Suhl', 'Ilmenau', 'Meiningen', 'Schmalkalden', 'Hildburghausen', 'Sonneberg' ], pools: 30 },
    { id: 'DE*XAF', name: 'Nordthueringen Strom (test)',  towns: [ 'Nordhausen', 'Sondershausen', 'Heiligenstadt', 'Leinefelde', 'Artern', 'Bad Frankenhausen' ], pools: 26 },
];

const LATECOMER = { id: 'DE*XAG', name: 'Highway HPC (test)', towns: [ 'Hermsdorf', 'Eisenach', 'Erfurt', 'Gotha', 'Jena', 'Schleiz', 'Ilmenau', 'Suhl', 'Weimar', 'Gera', 'Meiningen', 'Nordhausen' ], pools: 12 };

for (const operator of [ ...OPERATORS, LATECOMER ]) {
    operator.infrastructureKey = makeKey(`infrastructure key of ${operator.id}`, 'ES256', { notAfter: KEY_VALIDITY, usages: [ 'infrastructure' ] });
    operator.tariffKey         = makeKey(`tariff key of ${operator.id}`,         'ES256', { notAfter: KEY_VALIDITY, usages: [ 'priceStatements', 'tariffs' ] });
    operator.identityKey       = makeKey(`identity key of ${operator.id}`,       'Ed25519');
    operator.nextStation       = 1;
    operator.nextPool          = 1;
}

function operatorJSON(operator, created) {
    return {
        '@id':         operator.id,
        name:          { en: operator.name },
        description:   { en: `A generated charging station operator of the Thuringia test network, around ${operator.towns.slice(0, 3).join(', ')}.` },
        signingKeys:   [ operator.infrastructureKey.json, operator.tariffKey.json ].sort(byId),
        identityKeys:  [ operator.identityKey.json ],
        created,
        lastChange:    created,
    };
}

const TARIFFS = {
    AC:   { name: 'AC charging',              price: 0.49 },
    DC:   { name: 'DC charging',              price: 0.59 },
    HPC:  { name: 'High power charging',      price: 0.69 },
};

const tariffId   = (operator, kind) => `${operator.id}*T_${kind}`;
const templateId = (operator, kind) => `${operator.id}*ET_${kind}`;

function tariffJSON(operator, kind, price, created) {
    return {
        '@id':      tariffId(operator, kind),
        name:       { en: TARIFFS[kind].name },
        currency:   'EUR',
        elements:   [ { priceComponents: [ { type: 'ENERGY', price, stepSize: 1 } ] } ],
        created,
        lastChange: created,
    };
}

function templateJSON(operator, kind, created) {
    const spec = {
        AC:  { name: 'AC EVSE, 22 kW',  currentTypes: [ 'AC_ThreePhases' ], maxPower: 22000,  connector: { '@id': '1', format: 'SOCKET', type: 'IEC_62196_T2' } },
        DC:  { name: 'DC EVSE, 150 kW', currentTypes: [ 'DC' ],             maxPower: 150000, connector: { '@id': '1', format: 'CABLE',  type: 'IEC_62196_T2_COMBO' } },
        HPC: { name: 'HPC EVSE, 300 kW', currentTypes: [ 'DC' ],            maxPower: 300000, connector: { '@id': '1', format: 'CABLE',  type: 'IEC_62196_T2_COMBO' } },
    }[kind];
    return {
        '@id':               templateId(operator, kind),
        name:                { en: spec.name },
        chargingTariffId:    tariffId(operator, kind),
        currentTypes:        spec.currentTypes,
        maxPower:            spec.maxPower,
        chargingConnectors:  [ spec.connector ],
        created,
        lastChange:          created,
    };
}

/** A charging pool with its stations and EVSEs, as a change set adds it: everything with its timestamps. */
function poolJSON(operator, town, place, kinds, created) {

    const [ lat, lng ] = TOWNS[town];
    const poolNumber   = operator.nextPool++;
    const stations     = [];

    for (const kind of kinds) {
        const number = operator.nextStation++;
        const evses  = [ 1, 2 ].map(index => {
            const evse = { '@id': `${operator.id}*E${number}*${index}`, templateIds: [ templateId(operator, kind) ], created, lastChange: created };
            // Some AC EVSEs give their own, lower power: their own value wins over the template's (9.2).
            if (kind === 'AC' && random() < 0.15)
                evse.maxPower = 11000;
            return evse;
        });
        stations.push({ '@id': `${operator.id}*S${number}`, EVSEs: evses, created, lastChange: created });
    }

    return {
        '@id':             `${operator.id}*P${poolNumber}`,
        name:              { en: `${town} ${place}` },
        geoLocation:       { lat: round4(lat + (random() - 0.5) * 0.05), lng: round4(lng + (random() - 0.5) * 0.08) },
        chargingStations:  stations.sort(byId),
        created,
        lastChange:        created,
    };

}

function stationKinds(highway) {
    if (highway)
        return Array.from({ length: between(2, 4) }, () => 'HPC');
    const count = pick([ 1, 1, 2, 2, 2, 3, 4 ]);
    return Array.from({ length: count }, () => random() < 0.3 ? 'DC' : 'AC');
}


//  ------------------------------------------------------------------
//  The content of the network, changed the way change sets change it (4)
//  ------------------------------------------------------------------

/** The text of a JSON value as written, read back as POI reads it: decimals as decimals. */
const asPOI = (value) => POI.parseJSON(JSON.stringify(value));

/** A JSON value as POI reads it, back to plain JavaScript: a decimal as the number that is written the same way. */
function toPlain(value) {
    if (value instanceof POI.Decimal) {
        const number = Number(value.toString());
        if (String(number) !== value.toString())
            throw new Error(`The decimal ${value.toString()} is not written the same as a number`);
        return number;
    }
    if (Array.isArray(value))
        return value.map(toPlain);
    if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([ key, item ]) => [ key, toPlain(item) ]));
    return value;
}

const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function insertOrdered(array, entity) {
    const index = array.findIndex(item => ordinal(item['@id'], entity['@id']) > 0);
    array.splice(index < 0 ? array.length : index, 0, entity);
}

const clone = (value) => JSON.parse(JSON.stringify(value));

const operatorIn = (content, id) => content.chargingStationOperators.find(item => item['@id'] === id);

/**
 * Applies the changes of a change set to the content, as `applyChangeSet` does for the kinds used here: the added entity
 * with its timestamps, what embeds it touched, `lastChange` of the network. The library checks it afterwards.
 */
function applyChanges(content, changes, createdAt) {

    for (const change of changes) {

        if (change.kind === 'Add' && change.entityType === 'ChargingStationOperator') {
            content.chargingStationOperators ??= [];
            insertOrdered(content.chargingStationOperators, { ...clone(change.newValue), lastChange: createdAt });
            continue;
        }

        const operatorId = change.entityType === 'ChargingStationOperator' ? change.entityId : content.chargingStationOperators.map(item => item['@id']).filter(id => change.entityId.startsWith(id + '*')).sort((a, b) => b.length - a.length)[0];
        const operator   = operatorIn(content, operatorId);

        if (change.entityType === 'ChargingStationOperator' && change.kind === 'UpdateProperty') {
            operator[change.propertyName] = clone(change.newValue);
            operator.lastChange = createdAt;
            continue;
        }

        const arrays = { ChargingPool: 'chargingPools', ChargingTariff: 'chargingTariffs', EVSETemplate: 'EVSETemplates', EVSEGroup: 'EVSEGroups', ChargingPoolGroup: 'chargingPoolGroups' };

        if (change.kind === 'Add' && arrays[change.entityType]) {
            operator[arrays[change.entityType]] ??= [];
            insertOrdered(operator[arrays[change.entityType]], { ...clone(change.newValue), lastChange: createdAt });
            operator.lastChange = createdAt;
            continue;
        }

        if (change.kind === 'Remove' && change.entityType === 'ChargingPool') {
            operator.chargingPools = operator.chargingPools.filter(pool => pool['@id'] !== change.entityId);
            if (operator.chargingPools.length === 0)
                delete operator.chargingPools;
            operator.lastChange = createdAt;
            continue;
        }

        if (change.kind === 'UpdateProperty' && change.entityType === 'ChargingTariff') {
            const tariff = operator.chargingTariffs.find(item => item['@id'] === change.entityId);
            tariff[change.propertyName] = clone(change.newValue);
            tariff.lastChange = createdAt;
            operator.lastChange = createdAt;
            continue;
        }

        if (change.kind === 'UpdateProperty' && change.entityType === 'EVSE') {
            for (const pool of operator.chargingPools)
                for (const station of pool.chargingStations)
                    for (const evse of station.EVSEs)
                        if (evse['@id'] === change.entityId) {
                            evse[change.propertyName] = clone(change.newValue);
                            evse.lastChange = station.lastChange = pool.lastChange = createdAt;
                        }
            operator.lastChange = createdAt;
            continue;
        }

        throw new Error(`The generator does not apply ${change.kind} of ${change.entityType}`);

    }

    content.lastChange = createdAt;

}


//  ------------------------------------------------------------------
//  Commits, checkpoints, statements: written, identified and signed as POI says
//  ------------------------------------------------------------------

const COMMIT_CONTEXT      = POI.CONTEXT_PREFIX + 'roamingNetwork/commit/v3';
const CHANGE_SET_CONTEXT  = POI.CONTEXT_PREFIX + 'roamingNetwork/changeSet/v3';
const CHECKPOINT_CONTEXT  = POI.CONTEXT_PREFIX + 'roamingNetwork/checkpoint/v1';

const versions  = [];        // { network, content, commit }
const commits   = [];        // the commit JSON documents, revision 1 on
const checkpointList = [];
const statements = [];       // every price statement made, in their order
let   changeSetCounter = 0;

const etagsOf = (network) => network.eTags().map(eTag => POI.etagToJSON(eTag));

function commitSignatures(commit, holders = HOLDERS) {
    const parsed = POI.Commit.parse(asPOI(commit));
    return holders.map(holder => {
        const signedAt  = advance(0.01);
        const signature = { role: 'roamingNetworkOperator', signer: RNO_ID, signedAt, algorithm: holder.signing, keyId: holder.signingKey.id };
        const bytes     = parsed.signingBytes({ ...signature, json: { signedAt } });
        return { ...signature, value: sign(holder.signingKey, bytes) };
    });
}

function genesis() {

    const created = now();
    const content = {
        '@id':        RN_ID,
        '@context':   POI.ROAMING_NETWORK_CONTEXT,
        name:         { en: 'Thuringia Test Network' },
        description:  { en: 'A generated test network of WWCP POI 3: seven charging station operators across Thuringia, some hundred charging stations, signed with test keys.' },
        operator:     rnoOperator(created),
        created,
        lastChange:   created,
    };

    const network = POI.RoamingNetwork.parse(asPOI(content));
    const body    = { roamingNetworkId: RN_ID, revision: 0, eTags: etagsOf(network) };
    const id      = POI.toHex(POI.hash('sha256', POI.canonicalJSONBytes(asPOI({ '@context': COMMIT_CONTEXT, ...body }))));
    const commit  = { '@id': id, '@context': COMMIT_CONTEXT, ...body };

    advance(1);
    commit.signatures = commitSignatures(commit);
    versions.push({ network, content, commit });

    return { timestamp: now(), commit, roamingNetwork: { ...content, eTags: network.eTags().map(eTag => POI.etagToJSON(eTag, 'base64')) } };

}

/**
 * Commits a change set: its changes applied to the head, its before and after ETags, signed by the given keys (owners and
 * new identity keys), the commit identified and signed by the quorum. Checked by the library before it is taken.
 */
function commit(description, changes, signers, { holders = HOLDERS, minutes = 90 } = {}) {

    const head      = versions.at(-1);
    const createdAt = advance(minutes);
    const content   = clone(head.content);

    applyChanges(content, changes, createdAt);

    const network   = POI.RoamingNetwork.parse(asPOI(content));
    const changeSet = {
        '@id':             `TH-${String(++changeSetCounter).padStart(4, '0')}`,
        roamingNetworkId:  RN_ID,
        createdAt,
        description:       { en: description },
        changes,
        beforeETags:       head.network.changeSetETags().map(eTag => POI.etagToJSON(eTag)),
        afterETags:        network.changeSetETags().map(eTag => POI.etagToJSON(eTag)),
    };

    const parsedChangeSet = POI.ChangeSet.parse(asPOI(changeSet));
    changeSet.signatures = signers.map(key => ({ algorithm: key.algorithm, keyId: key.id, value: sign(key, parsedChangeSet.signingBytes({ algorithm: key.algorithm, keyId: key.id })) }));

    // The library applies it again: the owners signed it, and it leads to the after ETags.
    const applied = POI.applyChangeSet(head.network, POI.ChangeSet.parse(asPOI(changeSet)));
    if (!applied.matchesCommitETags(network.eTags()))
        throw new Error(`'${description}': the library calculates another version`);

    const body = { roamingNetworkId: RN_ID, revision: head.commit.revision + 1, eTags: etagsOf(network), parentIds: [ head.commit['@id'] ] };
    const { signatures: _, ...unsigned } = changeSet;
    const id   = POI.toHex(POI.hash('sha256', POI.canonicalJSONBytes(asPOI({ '@context': COMMIT_CONTEXT, ...body, changeSet: unsigned }))));
    const json = { '@id': id, '@context': COMMIT_CONTEXT, ...body, changeSet };

    advance(0.5);
    json.signatures = commitSignatures(json, holders);

    versions.push({ network, content, commit: json });
    commits.push(json);

    console.log(`revision ${String(body.revision).padStart(2)}: ${description}`);

    return json;

}

/** A checkpoint of the head: the commits since the previous one, signed by the operator and by the witnesses (10). */
function checkpoint(priceStatements = []) {

    const previous = checkpointList.at(-1);
    const head     = versions.at(-1);
    const from     = previous === undefined ? 0 : versions.findIndex(version => version.commit['@id'] === previous.commitId) + 1;
    const included = versions.slice(from).map(version => POI.Commit.parse(asPOI(version.commit)));
    const createdAt = advance(20);

    const content = {
        roamingNetworkId:  RN_ID,
        epoch:             1,
        sequence:          checkpointList.length,
        ...(previous ? { previousId: previous['@id'] } : {}),
        commitId:          head.commit['@id'],
        revision:          head.commit.revision,
        eTags:             head.commit.eTags,
        commits:           { '@merkleRoot': POI.toHex(POI.commitsRoot(included, 'sha256')), '@size': included.length },
        ...(priceStatements.length ? { priceStatements: (() => { const { root, size } = POI.priceStatementsRoot(priceStatements.map(item => POI.PriceStatement.parse(asPOI(item))), 'sha256'); return { '@merkleRoot': POI.toHex(root), '@size': size }; })() } : {}),
        createdAt,
    };

    const id     = POI.toHex(POI.hash('sha256', POI.canonicalJSONBytes(asPOI({ '@context': CHECKPOINT_CONTEXT, ...content }))));
    const json   = { '@id': id, '@context': CHECKPOINT_CONTEXT, ...content };
    const parsed = POI.Checkpoint.parse(asPOI(json));

    const signatures = [];

    for (const holder of HOLDERS) {
        const signedAt  = advance(0.02);
        const signature = { role: 'roamingNetworkOperator', signer: RNO_ID, signedAt, algorithm: holder.signing, keyId: holder.signingKey.id };
        signatures.push({ ...signature, value: sign(holder.signingKey, parsed.signingBytes({ ...signature, json: { signedAt } })) });
    }

    // The witnesses take every commit themselves, then sign (10.2).
    for (const { witness, key } of WITNESSES) {
        const signedAt  = advance(3);
        const signature = { role: 'witness', signer: witness, signedAt, algorithm: key.algorithm, keyId: key.id };
        signatures.push({ ...signature, value: sign(key, parsed.signingBytes({ ...signature, json: { signedAt } })) });
    }

    json.signatures = signatures;
    json.priceStatementsGiven = priceStatements;
    checkpointList.push(json);

    console.log(`checkpoint ${content.sequence}: revision ${content.revision}, ${included.length} commits${priceStatements.length ? `, ${priceStatements.length} price statements` : ''}`);

    return json;

}

/** A price statement of an EVSE, signed by its operator with the key that may sign `priceStatements` (12). */
function priceStatement(operator, evseId, kind, price, { hours = 24 } = {}) {

    const previous = [ ...statements ].reverse().find(item => item.entityId === evseId);
    const signedAt = advance(5);
    const statement = {
        '@context':        POI.CONTEXT_PREFIX + 'roamingNetwork/priceStatement/v1',
        roamingNetworkId:  RN_ID,
        entityType:        'EVSE',
        entityId:          evseId,
        priceStatus:       { prices: [ { chargingTariffId: tariffId(operator, kind), elements: [ { priceComponents: [ { type: 'ENERGY', price, stepSize: 1 } ] } ] } ] },
        validFrom:         signedAt,
        validUntil:        new Date(Date.parse(signedAt) + hours * 3_600_000).toISOString(),
        sequence:          previous === undefined ? 0 : previous.sequence + 1,
        ...(previous ? { previous: POI.PriceStatement.parse(asPOI(previous)).digestHex() } : {}),
        ...(checkpointList.length ? { after: checkpointList.at(-1)['@id'] } : {}),
        role:              'chargingStationOperator',
        signer:            operator.id,
        signedAt,
        algorithm:         'ES256',
        keyId:             operator.tariffKey.id,
    };

    const parsed = POI.PriceStatement.parse(asPOI({ ...statement, value: 'AA==' }));
    statement.value = sign(operator.tariffKey, parsed.signingBytes());
    statements.push(statement);

    return statement;

}


//  ------------------------------------------------------------------
//  Proofs of charging stations (8.4), with attestations (8.5)
//  ------------------------------------------------------------------

function attestations(version, at) {
    const eTag = version.network.effectiveTreeETag('sha256');
    return HOLDERS.map(holder => {
        const attestation = {
            roamingNetworkId:  RN_ID,
            commitId:          version.commit['@id'],
            revision:          version.commit.revision,
            eTag:              POI.etagToJSON(eTag),
            role:              'roamingNetworkOperator',
            signer:            RNO_ID,
            signedAt:          at,
            validUntil:        new Date(Date.parse(at) + 15 * 60_000).toISOString(),
            algorithm:         holder.signing,
            keyId:             holder.signingKey.id,
        };
        const parsed = POI.Attestation.parse(asPOI({ ...attestation, value: 'AA==' }));
        return { ...attestation, value: sign(holder.signingKey, parsed.signingBytes()) };
    });
}

/** A child array of a proof: partial with the given children and their audit paths, or pruned to its root. */
function proofArray(children, kind, keep) {
    const leafHashes = children.map(child => POI.entityDigest(child, kind, 'sha256'));
    const leaves     = [];
    children.forEach((child, index) => {
        const entity = keep(child);
        if (entity !== undefined)
            leaves.push({ '@index': index, '@auditPath': POI.auditPath('sha256', leafHashes, index).map(POI.toHex), '@entity': entity });
    });
    if (leaves.length === 0)
        return { '@merkleRoot': POI.toHex(POI.merkleRootOfLeafHashes('sha256', leafHashes)), '@size': children.length };
    return { '@size': children.length, '@leaves': leaves };
}

/** The proof of a charging station: the effective network pruned to it, its tariffs and the skeletons above it. */
function stationProof(version, stationId, at) {

    const effective = version.network.effectiveContent;
    const pruned    = {};

    for (const [ property, value ] of Object.entries(effective)) {

        if (POI.CHILD_ARRAYS.roamingNetwork[property] === undefined) {
            pruned[property] = value;
            continue;
        }

        pruned[property] = proofArray(value, POI.CHILD_ARRAYS.roamingNetwork[property], operator => {

            if (property !== 'chargingStationOperators' || !stationId.startsWith(operator['@id'] + '*'))
                return undefined;

            const pool    = operator.chargingPools.find(item => item.chargingStations.some(station => station['@id'] === stationId));
            const station = pool.chargingStations.find(item => item['@id'] === stationId);
            const tariffs = new Set(station.EVSEs.flatMap(evse => evse.chargingTariffIds ?? []));
            const result  = {};

            for (const [ name, item ] of Object.entries(operator)) {
                const childKind = POI.CHILD_ARRAYS.chargingStationOperator[name];
                if (childKind === undefined)
                    result[name] = item;
                else if (name === 'chargingPools')
                    result[name] = proofArray(item, childKind, candidate => candidate['@id'] !== pool['@id'] ? undefined : {
                        ...Object.fromEntries(Object.entries(candidate).filter(([ key ]) => key !== 'chargingStations')),
                        chargingStations: proofArray(candidate.chargingStations, 'chargingStation', other => other['@id'] === stationId ? other : undefined),
                    });
                else if (name === 'chargingTariffs')
                    result[name] = proofArray(item, childKind, tariff => tariffs.has(tariff['@id']) ? tariff : undefined);
                else
                    result[name] = proofArray(item, childKind, () => undefined);
            }

            return result;

        });

    }

    return {
        '@context':      POI.CONTEXT_PREFIX + 'roamingNetwork/proof/v1',
        hashAlgorithm:   'sha256',
        commitId:        version.commit['@id'],
        revision:        version.commit.revision,
        roamingNetwork:  toPlain(pruned),
        attestations:    attestations(version, at),
    };

}


//  ------------------------------------------------------------------
//  The story of the network
//  ------------------------------------------------------------------

const [ rnoA, rnoB, rnoC ] = HOLDERS;
const signingKeysOf = (...holders) => holders.map(holder => holder.signingKey);

const genesisSnapshot = genesis();

// The operators join: the roaming network operator decides who is a member, each new identity key proves its possession.
commit('Six charging station operators join the network',
       OPERATORS.map(operator => ({ kind: 'Add', entityType: 'ChargingStationOperator', entityId: operator.id, newValue: operatorJSON(operator, advance(0)) })),
       [ ...signingKeysOf(rnoA, rnoB), ...OPERATORS.map(operator => operator.identityKey) ],
       { minutes: 60 * 24 });

// One change set, many owners: each operator signs its own tariffs with its key for tariffs.
commit('The charging tariffs of all operators',
       OPERATORS.flatMap(operator => [ 'AC', 'DC' ].map(kind => ({ kind: 'Add', entityType: 'ChargingTariff', entityId: tariffId(operator, kind),
                                                                newValue: tariffJSON(operator, kind, round4(TARIFFS[kind].price + (random() - 0.5) * 0.08), advance(0)) }))),
       OPERATORS.map(operator => operator.tariffKey),
       { minutes: 60 * 20 });

// … and its templates with its key for infrastructure.
commit('The EVSE templates of all operators: AC 22 kW and DC 150 kW, each naming its tariff',
       OPERATORS.flatMap(operator => [ 'AC', 'DC' ].map(kind => ({ kind: 'Add', entityType: 'EVSETemplate', entityId: templateId(operator, kind), newValue: templateJSON(operator, kind, advance(0)) }))),
       OPERATORS.map(operator => operator.infrastructureKey),
       { minutes: 60 * 6 });

/** Adds pools of an operator in its towns, a few places each. */
function addPools(operator, count, label, options = {}) {
    const created = advance(0);
    const pools = [];
    for (let i = 0; i < count; i++) {
        const town  = operator.towns[i % operator.towns.length];
        const place = options.highway ? pick([ 'Autohof', 'Rastanlage', 'Autobahnkreuz', 'Gewerbepark A4', 'Schnellladepark' ]) : pick(PLACES);
        pools.push(poolJSON(operator, town, place, stationKinds(options.highway), created));
    }
    return commit(label, pools.map(pool => ({ kind: 'Add', entityType: 'ChargingPool', entityId: pool['@id'], newValue: pool })), [ operator.infrastructureKey ], options);
}

// The pools, in two waves per operator, interleaved.
for (const wave of [ 0, 1 ])
    for (const operator of OPERATORS) {
        const count = wave === 0 ? Math.ceil(operator.pools / 2) : Math.floor(operator.pools / 2);
        addPools(operator, count, `${operator.name}: ${count} charging pools in ${operator.towns.slice(wave * 2, wave * 2 + 3).join(', ')} and around`,
                 { minutes: 60 * between(6, 30), holders: wave === 1 && operator.id === 'DE*XAC' ? [ rnoB, rnoC ] : HOLDERS });
        if (wave === 0 && operator.id === 'DE*XAC')
            checkpoint();
    }

checkpoint();

const saale  = OPERATORS[1];
const rennst = OPERATORS[4];
const ost    = OPERATORS[2];
const thur   = OPERATORS[0];

commit(`${saale.name}: DC charging at 0.64 EUR/kWh`,
       [ { kind: 'UpdateProperty', entityType: 'ChargingTariff', entityId: tariffId(saale, 'DC'), propertyName: 'elements',
           oldValue: versions.at(-1).content.chargingStationOperators.find(item => item['@id'] === saale.id).chargingTariffs.find(item => item['@id'] === tariffId(saale, 'DC')).elements,
           newValue: [ { priceComponents: [ { type: 'ENERGY', price: 0.64, stepSize: 1 } ] } ] } ],
       [ saale.tariffKey ], { minutes: 60 * 48 });

{
    // Three AC EVSEs of one operator limited to 11 kW: their own value now wins over the template's.
    const operator = versions.at(-1).content.chargingStationOperators.find(item => item['@id'] === rennst.id);
    const evses    = operator.chargingPools.flatMap(pool => pool.chargingStations.flatMap(station => station.EVSEs))
                                           .filter(evse => evse.templateIds[0].endsWith('ET_AC') && evse.maxPower === undefined).slice(0, 3);
    commit(`${rennst.name}: three AC EVSEs limited to 11 kW by their grid connection`,
           evses.map(evse => ({ kind: 'UpdateProperty', entityType: 'EVSE', entityId: evse['@id'], propertyName: 'maxPower', oldValue: null, newValue: 11000 })),
           [ rennst.infrastructureKey ], { minutes: 60 * 26 });
}

{
    const operator = versions.at(-1).content.chargingStationOperators.find(item => item['@id'] === ost.id);
    const pool     = operator.chargingPools[3];
    commit(`${ost.name}: the charging pool ${pool.name.en} closes`,
           [ { kind: 'Remove', entityType: 'ChargingPool', entityId: pool['@id'], oldValue: pool } ],
           [ ost.infrastructureKey ], { minutes: 60 * 30 });
}

// Prices of the moment, signed by the operators: statements the next checkpoint names.
const evseOf = (operator, n) => versions.at(-1).content.chargingStationOperators.find(item => item['@id'] === operator.id).chargingPools[n].chargingStations[0].EVSEs[0];
const tariffKindOf = (evse) => evse.templateIds[0].split('*ET_')[1];

const statementsBefore = [];
for (const [ operator, index ] of [ [ saale, 0 ], [ saale, 1 ], [ thur, 0 ], [ rennst, 2 ] ]) {
    const evse = evseOf(operator, index);
    const kind = tariffKindOf(evse);
    statementsBefore.push(priceStatement(operator, evse['@id'], kind, round4(TARIFFS[kind].price - 0.05)));
}

commit(`${LATECOMER.name} joins the network`,
       [ { kind: 'Add', entityType: 'ChargingStationOperator', entityId: LATECOMER.id, newValue: operatorJSON(LATECOMER, advance(0)) } ],
       [ ...signingKeysOf(rnoA, rnoC), LATECOMER.identityKey ], { minutes: 60 * 50 });

commit(`${LATECOMER.name}: its tariff and its EVSE template`,
       [ { kind: 'Add', entityType: 'ChargingTariff', entityId: tariffId(LATECOMER, 'HPC'), newValue: tariffJSON(LATECOMER, 'HPC', TARIFFS.HPC.price, advance(0)) },
         { kind: 'Add', entityType: 'EVSETemplate', entityId: templateId(LATECOMER, 'HPC'), newValue: templateJSON(LATECOMER, 'HPC', advance(0)) } ],
       [ LATECOMER.tariffKey, LATECOMER.infrastructureKey ], { minutes: 60 * 4 });

addPools(LATECOMER, LATECOMER.pools, `${LATECOMER.name}: ${LATECOMER.pools} high power charging parks along the A4, A9, A38 and A71`, { highway: true, minutes: 60 * 24 });

checkpoint(statementsBefore);

// A key rotation: the operator replaces its key for infrastructure, signed by its identity key (4.1).
{
    const oldKey = thur.infrastructureKey;
    thur.infrastructureKey = makeKey(`infrastructure key of ${thur.id}, 2026-10`, 'ES256', { notAfter: KEY_VALIDITY, usages: [ 'infrastructure' ] });
    commit(`${thur.name} replaces its signing key for infrastructure`,
           [ { kind: 'UpdateProperty', entityType: 'ChargingStationOperator', entityId: thur.id, propertyName: 'signingKeys',
               oldValue: [ oldKey.json, thur.tariffKey.json ].sort(byId), newValue: [ thur.infrastructureKey.json, thur.tariffKey.json ].sort(byId) } ],
           [ thur.identityKey ], { minutes: 60 * 72 });
}

addPools(thur, 4, `${thur.name}: four more charging pools in Erfurt and Weimar, signed with its new key`, { minutes: 60 * 20 });

{
    const content = versions.at(-1).content;
    const hpc     = content.chargingStationOperators.find(item => item['@id'] === LATECOMER.id);
    const along   = hpc.chargingPools.filter((pool, index) => index % 2 === 0);
    commit(`${LATECOMER.name}: its EVSEs along the A4, as a group`,
           [ { kind: 'Add', entityType: 'EVSEGroup', entityId: `${LATECOMER.id}*EG_A4`, newValue: {
                   '@id': `${LATECOMER.id}*EG_A4`, name: { en: 'High power charging along the A4' },
                   EVSEIds: along.flatMap(pool => pool.chargingStations.flatMap(station => station.EVSEs.map(evse => evse['@id']))).sort(),
                   created: advance(0), lastChange: now() } } ],
           [ LATECOMER.infrastructureKey ], { minutes: 60 * 5 });
}

commit(`${OPERATORS[3].name}: AC charging at 0.45 EUR/kWh`,
       [ { kind: 'UpdateProperty', entityType: 'ChargingTariff', entityId: tariffId(OPERATORS[3], 'AC'), propertyName: 'elements',
           oldValue: versions.at(-1).content.chargingStationOperators.find(item => item['@id'] === OPERATORS[3].id).chargingTariffs.find(item => item['@id'] === tariffId(OPERATORS[3], 'AC')).elements,
           newValue: [ { priceComponents: [ { type: 'ENERGY', price: 0.45, stepSize: 1 } ] } ] } ],
       [ OPERATORS[3].tariffKey ], { minutes: 60 * 30 });

const statementsAfter = [];
{
    const hpcEvse = evseOf(LATECOMER, 0);
    statementsAfter.push(priceStatement(LATECOMER, hpcEvse['@id'], 'HPC', 0.62));
    const again = evseOf(saale, 0);
    statementsAfter.push(priceStatement(saale, again['@id'], tariffKindOf(again), again.templateIds[0].endsWith('ET_DC') ? 0.61 : 0.47));
}

checkpoint(statementsAfter);

// The moment the demo is recorded: proofs and prices as an app gets them.
const recordedAt = advance(30);
const head       = versions.at(-1);
const proofStations = [ evseOf(saale, 0), evseOf(LATECOMER, 0), evseOf(thur, thur.nextPool - 3 > 0 ? 0 : 0) ]
                          .map(evse => evse['@id'].replace(/\*E(\d+)\*\d+$/, '*S$1'));

const latestStatements = [ ...statementsBefore, ...statementsAfter ];


//  ------------------------------------------------------------------
//  Replay everything with the library, from the trust anchor alone
//  ------------------------------------------------------------------

// The texts of a trust anchor are shown, not trusted: they are those of the network, or a verifier warns (8.6).
const anchor = POI.TrustAnchor.create(RN_ID, [ SERVER ], HOLDERS.map(holder => holder.identityKey.id), 2, genesisSnapshot.roamingNetwork.name);

const witnessesJSON = WITNESSES.map(({ witness, key }) => ({ witness, key: { '@id': key.id, key: key.json.key } }));

{
    const at        = recordedAt;
    const witnesses = POI.parseTrustedWitnesses(asPOI(witnessesJSON));
    let   trust     = POI.OperatorTrust.of(anchor, POI.RoamingNetwork.parse(asPOI(genesisSnapshot.roamingNetwork)), at);
    const history   = POI.History.fromSnapshot(asPOI(genesisSnapshot), {
        verifyCommit: (c, before, after) => { trust.verifyOperatorSignatures(c.signatures, (s, k) => c.verifySignature(s, k), 'the commit'); trust = trust.followedBy(after, at); },
        verifyCheckpoint: (c) => POI.verifyCheckpointSignatures(c, trust, { witnesses, requiredWitnesses: 2 }),
    });
    for (const json of commits) {
        history.append(asPOI(json));
        for (const cp of checkpointList.filter(item => item.commitId === json['@id'])) {
            const { priceStatementsGiven, ...plain } = cp;
            const taken = history.takeCheckpoint(asPOI(plain));
            if (priceStatementsGiven.length)
                POI.verifyCheckpointPriceStatements(taken, priceStatementsGiven.map(item => POI.PriceStatement.parse(asPOI(item))));
        }
    }
    for (const stationId of proofStations) {
        const station = POI.verifyChargingStation(anchor, asPOI(stationProof(head, stationId, recordedAt)), { at: recordedAt, chargingStationId: stationId });
        POI.verifyPriceStatements(station, asPOI(latestStatements.filter(item => station.evses.some(evse => evse['@id'] === item.entityId))), { at: recordedAt });
    }
    console.log(`Replayed: revision ${history.head.commit.revision}, ${history.checkpoints.length} checkpoints, ${proofStations.length} proofs — everything verifies.`);
}


//  ------------------------------------------------------------------
//  Write the demo
//  ------------------------------------------------------------------

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

const files = [];
const write = (name, value, description) => {
    writeFileSync(join(TARGET, name), JSON.stringify(value, null, 2) + '\n');
    files.push({ path: name, description });
};

write('TH-genesis.json', genesisSnapshot, 'Snapshot of the genesis: revision 0, the roaming network TH, its operator THNO and the key statement of its three holders');

// The commits in the parts a server gives them: since the genesis, since each checkpoint.
let from = 0;
checkpointList.forEach((cp, index) => {
    const until = commits.findIndex(item => item['@id'] === cp.commitId);
    write(`TH-commits-${index === 0 ? 'since-genesis' : `since-checkpoint-${index - 1}`}.json`, commits.slice(from, until + 1),
          `Commits ${commits[from].revision} to ${commits[until].revision}`);
    from = until + 1;
});
if (from < commits.length)
    write(`TH-commits-since-checkpoint-${checkpointList.length - 1}.json`, commits.slice(from), `Commits ${commits[from].revision} to ${commits.at(-1).revision}`);

checkpointList.forEach((cp, index) => {
    const { priceStatementsGiven, ...plain } = cp;
    write(`TH-checkpoint-${index}.json`, plain, `Checkpoint ${index}, revision ${cp.revision}, signed by the operator and two witnesses${priceStatementsGiven.length ? `, naming ${priceStatementsGiven.length} price statements` : ''}`);
    if (priceStatementsGiven.length)
        write(`TH-checkpoint-${index}-priceStatements.json`, priceStatementsGiven, `The price statements checkpoint ${index} names`);
});

for (const stationId of proofStations)
    write(`TH-proof-${stationId.replaceAll('*', '_')}.json`, stationProof(head, stationId, recordedAt), `Proof of the charging station ${stationId} at the head, attested by the three holders`);

write('TH-priceStatements-current.json', latestStatements, 'The price statements of the EVSEs, as the operators signed them');

// The head, with its runtime status: unsigned, as a server knows it at this moment.
{
    const STATUS = [ 'available', 'available', 'available', 'available', 'charging', 'charging', 'reserved', 'outOfService' ];
    const runtimeStatus = [];
    for (const operator of head.content.chargingStationOperators)
        for (const pool of operator.chargingPools ?? [])
            for (const station of pool.chargingStations)
                for (const evse of station.EVSEs)
                    runtimeStatus.push({ entityId: evse['@id'], entityType: 'EVSE', kind: 'status', timestamp: new Date(Date.parse(recordedAt) - between(1, 3600) * 1000).toISOString(), value: pick(STATUS) });
    write('TH-head-snapshot.json', { commit: head.commit, roamingNetwork: head.content, runtimeStatus, timestamp: recordedAt },
          'Snapshot of the head with the runtime status of every EVSE (unsigned, random)');
}

const pools    = head.content.chargingStationOperators.reduce((sum, operator) => sum + (operator.chargingPools?.length ?? 0), 0);
const stations = head.content.chargingStationOperators.reduce((sum, operator) => sum + (operator.chargingPools ?? []).reduce((s, pool) => s + pool.chargingStations.length, 0), 0);

const manifest = {
    id:            'thuringia',
    title:         'Thuringia, a generated test network',
    description:   `A roaming network of medium size, generated and signed with test keys: ${OPERATORS.length + 1} charging station operators, ${pools} charging pools, ${stations} charging stations ` +
                   `and ${stations * 2} EVSEs across Thuringia; ${commits.length} commits with change sets of several owners, a key rotation, a removed pool, a latecomer; ` +
                   `${checkpointList.length} checkpoints signed by two witnesses, price statements and station proofs.`,
    source:        'tools/generate-demo-network.mjs',
    recordedAt,
    trustAnchor:   anchor.toQRCode(),
    witnesses:     witnessesJSON,
    requiredWitnesses: 2,
    files,
};

writeFileSync(join(TARGET, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Wrote ${files.length} documents to ${TARGET}: ${pools} pools, ${stations} stations, ${commits.length} commits.`);
