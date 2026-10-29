/*
 * What the page is for: a document changed after it was signed is refused, by the check the specification names, and
 * the rest of the history goes on where it can. Each test changes one document of the Thuringia demo, as a user
 * editing it on the page would ("Edit and verify again").
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDemo, replaceOnce, summaryOf } from './helpers.js';


const COMMITS_7_TO_15 = 'TH-commits-since-checkpoint-0.json';


/** Replaces the price of the first statement of the given EVSE in a list of price statements. */
function changePrice(files, name, evseId, price) {
    const text  = files.get(name);
    const start = text.indexOf(`"price": `, text.indexOf(`"entityId": "${evseId}"`));
    const end   = text.indexOf(',', start);
    assert.ok(start > 0 && end > start, `no price of ${evseId} in ${name}`);
    files.set(name, `${text.slice(0, start)}"price": ${price}${text.slice(end)}`);
}


test('A change set changed after it was signed: its commit is refused, and every commit after it is not taken', async () => {

    const summary = summaryOf(await analyzeDemo('thuringia', {
        change: files => replaceOnce(files, COMMITS_7_TO_15, '14 charging pools in Muehlhausen', '15 charging pools in Muehlhausen'),
    }));

    assert.equal(summary.verdict.level, 'error');
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /^A commit of 'TH-commits-since-checkpoint-0\.json' \(revision 13\) is refused: The commit identification/);

    // Revisions 1 to 12 and the checkpoint after revision 6 hold; 13 is refused, 14 to 25 and three checkpoints follow it.
    assert.deepEqual(summary.head, { epoch: 1, revision: 12 });
    assert.deepEqual(summary.epochs, [ { number: 1, commits: 12, checkpoints: 1, notTaken: 16 } ]);

});

test('A signature of the operator changed: an error, though the other holders still make the quorum', async () => {

    const summary = summaryOf(await analyzeDemo('thuringia', {
        change: files => replaceOnce(files, COMMITS_7_TO_15, '"C/6hHCwlPgb4aQ8J2VKq2ee1LHFpuu86J', '"D/6hHCwlPgb4aQ8J2VKq2ee1LHFpuu86J'),
    }));

    assert.equal(summary.verdict.level, 'error');
    assert.deepEqual(summary.errors, [ 'Revision 13 of epoch 1 is not signed as the roaming network operator requires: The signature is invalid!' ]);
    assert.deepEqual(summary.head, { epoch: 1, revision: 25 });

});

test('A witness signature removed: the checkpoint lacks the witnesses required', async () => {

    const summary = summaryOf(await analyzeDemo('thuringia', {
        change: files => {
            // Checkpoints hold no decimals: JSON.parse and JSON.stringify keep everything else as it is.
            const checkpoint = JSON.parse(files.get('TH-checkpoint-1.json'));
            checkpoint.signatures = checkpoint.signatures.filter(signature => signature.signer !== 'witness.ilmenau.example');
            files.set('TH-checkpoint-1.json', JSON.stringify(checkpoint, null, 2));
        },
    }));

    assert.equal(summary.verdict.level, 'error');
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /^Checkpoint 1 of epoch 1: The checkpoint '[0-9a-f]+' is signed by 1 of the trusted witnesses, not by 2!$/);

});

test('Without a trust anchor: a warning, as the network only vouches for itself (trust on first use)', async () => {

    const summary = summaryOf(await analyzeDemo('thuringia', { settings: { trustAnchorText: '' } }));

    assert.equal(summary.verdict.level, 'warn');
    assert.equal(summary.anchor, 'none');
    assert.equal(summary.warnings.length, 1);
    assert.match(summary.warnings[0], /^No trust anchor is given: .*\(trust on first use\)/);
    assert.deepEqual(summary.errors, []);

});

test('A price statement changed after it was signed is an error', { todo: 'it is shown as "does not count" in the proof of its station, and makes no finding' }, async () => {

    const report = await analyzeDemo('thuringia', {
        change: files => changePrice(files, 'TH-priceStatements-current.json', 'DE*XAB*E1*1', '0.01'),
    });

    assert.ok(report.proofs.some(result => result.statements?.some(item => !item.ok)), 'the statement is not refused at all');
    assert.equal(report.verdict.level, 'error');

});

test('A price statement of a checkpoint changed after it was signed is an error', { todo: 'the list no longer matches the tree of the checkpoint, which makes it only "missing" (info)' }, async () => {

    const summary = summaryOf(await analyzeDemo('thuringia', {
        change: files => changePrice(files, 'TH-checkpoint-2-priceStatements.json', 'DE*XAB*E1*1', '0.04'),
    }));

    assert.equal(summary.verdict.level, 'error');

});
