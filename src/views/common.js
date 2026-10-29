/*
 * What several views show alike: versions to choose from, signatures, checks, keys, changes and ETags.
 */

import { etagToText, paymentOptionName } from '@open-charging-cloud/wwcp-poi';

import { badge, formatTime, h, i18n, shortId, statusIcon } from '../dom.js';
import { PARTY_LABELS } from '../keys.js';


/** Every version the report holds, in their order: `{ key: 'epoch:revision', label, version }`. */
export function versionsOf(report) {
    return [ ...report.versions.values() ]
               .sort((left, right) => left.epoch - right.epoch || left.revision - right.revision)
               .map(version => ({
                   key:     `${version.epoch}:${version.revision}`,
                   label:   `Epoch ${version.epoch} · revision ${version.revision}${version.step?.changeSet?.description ? ' — ' + version.step.changeSet.description : version.revision === 0 ? ' — genesis' : ''}`,
                   version,
               }));
}

export function headKey(report) {
    return report.head ? `${report.head.epoch}:${report.head.version.commit.revision}` : versionsOf(report).at(-1)?.key;
}

/** A select of the versions of the report. */
export function versionSelect(report, selected, onChange) {
    const select = h('select', 'version-select');
    for (const { key, label } of versionsOf(report)) {
        const option = h('option', null, label.length > 90 ? label.slice(0, 90) + '…' : label);
        option.value = key;
        option.selected = key === selected;
        select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
}


/** A list of checks, each with its verdict and, where it failed, why. */
export function checkList(checks) {
    const list = h('ul', 'checks');
    for (const check of checks ?? [])
        list.append(h('li', check.ok === false ? 'failed' : check.ok === true ? 'passed' : 'skipped',
                      statusIcon(check.ok), h('span', 'check-label', check.label),
                      check.detail ? h('div', 'check-detail', check.detail) : null));
    return list;
}


const STATUS_KIND = { valid: 'ok', invalid: 'error', untrusted: 'warn', ignored: 'info' };
const STATUS_TEXT = { valid: 'valid', invalid: 'invalid', untrusted: 'not counted', ignored: 'ignored' };

/** The signatures of a commit or checkpoint, as the analysis described them. */
export function roleSignatureTable(signatures, directory) {

    const table = h('table', 'grid signatures');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Role'), h('th', null, 'Holder / witness'), h('th', null, 'Key'), h('th', null, 'Algorithm'), h('th', null, 'Signed at'), h('th', null, 'Verdict'))));
    const body = h('tbody');

    for (const signature of signatures ?? []) {
        const entry = directory?.get(signature.keyId);
        body.append(h('tr', null,
            h('td', null, signature.role === 'roamingNetworkOperator' ? 'roaming network operator' : signature.role),
            h('td', null, signature.holder ?? signature.signer ?? entry?.holder ?? '—'),
            h('td', null, shortId(signature.keyId), entry?.kind === 'signing' && entry.usages.length ? h('span', 'muted', ` ${entry.usages.join(', ')}`) : null),
            h('td', null, signature.algorithm),
            h('td', 'nowrap', formatTime(signature.signedAt)),
            h('td', null, badge(STATUS_TEXT[signature.status] ?? signature.status, STATUS_KIND[signature.status] ?? 'info', signature.detail), signature.detail && signature.status !== 'valid' ? h('div', 'check-detail', signature.detail) : null),
        ));
    }

    table.append(body);
    return table;

}


/** Who holds a key, in a few words: "AlphaOrg · signing key of OCC (party)". */
export function keyOwner(entry) {
    if (entry === undefined)
        return h('span', 'muted', 'unknown key');
    const what = entry.kind === 'witness' ? 'trusted witness' : `${entry.kind} key of ${PARTY_LABELS[entry.ownerType] ?? entry.ownerType} ${entry.ownerId}`;
    return h('span', 'key-owner',
             entry.holder ? h('strong', null, entry.holder, ' · ') : null,
             what,
             entry.usages?.length ? h('span', 'muted', ` (${entry.usages.join(', ')})`) : null);
}


/** The signatures of a change set: by the owners of its changes, or by new identity keys as their proof of possession. */
export function changeSetSignatureTable(signers) {

    const table = h('table', 'grid signatures');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Whose'), h('th', null, 'Algorithm'), h('th', null, 'Signature'))));
    const body = h('tbody');

    for (const signer of signers ?? [])
        body.append(h('tr', null,
            h('td', null, shortId(signer.keyId)),
            h('td', null, signer.proofOfPossession
                              ? h('span', null, 'new identity key of ', h('strong', null, signer.proofOfPossession.ownerId), h('span', 'muted', ' — its proof of possession (4.1)'))
                              : keyOwner(signer.entry)),
            h('td', null, signer.algorithm),
            h('td', null, signer.valid === true ? badge('valid', 'ok') : signer.valid === false ? badge('invalid', 'error', signer.detail) : badge('unknown key', 'warn', signer.detail),
                          signer.detail && signer.valid !== true ? h('div', 'check-detail', signer.detail) : null),
        ));

    table.append(body);
    return table;

}


const KIND_CLASSES = { Add: 'add', Remove: 'remove', UpdateProperty: 'update', RemoveProperty: 'remove' };

/** One change as a chip: "Add ChargingPool DE*GEF*P1", "maxPower of EVSE DE*GEF*E6*1". */
export function changeChip(change) {
    const text = change.propertyName
                     ? `${change.kind === 'RemoveProperty' ? '−' : '✎'} ${change.entityType} ${change.entityId} · ${change.propertyName}`
                     : `${change.kind === 'Add' ? '+' : change.kind === 'Remove' ? '−' : change.kind} ${change.entityType} ${change.entityId}`;
    return h('span', `chip change ${KIND_CLASSES[change.kind] ?? ''}`, text);
}

/** The changes of a change set as chips, at most `limit` of them. */
export function changeChips(changeSet, limit = 4) {
    if (changeSet === undefined)
        return null;
    const chips = changeSet.changes.slice(0, limit).map(changeChip);
    if (changeSet.changes.length > limit)
        chips.push(h('span', 'chip more', `+${changeSet.changes.length - limit} more`));
    return h('span', 'chips', ...chips);
}


/** ETags, one per line, as text. */
export function etagList(eTags) {
    const list = h('div', 'etags');
    for (const eTag of eTags ?? []) {
        const text = etagToText(eTag);
        const [ format, algorithm, , digest ] = text.split(':');
        list.append(h('div', 'etag', h('span', 'etag-format', format), h('span', 'etag-alg', algorithm), h('code', 'etag-digest', digest)));
    }
    return list;
}


/** The name of the roaming network of a version, as the version (which the attestations cover) says it. */
export function networkName(network) {
    return i18n(network?.name) ?? network?.id;
}

/** A link-like button. */
export function linkButton(label, onClick, title) {
    const element = h('button', 'link', label);
    element.type = 'button';
    if (title)
        element.title = title;
    element.addEventListener('click', onClick);
    return element;
}

/** An empty state, e.g. "No proofs were loaded". */
export function emptyState(text, hint) {
    return h('div', 'empty-state', h('p', null, text), hint ? h('p', 'hint', hint) : null);
}

/** A text in languages as WWCP_POI.TS gives it, `[ [ language, text ], … ]`, as the page shows texts: English first. */
export const i18nOf = (texts) => i18n(Object.fromEntries(texts));

/** The payment option as drivers see it where an exchange pays, e.g. "EV Taler (Example Exchange, EUR)" (EVTaler.md 4.1). */
export const evTalerName = (exchange) => i18nOf(paymentOptionName(exchange));

/**
 * The EV Taler merchant of a charging station operator, as WWCP_POI.TS read it: its instance at a merchant backend, the key
 * its contracts are signed with, and the exchanges whose coins it takes (EVTaler.md 4.2).
 */
export function evTalerMerchant(merchant) {

    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Exchange'), h('th', null, 'Currency'), h('th', null, 'Base URL'), h('th', null, 'Master public key'))));
    table.append(h('tbody', null, ...merchant.exchanges.map(exchange => h('tr', null,
        h('td', null, i18nOf(exchange.name), h('div', 'muted small', evTalerName(exchange))),
        h('td', null, h('code', null, exchange.currency)),
        h('td', null, h('code', 'small', exchange.baseURL)),
        h('td', null, shortId(exchange.masterPublicKey, 16))))));

    return h('div', null,
        h('dl', 'facts',
            h('dt', null, 'Merchant'),            h('dd', null, h('code', 'small', merchant.merchantBaseURL)),
            h('dt', null, 'Its public key'),      h('dd', null, shortId(merchant.merchantPublicKey, 16))),
        table);

}
