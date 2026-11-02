/*
 * Trust transitions and what an app keeps (WWCP_POI.TS 0.2.0, experimental): the transitions of the test network of
 * WWCP_POI.TS verified from the trust anchor of the settings, the proofs of their targets verified with them, and the
 * journal of an app that observed it all in its order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrustAnchor } from '@open-charging-cloud/wwcp-poi';

import { analyzeDemo, readDemo, summaryOf } from './helpers.js';


const byName = (list) => Object.fromEntries(list.map(item => [ item.document.name, item ]));


test('Trust transitions: verified from the trust anchor of the settings, and the proofs of their targets with them', async () => {

    const report      = await analyzeDemo('sessions');
    const transitions = byName(report.transitions);
    const proofs      = byName(report.proofs);

    // To other identity keys and servers in epoch 1, and to epoch 2: each signed by both quorums. The third names an
    // operator whose signing key certificate is invalid: refused, whoever signed it.
    assert.deepEqual(Object.fromEntries(Object.entries(transitions).map(([ name, item ]) => [ name, item.ok
        ? [ item.verified.oldEpoch.number, item.verified.epoch.number, item.verified.context.anchor.urls[0], item.verified.signedBy.old.length, item.verified.signedBy.next.length ]
        : /^The roaming network operator 'CHARGY-DEMO-RNO': The certificate of the signing key '[0-9a-f]{64}' is invalid/.test(item.error) ? 'its certificate is invalid' : item.error ])), {
        'transition-to-new-keys.json':          [ 1, 1, 'https://next.poi.example/RNs/CHARGY-POI-DEMO', 2, 2 ],
        'transition-to-epoch-2.json':           [ 1, 2, 'https://poi.example/RNs/CHARGY-POI-DEMO', 2, 2 ],
        'transition-invalid-certificate.json':  'its certificate is invalid',
    });

    // The proof under the new keys, which no key the trust anchor pins signed, verifies with the transition to them; the
    // proof of the genesis of epoch 2 with the transition opening it, in its epoch.
    assert.deepEqual(Object.fromEntries(Object.entries(proofs).map(([ name, item ]) => [ name, [ item.ok, item.basis, item.transition?.document.name, item.epochNumber ] ])), {
        'proof-of-the-network.json':  [ true, 'pinned', undefined, 1 ],
        'proof-under-new-keys.json':  [ true, 'transition', 'transition-to-new-keys.json', 1 ],
        'proof-of-epoch-2.json':      [ true, 'transition', 'transition-to-epoch-2.json', 2 ],
    });
    assert.match(proofs['proof-under-new-keys.json'].pinnedError, /signed by trusted identity keys of 0 holders/);

    // Their operators' keys that may sign charging documents: Ed25519 keys without restriction.
    assert.ok(Object.values(proofs).every(item => item.documentKeys?.keys.length > 0 && item.documentKeys.keys.every(key => key.algorithm === 'EdDSA-Ed25519')));

    assert.deepEqual(summaryOf(report).errors.filter(text => text.startsWith('The trust transition')).length, 1);

});

test('What an app keeps: it follows one way on, and refuses the other as a fork', async () => {

    const report = await analyzeDemo('sessions');

    assert.deepEqual(report.journal.steps.map(step => [ step.document.name, step.status, step.issues.map(issue => issue.code) ]), [
        [ 'proof-of-the-network.json',    'first-seen', [] ],
        [ 'transition-to-new-keys.json',  'advanced',   [] ],
        [ 'proof-under-new-keys.json',    'advanced',   [] ],
        [ 'transition-to-epoch-2.json',   'rejected',   [ 'fork', 'known-fork' ] ],
        [ 'proof-of-epoch-2.json',        'rejected',   [ 'epoch-transition' ] ],
    ]);

    // Of the demos with a history: every proof and price statement taken, nothing refused.
    for (const demo of [ 'qa', 'thuringia' ]) {
        const steps = (await analyzeDemo(demo)).journal.steps;
        assert.ok(steps.length > 0 && steps.every(step => step.accepted && step.issues.length === 0), `${demo}: ${JSON.stringify(steps.map(step => [ step.status, step.issues ]))}`);
    }

});

test('Trust transitions: with a holder untrusted, none starts from the trust anchor, nor does a proof of its target verify', async () => {

    const anchor = TrustAnchor.parse(readDemo('sessions').manifest.trustAnchor);
    const report = await analyzeDemo('sessions', { settings: { trustedIdentityKeyIds: anchor.holders[0] } });

    assert.ok(report.transitions.every(item => !item.ok));
    assert.deepEqual(report.proofs.map(item => item.ok), [ false, false, false ]);

});
