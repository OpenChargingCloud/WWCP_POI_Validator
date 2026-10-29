/*
 * Trust: from the identity keys the trust anchor pins to the key statement of the roaming network operator, its holders,
 * the certificates of their signing keys, and on to every signature of the history. Also the keys of the parties, the
 * trusted witnesses, and where the operator's keys moved on.
 */

import { POIPublicKey, get } from '@open-charging-cloud/wwcp-poi';

import { attrs, badge, formatTime, h, i18n, plural, section, shortId } from '../dom.js';
import { PARTY_LABELS, keyAlgorithm, keyDirectory, partiesWithKeys } from '../keys.js';
import { headKey, linkButton, versionSelect } from './common.js';


function validity(key) {
    if (key.notBefore === undefined && key.notAfter === undefined)
        return 'no validity limits';
    return `${key.notBefore !== undefined ? formatTime(key.notBefore) : '…'} – ${key.notAfter !== undefined ? formatTime(key.notAfter) : '…'}`;
}

function keyCard(entry, extra = []) {
    return h('div', `key-card ${entry.kind}`,
        h('div', 'key-head', h('span', 'key-kind', entry.kind === 'identity' ? 'identity key' : 'signing key'), shortId(entry.id, 16)),
        h('div', 'key-meta', entry.algorithm),
        h('div', 'key-meta muted', validity(entry)),
        entry.usages?.length ? h('div', 'key-usages', ...entry.usages.map(usage => h('span', 'chip', usage))) : null,
        h('div', 'key-badges', ...extra));
}


/** The trust chain of a version: anchor → key statement → holders with their identity and signing keys. */
function trustChain(report, network, anchor) {

    const operator  = network.operator;

    if (operator === undefined)
        return h('p', null, 'This version names no roaming network operator: nothing to trust.');

    const statement = operator.keyStatement;
    const directory = keyDirectory(network, { anchor });
    const holders   = [ ...new Set([ ...operator.identityKeys.map(key => key.holderOrUnnamed), ...operator.signingKeyCertificates.map(certificate => certificate.signingKey.holderOrUnnamed) ]) ].sort();
    const signedBy  = new Set(statement?.signatures.map(signature => signature.keyId) ?? []);

    const anchorBox = h('div', 'chain-box anchor',
        h('div', 'chain-title', 'Trust anchor'),
        anchor
            ? h('div', null,
                h('div', 'chain-line', `${plural(anchor.keys.length, 'identity key')} pinned by @id`),
                h('div', 'chain-line', `quorum: ${anchor.minConsensus} of ${plural(anchor.holders.length, 'holder')}, the keys named per holder`),
                h('div', 'stack', ...anchor.holders.map((keys, index) => h('div', 'pinned-key',
                    h('span', 'muted', `holder ${index + 1}: `),
                    ...keys.map(key => {
                        const known = directory.get(key);
                        return h('span', null, shortId(key, 10), known ? h('span', 'muted', ` ${known.holder ?? ''} `) : h('span', 'muted', ' not in this version '));
                    })))))
            : h('div', 'chain-line muted', report.anchor.kind === 'invalid' ? 'invalid' : 'none given: trust on first use'));

    const statementBox = h('div', 'chain-box statement',
        h('div', 'chain-title', 'Key statement'),
        statement
            ? h('div', null,
                h('div', 'chain-line', `${plural(statement.identityKeys.length, 'identity key')}, minConsensus ${statement.minConsensus}`),
                h('div', 'chain-line', `signed ${formatTime(statement.signedAt)}`),
                h('div', 'chain-line', `valid until ${formatTime(statement.validUntil)}`),
                h('div', 'chain-line', statement.isValidAt(report.at) ? badge('valid at the time checked', 'ok') : badge('not valid at the time checked', 'warn')),
                h('div', 'chain-line', `signed by ${plural(statement.signatures.length, 'identity key')} of ${[ ...new Set(statement.signatures.map(signature => directory.get(signature.keyId)?.holder ?? '?')) ].join(', ')}`))
            : h('div', 'chain-line muted', 'none'));

    const holderColumns = h('div', 'holders');

    for (const holder of holders) {

        const identity = operator.identityKeys.filter(key => key.holderOrUnnamed === holder);
        const signing  = operator.signingKeyCertificates.filter(certificate => certificate.signingKey.holderOrUnnamed === holder);

        holderColumns.append(h('div', 'holder',
            h('div', 'holder-name', holder),
            h('div', 'holder-section', 'Identity keys'),
            ...identity.map(key => keyCard(directory.get(key.id), [
                anchor?.keys.includes(key.id) ? badge('pinned', 'ok', 'The trust anchor names this key') : null,
                signedBy.has(key.id) ? badge('signed the key statement', 'info') : null,
            ])),
            h('div', 'holder-section', 'Signing keys, certified by the holder'),
            ...signing.map(certificate => keyCard(directory.get(certificate.signingKey.id), [
                badge(`certified by ${certificate.keyId.slice(0, 8)}…`, 'info', `Certificate signed ${formatTime(certificate.signedAt)} by the identity key ${certificate.keyId}`),
            ])),
            signing.length === 0 ? h('div', 'muted small', 'none') : null,
        ));

    }

    return h('div', 'chain',
        h('div', 'chain-row', anchorBox, h('div', 'chain-arrow', '→'), statementBox),
        h('div', 'chain-down', '↓ the identity keys of the statement are trusted as well; each holder certifies its own signing keys'),
        holderColumns);

}


/** How often each holder and witness signed, of what the history took. */
function signerTable(report) {

    const counts = new Map();
    const bump   = (who, column) => {
        const row = counts.get(who) ?? { commits: 0, checkpoints: 0, witnessed: 0, attestations: 0 };
        row[column]++;
        counts.set(who, row);
    };

    for (const epoch of report.epochs)
        for (const step of epoch.steps) {
            if (step.type === 'commit')
                for (const signature of step.operatorSignatures ?? [])
                    if (signature.status === 'valid')
                        bump(signature.holder, 'commits');
            if (step.type === 'checkpoint')
                for (const signature of step.signatures ?? [])
                    if (signature.status === 'valid')
                        bump(signature.holder, signature.role === 'witness' ? 'witnessed' : 'checkpoints');
        }

    for (const attestation of report.attestations)
        if (attestation.ok)
            bump(attestation.holder, 'attestations');

    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Holder or witness'), h('th', 'num', 'Commits'), h('th', 'num', 'Checkpoints as operator'), h('th', 'num', 'Checkpoints as witness'), h('th', 'num', 'Attestations'))));
    const body = h('tbody');
    for (const [ who, row ] of [ ...counts ].sort())
        body.append(h('tr', null, h('td', null, who), h('td', 'num', row.commits), h('td', 'num', row.checkpoints), h('td', 'num', row.witnessed), h('td', 'num', row.attestations)));
    table.append(body);

    return table;

}


/** The commits that changed the keys of the operator: key succession (8.6) and epochs (11). */
function succession(report, actions) {

    const list = h('ol', 'succession');

    for (const epoch of report.epochs) {
        epoch.steps.forEach((step, index) => {
            if (step.type === 'root' && (step.trust || step.tofu))
                list.append(h('li', null,
                    h('strong', null, `Epoch ${epoch.number}, revision ${step.revision}`), ' — ',
                    step.trust?.basis === 'pinned'   ? `the key statement verifies against the trust anchor, signed by ${step.trust.signedBy?.join(', ') ?? '—'}` :
                    step.trust?.basis === 'followed' ? `the keys followed from the epoch before, the statement signed by ${step.trust.signedBy?.join(', ')}` :
                    step.tofu?.ok                     ? 'trusted on first use: the keys the version states itself' : 'not trusted',
                    step.trust?.ok === false ? h('div', 'check-detail', step.trust.error) : null,
                    ' ', linkButton('show', () => actions.showStep(epoch.number, index))));
            if (step.type === 'commit' && step.trustFollowed)
                list.append(h('li', step.trustFollowed.ok ? null : 'failed',
                    h('strong', null, `Epoch ${epoch.number}, revision ${step.revision}`), ' — ', step.changeSet?.description ?? '', ': ',
                    step.trustFollowed.ok
                        ? `a new key statement, signed by the keys trusted before (${step.trustFollowed.signedBy.join(', ')}): its ${plural(step.trustFollowed.identityKeys.length, 'identity key')} are trusted from now on`
                        : h('span', 'error-text', step.trustFollowed.error),
                    ' ', linkButton('show', () => actions.showStep(epoch.number, index))));
            if (step.type === 'checkpoint' && step.checkpoint.isFinal)
                list.append(h('li', null,
                    h('strong', null, `Epoch ${epoch.number}, checkpoint ${step.checkpoint.sequence}`), ' — final: the next epoch signs with ',
                    step.checkpoint.next?.profiles.signatureAlgorithms.join(', ') || 'any algorithm', ' and identifies with ', step.checkpoint.next?.profiles.identificationHash ?? '?',
                    ' ', linkButton('show', () => actions.showStep(epoch.number, index))));
        });
    }

    return list;

}


/** Every party of a version and its keys. */
function partyKeys(network) {

    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Party'), h('th', null, 'Kind'), h('th', null, 'Key'), h('th', null, 'Algorithm'), h('th', null, 'Usages'), h('th', null, 'Valid'))));
    const body = h('tbody');

    for (const party of partiesWithKeys(network)) {
        const rows = [];
        for (const [ kind, property ] of [ [ 'signing', 'signingKeys' ], [ 'identity', 'identityKeys' ] ]) {
            let keys = [];
            try {
                keys = POIPublicKey.parseAll(get(party.json, property), property);
            }
            catch {
                keys = [];
            }
            for (const key of keys)
                rows.push(h('tr', null,
                    h('td', null, rows.length === 0 ? h('span', null, h('strong', null, party.id), h('div', 'muted small', PARTY_LABELS[party.type])) : ''),
                    h('td', null, kind), h('td', null, shortId(key.id)), h('td', null, keyAlgorithm(key)),
                    h('td', null, key.usages.length ? key.usages.join(', ') : kind === 'signing' ? 'everything it owns' : '—'),
                    h('td', 'small', validity(key))));
        }
        if (rows.length === 0)
            rows.push(h('tr', null, h('td', null, h('strong', null, party.id), h('div', 'muted small', PARTY_LABELS[party.type])),
                        attrs(h('td', null, h('span', 'muted', 'no keys: the roaming network operator signs in its place')), { colspan: 5 })));
        body.append(...rows);
    }

    table.append(body);
    return table;

}


function witnessTable(report) {
    if (report.witnesses.length === 0)
        return h('p', 'muted', 'No witnesses are configured: checkpoints are checked for the signatures of the operator only.');
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Witness'), h('th', null, 'Key'), h('th', null, 'Algorithm'))));
    const body = h('tbody');
    for (const witness of report.witnesses)
        body.append(h('tr', null, h('td', null, witness.witness), h('td', null, shortId(witness.key.id)), h('td', null, keyAlgorithm(witness.key))));
    table.append(body);
    return h('div', null, table, h('p', 'note', `A checkpoint needs ${report.requiredWitnesses} of them. Witnesses are trusted by configuration, like the trust anchor, never by what the network says (10.2).`));
}


export function renderTrust(container, state, actions) {

    const report  = state.report;
    const key     = state.selection.trustVersion ?? headKey(report);
    const version = report.versions.get(key);

    if (version === undefined) {
        container.append(section('Trust', h('p', null, 'No version was taken: there are no keys to show.')));
        return;
    }

    const anchor = report.anchor.kind === 'pinned' ? report.anchor.anchor : undefined;
    const select = versionSelect(report, key, (value) => { state.selection.trustVersion = value; actions.render(); });

    container.append(section('Trust chain',
        h('div', 'toolbar', h('label', null, 'Keys of ', select)),
        h('p', 'note', 'An app pins only a few long-lived identity keys. The roaming network operator states them in its key statement, signed by its quorum; each of its holders certifies its own signing keys, and only those sign commits, checkpoints and attestations — each holder has one voice.'),
        trustChain(report, version.network, anchor)));

    container.append(section('Who signed what', signerTable(report),
        h('p', 'note', 'Counted are signatures that verify with a key trusted at that point of the history. A holder signing with several keys still has one voice.')));

    container.append(section('How the trust moved on', succession(report, actions),
        h('p', 'note', 'A verifier that follows the history commit by commit follows the keys as well: a new key statement counts when the keys trusted before signed it (8.6, Succession). An app that only scanned an old QR code does not — it needs the new trust anchor.')));

    container.append(section(`Parties and their keys (${i18n(version.network.name) ?? version.network.id}, epoch ${version.epoch}, revision ${version.revision})`, partyKeys(version.network),
        h('p', 'note', 'A change is signed by its owner with a signing key that may sign its usage: infrastructure, tariffs, priceStatements, models, software, certificates, payments (the EV Taler merchant of a charging station operator) or party (4.1). A party without signing keys is changed by the roaming network operator in its place.')));

    container.append(section('Trusted witnesses', witnessTable(report)));

}
