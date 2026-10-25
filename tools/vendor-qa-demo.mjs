/*
 * Copies the public documents of the recorded run of the WWCP_POI examples (A1 to A13 at commit 801bbce), which
 * WWCP_POI.TS vendors in tests/vectors/csharp-801bbce, into demo/qa, and writes the manifest the validator loads.
 *
 *   node tools/vendor-qa-demo.mjs [path of WWCP_POI.TS]
 *
 * Nothing is changed: the documents are signed, and the validator checks them as they were published.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const here     = import.meta.dirname;
const library  = resolve(process.argv[2] ?? join(here, '..', '..', 'WWCP_POI.TS'));
const run      = join(library, 'tests', 'vectors', 'csharp-801bbce');
const target   = join(here, '..', 'demo', 'qa');

/** The documents of the demo, in the order the validator lists them, with what each one is. */
const FILES = [

    [ 'published/QA-genesis.json',                         'Snapshot of the genesis of epoch 1: revision 0, the roaming network QA, its operator OCC and the key statement of its three holders' ],
    [ 'published/QA-commits-since-genesis.json',           'Commits 1 to 10 of epoch 1: parties, models, templates, pools, groups' ],
    [ 'published/QA-commits-since-checkpoint-2.json',      'Commits 11 to 13 of epoch 1: charging tariffs and their prices' ],
    [ 'published/QA-commits-since-checkpoint-4.json',      'Commit 14 of epoch 1: the DC tariff' ],
    [ 'published/QA-commits-since-checkpoint-5.json',      'Commits 15 and 16 of epoch 1: OCC and DE*GEF move to ML-DSA keys (example A11)' ],

    [ 'published/QA-checkpoint-0.json',                    'Checkpoint 0 of epoch 1, signed by OCC and two witnesses' ],
    [ 'published/QA-checkpoint-1.json',                    'Checkpoint 1 of epoch 1' ],
    [ 'published/QA-checkpoint-2.json',                    'Checkpoint 2 of epoch 1' ],
    [ 'published/QA-checkpoint-3.json',                    'Checkpoint 3 of epoch 1' ],
    [ 'published/QA-checkpoint-4.json',                    'Checkpoint 4 of epoch 1, naming price statements' ],
    [ 'published/QA-checkpoint-4-priceStatements.json',    'The price statements checkpoint 4 names' ],
    [ 'published/QA-checkpoint-5.json',                    'Checkpoint 5 of epoch 1, naming a price statement' ],
    [ 'published/QA-checkpoint-5-priceStatements.json',    'The price statement checkpoint 5 names' ],
    [ 'published/QA-checkpoint-6.json',                    'Checkpoint 6, the final checkpoint of epoch 1, naming epoch 2 and its profiles' ],

    [ 'published/QA-epoch-2-genesis.json',                 'Snapshot of the genesis of epoch 2 as the server published it: SHA-512 identifications, Ed25519 and ML-DSA signatures' ],
    [ 'proofs/QA-epoch-2-commits-to-head.json',            'Commits 1 to 7 of epoch 2, up to the head' ],
    [ 'published/QA-epoch-2-checkpoint-0.json',            'Checkpoint 0 of epoch 2, naming the final checkpoint of epoch 1' ],
    [ 'published/QA-epoch-2-checkpoint-0-priceStatements.json', 'The price statement checkpoint 0 of epoch 2 names' ],

    [ 'published/QA-archive.json',                         'The segments of the archive of epoch 1 (compaction, section 10.6)' ],
    [ 'published/QA-archive-1.json',                       'Archive segment 1: the genesis and commits 1 to 7' ],
    [ 'published/QA-archive-2.json',                       'Archive segment 2: revision 7 and commits 8 and 9' ],

    [ 'published/QA-live-snapshot.json',                   'Snapshot of revision 3 of epoch 2 with the runtime status of every pool, station and EVSE (unsigned)' ],

    [ 'published/QA-DE-GEF-E1-1-proof.json',               'Proof of the charging station of the EVSE DE*GEF*E1*1 at the end of the run, revision 7 of epoch 2, attested by OCC' ],
    [ 'published/QA-priceStatements-DE_GEF_E1_1.json',     'Price statement of the EVSE DE*GEF*E1*1, signed by DE*GEF in epoch 1 with its ECDSA key' ],
    [ 'proofs/QA-proof-station-DE_GEF_S1.json',            'Proof of the charging station DE*GEF*S1, revision 7 of epoch 2, ML-DSA attestations' ],
    [ 'proofs/QA-proof-station-DE_GEF_S6.json',            'Proof of the charging station DE*GEF*S6, revision 7 of epoch 2' ],
    [ 'proofs/QA-proof-evse-DE_GEF_E3_2.json',             'Proof of the charging station of the EVSE DE*GEF*E3*2, revision 7 of epoch 2' ],
    [ 'proofs/QA-epoch-2-attestations.json',               'The attestations of the head of epoch 2' ],

    [ 'published/QA-proof-revision-4.json',                'Proof that commit 4 of epoch 1 is part of checkpoint 0 (section 10.4)' ],
    [ 'published/QA-proof-revision-8.json',                'Proof that commit 8 of epoch 1 is part of checkpoint 1' ],
    [ 'published/QA-proof-revision-10.json',               'Proof that commit 10 of epoch 1 is part of checkpoint 2' ],
    [ 'proofs/QA-epoch-2-proof-revision-1.json',           'Proof that commit 1 of epoch 2 is part of checkpoint 0 of epoch 2' ],
    [ 'published/QA-priceStatementProof-E1_1-0.json',      'Proof that the first price statement of DE*GEF*E1*1 is named by checkpoint 4' ],

    [ 'driver/evidence-DE_GEF_E1_1.json',                  'The evidence a driver\'s app kept of a charging session at DE*GEF*E1*1 (example A10)' ],

];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const [ file ] of FILES)
    copyFileSync(join(run, file), join(target, basename(file)));

const trustAnchor   = readFileSync(join(run, 'published', 'QA-trustAnchor.txt'),       'utf8').trim();
const trustAnchorPQ = readFileSync(join(run, 'published', 'QA-trustAnchor-mldsa.txt'), 'utf8').trim();

// The witnesses a verifier trusts by configuration: those of example A6, and their ML-DSA keys of example A11.
const witnesses = [
    ...JSON.parse(readFileSync(join(run, 'trusted', 'witnesses.json'),       'utf8')),
    ...JSON.parse(readFileSync(join(run, 'trusted', 'witnesses-mldsa.json'), 'utf8')),
];

const manifest = {
    id:            'qa',
    title:         'QA, the roaming network of the WWCP_POI examples',
    description:   'One recorded run of the C# examples A1 to A13 of WWCP_POI at commit 801bbce: a roaming network operator with a quorum of three holders, ' +
                   'one charging station operator with 4 pools, 8 stations and 16 EVSEs, manufacturers, transparency software and conformity assessment bodies, ' +
                   'two epochs (ECDSA and SHA-256, then ML-DSA and SHA-512), checkpoints signed by two witnesses, price statements and the evidence of a charging session.',
    source:        'https://github.com/OpenChargingCloud/WWCP_POI/tree/801bbce/examples',
    recordedAt:    '2026-10-24T17:03:00.000Z',
    trustAnchor,
    alternativeTrustAnchors: [
        { label: 'QA after example A11 (ML-DSA identity keys of epoch 2)', text: trustAnchorPQ }
    ],
    witnesses,
    requiredWitnesses: 2,
    files: FILES.map(([ file, description ]) => ({ path: basename(file), description })),
};

writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Copied ${FILES.length} documents of ${run} to ${target}.`);
