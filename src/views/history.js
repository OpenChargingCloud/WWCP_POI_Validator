/*
 * The history: every epoch, where it starts, its commits and checkpoints in their order, and for each of them what was
 * checked, who signed it and what it changed.
 */

import { get, toHex } from '@open-charging-cloud/wwcp-poi';

import { badge, button, facts, formatTime, h, i18n, jsonText, jsonView, plural, section, shortId } from '../dom.js';
import { keyDirectory, PARTY_LABELS } from '../keys.js';
import { changeChips, changeSetSignatureTable, checkList, emptyState, etagList, linkButton, roleSignatureTable } from './common.js';


const ROOT_KINDS = {
    genesis:     'the snapshot of its genesis',
    derived:     'the genesis derived from the final checkpoint of the epoch before',
    checkpoint:  'the snapshot of a checkpoint (joining, 10.5)',
    archive:     'the snapshot of an archive segment (10.6)',
    snapshot:    'a snapshot',
};


function stepTitle(step) {
    if (step.type === 'root')
        return `Start · revision ${step.revision}`;
    if (step.type === 'checkpoint')
        return `Checkpoint ${step.checkpoint.sequence}${step.checkpoint.isFinal ? ' · final' : ''}`;
    return `Revision ${step.revision}`;
}

function stepState(step) {
    if (step.type === 'root')
        return step.checks.every(check => check.ok !== false) && step.trust?.ok !== false ? 'good' : 'bad';
    return step.ok === false || step.operatorCheck?.ok === false || step.signatureCheck?.ok === false || step.priceStatements?.ok === false ? 'bad' : 'good';
}

function matches(step, filter) {
    if (!filter)
        return true;
    const text = [
        stepTitle(step), step.changeSet?.description,
        ...(step.changeSet?.changes ?? []).flatMap(change => [ change.entityType, change.entityId, change.propertyName ]),
        step.commit?.id, step.checkpoint?.id,
    ].filter(Boolean).join(' ').toLowerCase();
    return text.includes(filter.toLowerCase());
}


//  ------------------------------------------------------------------
//  The list
//  ------------------------------------------------------------------

function timelineList(report, selection, filter, onSelect) {

    const list = h('div', 'history-list');

    for (const epoch of report.epochs) {

        list.append(h('div', 'epoch-head',
            h('span', 'epoch-name', `Epoch ${epoch.number}`),
            epoch.profiles ? h('span', 'muted', ` ${epoch.profiles.identificationHash}${epoch.profiles.signatureAlgorithms.length ? ' · ' + epoch.profiles.signatureAlgorithms.join(', ') : ''}`) : null,
            epoch.status ? badge(epoch.status, epoch.status === 'active' ? 'ok' : 'info') : badge('not started', 'warn')));

        epoch.steps.forEach((step, index) => {

            if (!matches(step, filter))
                return;

            const item = h('button', `history-item ${step.type} ${stepState(step)}`);
            item.type = 'button';

            const selected = selection?.epoch === epoch.number && selection?.index === index;
            item.classList.toggle('selected', selected);

            const summary = step.type === 'commit'
                                ? h('div', 'item-text', step.changeSet?.description ?? '', changeChips(step.changeSet, 3))
                                : step.type === 'checkpoint'
                                    ? h('div', 'item-text', `revision ${step.checkpoint.revision}, ${plural(step.checkpoint.commits.size, 'commit')}`,
                                        step.signatureCheck?.witnessedBy?.length ? ` · witnessed by ${step.signatureCheck.witnessedBy.length}` : '',
                                        step.checkpoint.priceStatements ? ` · ${plural(step.checkpoint.priceStatements.size, 'price statement')}` : '')
                                    : h('div', 'item-text', ROOT_KINDS[step.kind] ?? step.kind);

            item.append(h('div', 'item-mark'), h('div', 'item-body', h('div', 'item-title', stepTitle(step), step.type === 'commit' ? h('span', 'muted', ` · ${formatTime(step.changeSet?.createdAt)}`) : null), summary));
            item.addEventListener('click', () => onSelect(epoch.number, index));
            list.append(item);

            if (selected)
                requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));

        });

        for (const missing of epoch.notTaken) {
            if (filter && !matches({ type: missing.type, commit: missing.commit, checkpoint: missing.checkpoint, changeSet: undefined }, filter))
                continue;
            list.append(h('div', `history-item ${missing.type} skipped${missing.refused ? ' bad' : ''}`,
                h('div', 'item-mark'),
                h('div', 'item-body',
                    h('div', 'item-title', missing.type === 'commit' ? `Revision ${missing.commit.revision}` : `Checkpoint ${missing.checkpoint.sequence}`, ' ',
                      missing.refused ? badge('refused', 'error') : badge('not taken', 'info')),
                    h('div', 'item-text', missing.reason),
                    missing.documents?.length ? h('div', 'item-text', 'in ', ...missing.documents.map(document => document.name).join(', ')) : null)));
        }

    }

    if (report.looseCommits.length > 0)
        list.append(h('div', 'epoch-head', h('span', 'epoch-name', `${plural(report.looseCommits.length, 'commit')} of no epoch reached`)));

    return list;

}


//  ------------------------------------------------------------------
//  The details
//  ------------------------------------------------------------------

function valueCell(value) {
    if (value === undefined)
        return h('span', 'muted', '—');
    if (value === null)
        return h('span', 'muted', 'absent');
    const text = jsonText(value);
    if (text.length <= 90)
        return h('code', 'value', text);
    return jsonView(value, { open: 0 });
}

function ownerCell(owner) {
    if (owner === undefined)
        return h('span', 'muted', '—');
    return h('span', null, h('strong', null, owner.id ?? '?'), h('div', 'muted small', `${PARTY_LABELS[owner.type] ?? owner.type}, ${owner.keys}${owner.usage && owner.keys === 'signing keys' ? ` for ${owner.usage}` : ''}${owner.note ? ` — ${owner.note}` : ''}`));
}

function changesTable(step) {

    const table = h('table', 'grid changes');
    table.append(h('thead', null, h('tr', null, h('th', 'num', '#'), h('th', null, 'Change'), h('th', null, 'Entity'), h('th', null, 'Old value'), h('th', null, 'New value'), h('th', null, 'Owner (4.1)'))));
    const body = h('tbody');

    step.changeSet.changes.forEach((change, index) => {
        body.append(h('tr', null,
            h('td', 'num', index),
            h('td', null, h('span', `kind ${change.kind}`, change.kind), change.propertyName ? h('div', null, h('code', null, change.propertyName)) : null),
            h('td', null, h('div', 'muted small', change.entityType), h('code', null, change.entityId),
                          change.parentEntityId ? h('div', 'muted small', `in ${change.parentEntityType} ${change.parentEntityId}`) : null),
            h('td', null, change.kind === 'Add' ? h('span', 'muted', '—') : valueCell(change.oldValue)),
            h('td', null, change.kind === 'Remove' || change.kind === 'RemoveProperty' ? h('span', 'muted', '—') : valueCell(change.newValue)),
            h('td', null, ownerCell(step.owners?.[index])),
        ));
    });

    table.append(body);
    return table;

}

function documentLinks(documents, actions) {
    if (!documents?.length)
        return undefined;
    return h('span', 'stack', ...documents.map(document => linkButton(document.name, () => actions.showDocument(document))));
}

function commitDetail(report, epoch, step, actions) {

    const commit    = step.commit;
    const directory = keyDirectory(step.before, { witnesses: report.witnesses });

    const operatorSummary = step.operatorCheck?.ok === true
        ? h('span', null, badge('quorum reached', 'ok'), ` ${step.operatorCheck.holders.join(', ')} — ${step.operatorCheck.required} of the holders required`)
        : step.operatorCheck?.ok === false
            ? h('span', null, badge('quorum not reached', 'error'), ' ', step.operatorCheck.error)
            : h('span', 'muted', step.operatorCheck?.detail ?? 'not checked');

    return h('div', 'detail',
        h('div', 'detail-head',
            h('h2', null, `Revision ${commit.revision} of epoch ${epoch.number}`, ' ', step.ok === false ? badge('refused', 'error') : badge('taken', 'ok')),
            h('p', 'lead', step.changeSet?.description ?? '')),
        facts([
            [ 'Commit', shortId(commit.id, 32) ],
            [ 'Parent', commit.parentIds.length ? shortId(commit.parentIds[0], 32) : undefined ],
            [ 'Change set', step.changeSet ? h('code', null, step.changeSet.id) : undefined ],
            [ 'Created at', formatTime(step.changeSet?.createdAt) ],
            [ 'Documents', documentLinks(step.documents, actions) ],
        ]),
        h('div', 'detail-actions',
            step.network ? button('Explore the network at this revision →', () => actions.showVersion(epoch.number, commit.revision), 'primary small') : null),

        h('h3', null, 'What was checked'),
        checkList(step.checks),
        h('div', 'operator-check', h('strong', null, 'Signed by the roaming network operator: '), operatorSummary),
        step.trustFollowed
            ? h('div', `trust-followed ${step.trustFollowed.ok ? 'ok' : 'error'}`,
                h('strong', null, 'New key statement: '),
                step.trustFollowed.ok
                    ? `signed by the identity keys trusted before (${step.trustFollowed.signedBy.join(', ')}), its keys are trusted from here on: ${step.trustFollowed.identityKeys.map(key => `${key.holder ?? '?'} ${key.id.slice(0, 8)}…`).join(', ')}`
                    : step.trustFollowed.error)
            : null,

        step.changeSet ? h('h3', null, `Changes (${step.changeSet.changes.length})`) : null,
        step.changeSet ? changesTable(step) : null,
        step.changeSet ? h('p', 'note', 'The owner of each change, as the table of section 4.1 names it; the library checks that each of them signed the change set with a key of the version before.') : null,

        h('h3', null, 'Signatures of the change set'),
        step.changeSetSigners?.length ? changeSetSignatureTable(step.changeSetSigners) : h('p', 'muted', 'none'),
        h('p', 'note', 'They sign the change set without its signatures, so that owners and holders sign on their own, in any order (4, 4.2).'),

        h('h3', null, 'Signatures of the commit'),
        roleSignatureTable(step.operatorSignatures, directory),
        h('p', 'note', 'They sign the commit with its identification, its ETags, the change set and its signatures: whoever signs a commit confirms the data together with who signed it (5.4).'),

        h('h3', null, 'ETags'),
        h('div', 'etag-flow',
            h('div', null, h('div', 'muted small', 'before (the version of the parent)'), etagList(step.changeSet?.beforeETags)),
            h('div', 'etag-arrow', '→'),
            h('div', null, h('div', 'muted small', 'after, as the commit names them'), etagList(commit.eTags))),

        h('details', 'raw', h('summary', null, 'The commit as JSON'), jsonView(commit.json, { open: 1 })),
    );

}

function priceTable(priceStatements) {
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Entity'), h('th', 'num', 'Seq.'), h('th', null, 'Valid'), h('th', null, 'Prices'), h('th', null, 'Signed'), h('th', null, 'Signature'))));
    const body = h('tbody');
    for (const item of priceStatements.statements ?? []) {
        const statement = item.statement;
        body.append(h('tr', null,
            h('td', null, h('div', 'muted small', statement.entityType), h('code', null, statement.entityId)),
            h('td', 'num', statement.sequence),
            h('td', 'small', `${formatTime(statement.validFrom)} – ${statement.validUntil ? formatTime(statement.validUntil) : 'next statement'}`),
            h('td', null, priceSummary(statement)),
            h('td', 'small', `${statement.signer}, ${formatTime(statement.signedAt)}`),
            h('td', null, item.ok ? badge('valid', 'ok') : badge('invalid', 'error', item.error), item.ok ? null : h('div', 'check-detail', item.error))));
    }
    table.append(body);
    return table;
}

const PER = { ENERGY: 'per kWh', TIME: 'per hour', PARKING_TIME: 'per hour parked', FLAT: 'per session' };

/** The prices of a statement in a few words: "DE*GEF*T_AC: 0.49 per kWh". */
export function priceSummary(statement) {
    const parts = [];
    for (const price of statement.prices) {
        const components = [];
        for (const element of Array.isArray(price['elements']) ? price['elements'] : [])
            for (const component of Array.isArray(element['priceComponents']) ? element['priceComponents'] : [])
                components.push(`${jsonText(component['price'])} ${PER[String(component['type'])] ?? 'per ' + String(component['type']).toLowerCase()}`);
        parts.push(h('div', null, h('code', null, String(price['chargingTariffId'])), ': ', components.join(', ') || '—'));
    }
    return h('div', null, ...parts);
}

function checkpointDetail(report, epoch, step, actions) {

    const checkpoint = step.checkpoint;
    const version    = epoch.history?.versionOf(checkpoint.commitId);
    const directory  = keyDirectory(version?.network ?? report.head?.version.network, { witnesses: report.witnesses });
    const commitIndex = epoch.steps.findIndex(item => item.type !== 'checkpoint' && item.commit?.id === checkpoint.commitId);
    const check      = step.signatureCheck;

    return h('div', 'detail',
        h('div', 'detail-head',
            h('h2', null, `Checkpoint ${checkpoint.sequence} of epoch ${epoch.number}`, ' ',
                checkpoint.isFinal ? badge('final', 'info') : null, ' ',
                step.ok === false ? badge('refused', 'error') : badge('taken', 'ok')),
            h('p', 'lead', `States that the ${plural(checkpoint.commits.size, 'commit')} up to revision ${checkpoint.revision}, since ${checkpoint.previousId ? 'the previous checkpoint' : checkpoint.previous ? 'the genesis of the epoch' : 'the genesis'}, are part of the history — signed by the operator${check?.witnessedBy?.length ? ' and witnessed' : ''}.`)),
        facts([
            [ 'Checkpoint', shortId(checkpoint.id, 32) ],
            [ 'Previous', checkpoint.previousId ? shortId(checkpoint.previousId, 32) : 'none: the first of its epoch' ],
            [ 'Commit', h('span', null, shortId(checkpoint.commitId, 24), commitIndex >= 0 ? h('span', null, ' ', linkButton(`revision ${checkpoint.revision}`, () => actions.showStep(epoch.number, commitIndex))) : ` revision ${checkpoint.revision}`) ],
            [ 'Commits tree', h('span', null, `${checkpoint.commits.size} leaves, root `, shortId(toHex(checkpoint.commits.root), 16)) ],
            [ 'Price statements tree', checkpoint.priceStatements ? h('span', null, `${checkpoint.priceStatements.size} leaves, root `, shortId(toHex(checkpoint.priceStatements.root), 16)) : undefined ],
            [ 'Created at', formatTime(checkpoint.createdAt) ],
            [ 'Documents', documentLinks(step.documents, actions) ],
        ]),

        h('h3', null, 'What was checked'),
        checkList(step.checks),
        h('div', 'operator-check',
            h('strong', null, 'Signatures required: '),
            check?.ok === true
                ? h('span', null, badge('present', 'ok'), ` operator: ${check.signedBy.join(', ')} (${check.required} required); witnesses: ${check.witnessedBy.join(', ') || 'none'} (${check.requiredWitnesses} required)`)
                : check?.ok === false
                    ? h('span', null, badge('missing', 'error'), ' ', check.error)
                    : h('span', 'muted', check?.detail ?? 'not checked')),

        h('h3', null, 'Signatures'),
        roleSignatureTable(step.signatures, directory),
        h('p', 'note', 'A witness signs only after it took every commit itself, and never two checkpoints of one sequence: that makes a split view visible (10.2). Signatures by keys nobody trusts are not counted — and do not block the checkpoint.'),

        checkpoint.isFinal && checkpoint.next
            ? h('div', null, h('h3', null, `The next epoch: ${checkpoint.next.number}`),
                facts([ [ 'Identification hash', checkpoint.next.profiles.identificationHash ],
                        [ 'Signature algorithms', checkpoint.next.profiles.signatureAlgorithms.join(', ') || 'any' ],
                        [ 'Canonicalization', String(get(checkpoint.next.profiles.toJSON(), 'canonicalization') ?? '') ] ]),
                h('p', 'note', 'Every server derives the same genesis of the next epoch from this checkpoint: the version of its commit, revision 0, naming the epoch and its profiles (11.3).'))
            : null,

        checkpoint.previous
            ? h('div', null, h('h3', null, `Follows epoch ${checkpoint.previous.epoch}`),
                facts([ [ 'Final checkpoint', shortId(checkpoint.previous.checkpointId, 32) ] ]),
                h('p', 'note', 'The first checkpoint of an epoch is signed with the algorithms of both epochs, so that a verifier trusting only the old ones follows into the new epoch (11.3).'))
            : null,

        step.priceStatements
            ? h('div', null,
                h('h3', null, `Price statements (${step.priceStatements.size})`),
                step.priceStatements.missing
                    ? h('p', 'muted', 'The documents do not give the statements it names (GET …/history/checkpoints/{id}/priceStatements).')
                    : h('div', null,
                        h('p', null, step.priceStatements.ok ? badge('their tree is the one of the checkpoint, each signed by its operator', 'ok') : badge(step.priceStatements.error ?? 'a statement does not verify', 'error')),
                        priceTable(step.priceStatements)),
                h('p', 'note', 'The statements the server took since the previous checkpoint: the checkpoint proves they were made before it (12.3).'))
            : null,

        h('details', 'raw', h('summary', null, 'The checkpoint as JSON'), jsonView(checkpoint.json, { open: 1 })),
    );

}

function rootDetail(report, epoch, step, actions) {

    const trust = step.trust;

    return h('div', 'detail',
        h('div', 'detail-head',
            h('h2', null, `Epoch ${epoch.number} starts at revision ${step.revision}`),
            h('p', 'lead', `From ${ROOT_KINDS[step.kind] ?? step.kind}.`)),
        facts([
            [ 'Commit', shortId(step.commit.id, 32) ],
            [ 'Network', step.network ? `${i18n(step.network.name) ?? step.network.id}` : undefined ],
            [ 'Profiles', epoch.profiles ? `${epoch.profiles.identificationHash}; ${epoch.profiles.signatureAlgorithms.join(', ') || 'any signature algorithm'}` : undefined ],
            [ 'Document', step.document ? linkButton(step.document.name, () => actions.showDocument(step.document)) : undefined ],
        ]),
        step.network ? h('div', 'detail-actions', button('Explore this version →', () => actions.showVersion(epoch.number, step.revision), 'primary small')) : null,
        h('h3', null, 'What was checked'),
        checkList(step.checks),
        h('h3', null, 'Trust in the roaming network operator'),
        trust?.basis === 'pinned' && trust.ok
            ? h('div', 'trust-followed ok', `The key statement of the operator verifies against the trust anchor: signed by trusted identity keys of ${trust.signedBy.join(', ')} — ${trust.required} required — and valid at ${formatTime(report.at)}.`)
            : trust?.basis === 'followed' && trust.ok
                ? h('div', 'trust-followed ok', `The keys were followed from the epoch before: the key statement is signed by ${trust.signedBy.join(', ')}.`)
                : null,
        trust?.ok === false ? h('div', 'trust-followed error', trust.error) : null,
        step.tofu?.ok ? h('div', 'trust-followed warn', `Trusted on first use: the ${plural(step.tofu.keys.length, 'identity key')} the version states itself, a quorum of ${step.tofu.minConsensus}. This shows a consistent history, not who made it.`) : null,
        step.tofu?.ok === false ? h('div', 'trust-followed error', `No trust: ${step.tofu.error}`) : null,
        h('h3', null, 'ETags'),
        etagList(step.commit.eTags),
        step.commit.profiles ? h('details', 'raw', h('summary', null, 'The genesis commit as JSON'), jsonView(step.commit.json, { open: 1 })) : null,
    );

}


export function renderHistory(container, state, actions) {

    const report = state.report;

    if (report.epochs.length === 0) {
        container.append(section('History', emptyState('The documents give no history.', 'A history starts from a snapshot — of the genesis, of a checkpoint, or of an archive segment — and takes the commits since.')));
        return;
    }

    let selection = state.selection.historyStep;
    if (selection === undefined || report.epochs.find(epoch => epoch.number === selection.epoch)?.steps[selection.index] === undefined)
        selection = state.selection.historyStep = { epoch: report.epochs[0].number, index: 0 };

    const filterInput = h('input', 'filter');
    filterInput.type = 'search';
    filterInput.placeholder = 'Filter: an entity, a property, a word …';
    filterInput.value = state.selection.historyFilter ?? '';

    const left  = h('div', 'history-left');
    const right = h('div', 'history-right');

    const select = (epochNumber, index) => {
        state.selection.historyStep = { epoch: epochNumber, index };
        renderBoth();
    };

    const renderBoth = () => {
        const current = state.selection.historyStep;
        left.replaceChildren(timelineList(report, current, filterInput.value.trim(), select));
        const epoch = report.epochs.find(item => item.number === current.epoch);
        const step  = epoch?.steps[current.index];
        right.replaceChildren(step === undefined ? emptyState('Choose a step of the history.')
                              : step.type === 'commit'     ? commitDetail(report, epoch, step, actions)
                              : step.type === 'checkpoint' ? checkpointDetail(report, epoch, step, actions)
                              :                              rootDetail(report, epoch, step, actions));
    };

    filterInput.addEventListener('input', () => {
        state.selection.historyFilter = filterInput.value;
        left.replaceChildren(timelineList(report, state.selection.historyStep, filterInput.value.trim(), select));
    });

    container.append(h('div', 'history-layout', h('div', 'history-side', filterInput, left), right));
    renderBoth();

}
