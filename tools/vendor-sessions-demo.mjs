/*
 * Copies the charging sessions WWCP_POI.TS keeps among its test vectors (tests/vectors, since 0.2.0) into demo/sessions,
 * and writes the manifest the validator loads: sessions as Chargy writes them (.chargy), each with the evidence of WWCP POI
 * an app checks for it: the proof of the charging station, historical evidence of the meter and its key, the prices bound
 * to the session and the receipts of their publication. The network is CHARGY-POI-DEMO, signed with public test keys.
 *
 *   node tools/vendor-sessions-demo.mjs [path of WWCP_POI.TS]
 *
 * Nothing is changed: the sessions are signed, and the validator checks them as they were published. The variants of
 * price-publication.json, receipts of the publication of the prices refused for one reason each, are the one session it
 * holds with their evidence in its place, as an app would get them.
 *
 * And how the trust of the network moves on (trust-transitions.json, experimental): a proof of a station under the trust
 * anchor of the network, two transitions its holders and those of the next policy signed - to other identity keys and
 * servers, or to the next epoch with the checkpoints closing the first -, a proof under each, and a transition refused.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseJSON, prettyJSON } from '@open-charging-cloud/wwcp-poi';

const here     = import.meta.dirname;
const library  = resolve(process.argv[2] ?? join(here, '..', '..', 'WWCP_POI.TS'));
const vectors  = join(library, 'tests', 'vectors');
const target   = join(here, '..', 'demo', 'sessions');

const read     = (name) => readFileSync(join(vectors, name), 'utf8');
const json     = (name) => JSON.parse(read(name));

// Read as POI reads it: a decimal of a signed price stays as it is written, 0.3500 as well.
const meta        = json('meter-session-meta.json');
const publication = parseJSON(read('price-publication.json'));

/** The sessions, as WWCP_POI.TS keeps them, with what each shows. */
const SESSIONS = [
    [ 'meter-session.json',          'meter-session.chargy',          'A session with the proof of its charging station: the meter and its key, as the network states them now' ],
    [ 'history-session.json',        'history-session.chargy',        'A session with historical evidence: the meter and its key as the network stated them when it measured, and the checkpoint naming that version' ],
    [ 'session-price-ed.json',       'session-price-ed.chargy',       'A session with prices bound to it: an Ed25519 price statement of the operator and its agreement with the start of the session' ],
    [ 'session-price-pqc.json',      'session-price-pqc.chargy',      'The same with an ML-DSA-65 price statement' ],
    [ 'session-price-decimal.json',  'session-price-decimal.chargy',  'The same with decimals as signed: 0.3500 EUR/kWh' ],
];

/** The variants of the receipts of a publication of the prices, each refused or not proven for one reason. */
const VARIANTS = {
    'session-before-start.chargy':  'Published before the start: two organizations of the policy witnessed the prices before the signed start',
    'no-receipts.chargy':           'No receipts: the prices are bound to the session, their publication before the start is not proven',
    'late-receipt.chargy':          'A receipt signed after the start: it does not count',
    'clock-overlap.chargy':         'A receipt within the clock error of its witness around the start: it does not count',
    'same-organization.chargy':     'Two receipts of one organization: they count once',
    'unknown-witness.chargy':       'A receipt of a witness the policy does not name: it does not count',
    'wrong-price.chargy':           'A receipt for another price statement: refused',
    'wrong-signed-price.chargy':    'A receipt for the same price statement signed otherwise: refused',
    'wrong-tariff.chargy':          'A receipt for another tariff: refused',
    'wrong-checkpoint.chargy':      'A receipt naming another checkpoint: refused',
    'tampered-receipt.chargy':      'A receipt changed after it was signed: refused',
    'future-receipt.chargy':        'A receipt signed after the time it is checked as of: refused',
    'private-source.chargy':        'A receipt of a retrieval from a private address: refused',
};

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const files = [];

for (const [ source, name, description ] of SESSIONS) {
    writeFileSync(join(target, name), read(source));
    files.push({ path: name, description });
}

for (const [ variant, description ] of Object.entries(VARIANTS)) {
    const evidence = publication.variants[variant];
    if (evidence === undefined)
        throw new Error(`price-publication.json has no variant '${variant}'`);
    const session  = { ...publication.session, poiEvidence: { ...publication.session.poiEvidence, priceEvidence: evidence } };
    const name     = `publication-${variant}`;
    writeFileSync(join(target, name), prettyJSON(session) + '\n');
    files.push({ path: name, description });
}

const unknown = Object.keys(publication.variants).filter(variant => !(variant in VARIANTS));
if (unknown.length > 0)
    throw new Error(`price-publication.json has variants not described here: ${unknown.join(', ')}`);

const sessions = files.length;

// How the trust of the network moves on, in the order an app would meet it. The two transitions start from the same
// policy: alternatives, of which an app follows one and refuses the other as a fork.
const transitions = parseJSON(read('trust-transitions.json'));

if (transitions.anchor !== publication.session.poiEvidence.bootstrap.trustAnchor)
    throw new Error('trust-transitions.json is of another trust anchor than the sessions');

const TRUST = [
    [ 'baseProof',           'proof-of-the-network.json',             'A proof of a charging station under the trust anchor of the network' ],
    [ 'policy',              'transition-to-new-keys.json',           'A trust transition to other identity keys and servers, signed by a quorum of the holders of both' ],
    [ 'targetProof',         'proof-under-new-keys.json',             'A proof under those identity keys: no key the trust anchor pins signed it' ],
    [ 'epoch',               'transition-to-epoch-2.json',            'A trust transition to epoch 2, with the checkpoint closing epoch 1, its final one, and the first of epoch 2: the other way on from the same policy' ],
    [ 'epochProof',          'proof-of-epoch-2.json',                 'A proof of the genesis of epoch 2' ],
    [ 'invalidCertificate',  'transition-invalid-certificate.json',   'A trust transition signed by both quorums, to an operator whose signing key certificate is invalid: refused' ],
];

for (const [ key, name, description ] of TRUST) {
    writeFileSync(join(target, name), prettyJSON(transitions[key]) + '\n');
    files.push({ path: name, description });
}

const manifest = {
    id:                  'sessions',
    title:               'An app: charging sessions and trust transitions',
    description:         `${sessions} charging sessions of the test network ${meta.networkId} of WWCP_POI.TS, as Chargy writes them: the meter and its key from the proof of the ` +
                         'station, now and when it measured; prices bound to the session, in Ed25519, ML-DSA-65 and decimals; and the receipts of the publication of the prices, ' +
                         'witnessed before the start or refused for one reason each. And how the trust of the network moves on: trust transitions to other identity keys, and ' +
                         'to epoch 2, with a proof under each. Public test keys only.',
    source:              'tools/vendor-sessions-demo.mjs',
    recordedAt:          publication.now,
    trustAnchor:         publication.session.poiEvidence.bootstrap.trustAnchor,
    // The witness of the checkpoints of the historical evidence: trusted, not required, as the checkpoints of the publication
    // variants are signed by the operator alone.
    witnesses:           json('history-witnesses.json'),
    requiredWitnesses:   0,
    publicationPolicy:   json('price-publication.json').policy,
    files,
};

writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Copied ${sessions} sessions and ${files.length - sessions} documents of trust transitions of ${vectors} to ${target}, checked as of ${manifest.recordedAt}.`);
