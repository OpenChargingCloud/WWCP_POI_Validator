/*
 * The key statements of a roaming network operator one after the other, as a server gives them (8.6): the three of
 * example A1 in the QA demo, followed from each of its trust anchors, as an app that scanned one of them some time ago
 * follows them to the keys the operator had after GammaOrg joined.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDemo, readDemo, summaryOf } from './helpers.js';


const KEY_STATEMENTS = 'QA-keyStatements.json';

/** The chain of the QA demo, with the trust anchor of the settings, or the alternative one of the given number. */
async function chainOf({ alternative, change } = {}) {
    const { manifest } = readDemo('qa');
    const report = await analyzeDemo('qa', { change, settings: alternative === undefined ? {} : { trustAnchorText: manifest.alternativeTrustAnchors[alternative].text } });
    assert.equal(report.keyStatementChains.length, 1);
    return { report, summary: summaryOf(report), chain: report.keyStatementChains[0] };
}

const told = (chain) => chain.statements.map(item => [ item.status, item.holders.join(' '), `${item.statement.minConsensus}`, item.signedBy.join(' '), `${item.statedAt?.epoch}/${item.statedAt?.revision}` ]);

const A1 = [
    [ 'AlphaOrg',                  '1', 'AlphaOrg',         '1/0' ],
    [ 'AlphaOrg BetaOrg',          '2', 'AlphaOrg BetaOrg', '1/1' ],
    [ 'AlphaOrg BetaOrg GammaOrg', '2', 'AlphaOrg BetaOrg', '1/2' ],
];

const withStatus = (...status) => A1.map((row, index) => [ status[index], ...row ]);


test('Key statements: from the trust anchor of the genesis, of AlphaOrg alone, each follows the one before to all three holders', async () => {

    const { summary, chain } = await chainOf({ alternative: 1 });

    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.equal(chain.ok, true);
    assert.deepEqual(told(chain), withStatus('trusted', 'followed', 'followed'));
    assert.deepEqual([ ...new Set(chain.holderOf.values()) ].sort(), [ 'AlphaOrg', 'BetaOrg', 'GammaOrg' ]);
    assert.equal(chain.verified.minConsensus, 2);

    // The head of the history is at the ML-DSA keys of epoch 2 (A11), which the recording of example A1 does not reach.
    assert.equal(chain.head, 'other');

});

test('Key statements: from the trust anchors of revision 1 and of today, those before the first one they verify are passed over', async () => {

    for (const alternative of [ 2, undefined ]) {
        const { summary, chain } = await chainOf({ alternative });
        assert.deepEqual(summary.errors, []);
        assert.equal(chain.ok, true);
        assert.deepEqual(told(chain), withStatus('passedOver', 'trusted', 'followed'));
    }

});

test('Key statements: from the trust anchor of the ML-DSA keys of epoch 2, none of them is taken, and that is no error', async () => {

    const { summary, chain } = await chainOf({ alternative: 0 });

    assert.deepEqual(summary.errors,   []);
    assert.deepEqual(summary.warnings, []);
    assert.equal(chain.ok, undefined);
    assert.equal(chain.verified, undefined);
    assert.deepEqual(told(chain), withStatus('passedOver', 'passedOver', 'passedOver'));

});

test('Key statements: one that the quorum before it did not sign is refused, and nothing of the chain is trusted', async () => {

    // GammaOrg joins by the signature of AlphaOrg alone, where AlphaOrg and BetaOrg, two of two, have to sign.
    const { summary, chain } = await chainOf({ alternative: 1, change: files => {
        const json = JSON.parse(files.get(KEY_STATEMENTS));
        json.keyStatements[2].signatures.pop();
        files.set(KEY_STATEMENTS, JSON.stringify(json));
    } });

    assert.equal(summary.verdict.level, 'error');
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /^The key statements of 'QA-keyStatements\.json' are refused: The key statement 3 of 3 does not follow the one before: /);
    assert.equal(chain.ok, false);
    assert.equal(chain.verified, undefined);
    assert.deepEqual(chain.statements.map(item => item.status), [ 'trusted', 'followed', 'refused' ]);

    // The history itself is not touched by it.
    assert.deepEqual(summary.head, { epoch: 2, revision: 11 });

});

test('Key statements: without a trust anchor, they are not checked', async () => {

    const report = await analyzeDemo('qa', { settings: { trustAnchorText: '' } });
    const [ chain ] = report.keyStatementChains;

    assert.equal(chain.ok, undefined);
    assert.deepEqual(chain.statements.map(item => item.status), [ 'unchecked', 'unchecked', 'unchecked' ]);

});
