/*
 * What WWCP_POI.TS 0.1.1 and 0.2.0 brought, as the page checks it: charging sessions as an app checks them (the meter and
 * its key now and when it measured, the prices bound to the session, the receipts of their publication), and the local
 * trust decisions an app makes before it trusts the keys of a trust anchor (a trust context).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrustAnchor } from '@open-charging-cloud/wwcp-poi';

import { analyzeDemo, readDemo, summaryOf } from './helpers.js';


/** Each session in short: its meter now, when it measured, its prices, their publication before the start. */
const outline = (report) => Object.fromEntries(report.sessions.map(result => [ result.document.name, [
    result.meterKey   ? result.meterKey.error   ?? `${result.meterKey.binding.evidence.association}${result.meterKey.sessionKey ? ', the key of the session' : ''}` : '—',
    result.historical ? result.historical.error ?? result.historical.verification.versions.map(version => version.publication).join() : '—',
    result.prices     ? result.prices.error     ?? result.prices.verification.applicability : '—',
    result.prices     ? result.prices.error     ?? result.prices.verification.publicationBeforeStart : '—',
] ]));


test('Sessions: every session of the demo, as an app checks it with the trust anchor and the policy of the settings', async () => {

    const report  = await analyzeDemo('sessions');
    const summary = summaryOf(report);

    assert.deepEqual(outline(report), {
        'meter-session.chargy':                     [ 'current-snapshot, the key of the session', '—', '—', '—' ],
        'history-session.chargy':                   [ '—', 'witnessed-checkpoint', '—', '—' ],
        'session-price-ed.chargy':                  [ '—', 'witnessed-checkpoint', 'bound', 'not-proven' ],
        'session-price-pqc.chargy':                 [ '—', 'witnessed-checkpoint', 'bound', 'not-proven' ],
        'session-price-decimal.chargy':             [ '—', 'witnessed-checkpoint', 'bound', 'not-proven' ],
        'publication-session-before-start.chargy':  [ '—', 'rno-checkpoint', 'bound', 'witnessed-before-signed-start' ],
        'publication-no-receipts.chargy':           [ '—', 'rno-checkpoint', 'bound', 'not-proven' ],
        'publication-late-receipt.chargy':          [ '—', 'rno-checkpoint', 'bound', 'not-proven' ],
        'publication-clock-overlap.chargy':         [ '—', 'rno-checkpoint', 'bound', 'not-proven' ],
        'publication-same-organization.chargy':     [ '—', 'rno-checkpoint', 'bound', 'not-proven' ],
        'publication-unknown-witness.chargy':       [ '—', 'rno-checkpoint', 'bound', 'not-proven' ],
        'publication-wrong-price.chargy':           [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
        'publication-wrong-signed-price.chargy':    [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
        'publication-wrong-tariff.chargy':          [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
        'publication-wrong-checkpoint.chargy':      [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
        'publication-tampered-receipt.chargy':      [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
        'publication-future-receipt.chargy':        [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
        'publication-private-source.chargy':        [ '—', 'rno-checkpoint', 'bound', 'invalid' ],
    });

    // The meter signed with the key the network states for it, when it measured as well; the decimals as signed.
    assert.ok(report.sessions.filter(result => result.historical).every(result => result.historical.sessionKey === true));
    assert.equal(report.sessions.find(result => result.document.name === 'session-price-decimal.chargy').prices.verification.selected.rates.energyPerKWh, '0.3500');

    // A refused receipt is a finding, with the reason WWCP_POI.TS gives; not proven is none.
    const sessionErrors = summary.errors.filter(text => text.startsWith('The charging session'));
    assert.equal(sessionErrors.length, 7);
    assert.ok(sessionErrors.every(text => /^The charging session 'publication-[a-z-]+\.chargy': a receipt of the publication of its prices is refused \(.+\)\.$/.test(text)), sessionErrors.join('\n'));
    assert.deepEqual(summary.warnings, []);

});

test('Sessions: receipts count once per organization of the policy, and only before the signed start', async () => {

    const report   = await analyzeDemo('sessions');
    const receipts = (name) => report.sessions.find(result => result.document.name === `publication-${name}.chargy`).prices.verification.publicationWitnesses.receipts.map(receipt => receipt.status);

    assert.deepEqual(receipts('session-before-start'),  [ 'counted', 'counted' ]);
    assert.deepEqual(receipts('same-organization'),     [ 'counted', 'duplicate-organization' ]);
    assert.deepEqual(receipts('late-receipt'),          [ 'counted', 'after-start' ]);

});

test('Sessions: without the policy of the settings, the receipts a session brings authorize nobody', async () => {

    const report = await analyzeDemo('sessions', { settings: { publicationPolicy: undefined } });
    const before = report.sessions.find(result => result.document.name === 'publication-session-before-start.chargy').prices.verification;

    assert.equal(before.publicationBeforeStart, 'not-proven');
    assert.ok(before.publicationWitnesses.receipts.every(receipt => receipt.status === 'untrusted'));

});

test('Sessions: the trust anchor a session brings is not trusted by itself, nor with a holder untrusted', async () => {

    // No trust anchor in the settings: nothing of a session is checked, it only offers its own.
    const none = await analyzeDemo('sessions', { settings: { trustAnchorText: '' } });
    assert.ok(none.sessions.every(result => result.authority === 'none' && result.meterKey === undefined && result.prices === undefined));
    assert.equal(summaryOf(none).warnings.length, 18);

    // Two holders, a quorum of two: without one of them, no trust context.
    const anchor = TrustAnchor.parse(readDemo('sessions').manifest.trustAnchor);
    const one    = await analyzeDemo('sessions', { settings: { trustedIdentityKeyIds: anchor.holders[0] } });
    assert.ok(one.sessions.every(result => result.evaluation.quorum === 'invalid' && result.evaluation.context === undefined));
    assert.ok(one.sessions.every(result => /^the identity keys trusted here give no trust context for the key statement of its operator/.test(result.error)));

});

test('Trust decisions: station proofs are checked with the keys trusted, a quorum of them', async () => {

    const anchor = TrustAnchor.parse(readDemo('thuringia').manifest.trustAnchor);
    const proofs = async (holders) => (await analyzeDemo('thuringia', { settings: { trustedIdentityKeyIds: anchor.holders.slice(3 - holders).flat() } })).proofs;

    // Two of three holders trusted: the quorum, with a trust context.
    const two = await proofs(2);
    assert.deepEqual(two.map(result => [ result.ok, result.basis, result.evaluation.quorum ]), [ [ true, 'context', 'valid' ], [ true, 'context', 'valid' ], [ true, 'context', 'valid' ] ]);

    // One: refused, as the quorum is not met.
    const one = await proofs(1);
    assert.deepEqual(one.map(result => [ result.ok, result.evaluation.signatures, result.evaluation.quorum ]), [ [ false, 'valid', 'invalid' ], [ false, 'valid', 'invalid' ], [ false, 'valid', 'invalid' ] ]);

    // No key of its operators may sign charging documents: their keys are restricted to infrastructure and prices.
    assert.ok(two.every(result => /no valid keys authorized for charging transparency records/.test(result.documentKeysError)));

});
