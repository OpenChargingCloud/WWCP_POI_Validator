/*
 * The overview: the verdict, the roaming network as its verified head names it, the trust anchor, the head, what the
 * network holds, a timeline of the history, and every problem found.
 */

import qrcode from 'qrcode-generator';

import { get } from '@open-charging-cloud/wwcp-poi';

import { badge, facts, formatTime, h, i18n, plural, section, shortId } from '../dom.js';
import { countEntities } from '../entities.js';
import { emptyState, etagList, linkButton, networkName } from './common.js';


function verdictBanner(report) {

    const { verdict } = report;
    const head    = report.head;
    const network = head?.version.network;
    const name    = networkName(network) ?? report.roamingNetworkId ?? 'the documents';
    const basis   = report.anchor.kind === 'pinned' ? 'from its trust anchor' : 'without a trust anchor (trust on first use)';

    let title;
    let text;

    if (verdict.level === 'ok') {
        title = `${name}: verified ${basis}`;
        text  = head
                    ? `${plural(report.epochs.length, 'epoch')}, ${plural(verdict.commits, 'commit')} and ${plural(verdict.checkpoints, 'checkpoint')} taken commit by commit; the head is revision ${head.version.commit.revision} of epoch ${head.epoch}.`
                    : 'Every document checked holds.';
    }
    else if (verdict.level === 'warn') {
        title = `${name}: checked, with ${plural(verdict.warnings, 'warning')}`;
        text  = 'What was checked holds, but read the warnings below: they say what could not be checked, or what is trusted less than it should be.';
    }
    else if (verdict.level === 'error') {
        title = `${name}: ${plural(verdict.errors, 'problem')} found`;
        text  = 'Some documents do not verify. The problems are listed below; the views show where in the history they are.';
    }
    else {
        title = 'Nothing to verify yet';
        text  = 'The documents give no version of a roaming network to start from. Add a snapshot, or load from the servers of a trust anchor.';
    }

    return h('div', `verdict ${verdict.level}`, h('div', 'verdict-icon', verdict.level === 'ok' ? '✓' : verdict.level === 'error' ? '✗' : '!'),
             h('div', null, h('h2', null, title), h('p', null, text)));

}


function qrCodeOf(text) {
    try {
        const qr = qrcode(0, 'L');
        qr.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte');
        qr.make();
        const holder = h('div', 'qr');
        holder.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 6, scalable: true, alt: 'QR code of the trust anchor' });
        return holder;
    }
    catch {
        return null;
    }
}


function trustAnchorCard(report) {

    const { anchor: info } = report;

    if (info.kind === 'pinned') {
        const anchor = info.anchor;
        const qr     = qrCodeOf(info.text.startsWith('WWCP/') ? info.text : anchor.toQRCode());
        return h('div', 'card',
            h('h3', null, 'Trust anchor ', badge('pinned', 'ok')),
            h('div', 'card-split',
                facts([
                    [ 'Roaming network', h('code', null, anchor.id) ],
                    [ 'Name (unverified)', i18n(anchor.name) ],
                    [ 'Identity keys', h('div', 'stack', ...anchor.keys.map(key => shortId(key, 16))) ],
                    [ 'Quorum', anchor.minConsensus > 1 ? `${anchor.minConsensus} holders` : 'one holder' ],
                    [ 'Servers', h('div', 'stack', ...anchor.urls.map(url => h('code', 'url', url))) ],
                ]),
                qr),
            h('p', 'note', 'Only the key @ids and the quorum are trusted. The name of a QR code is not: the page shows the one the verified network signs.'),
            report.followedAnchor ? h('p', 'note', 'The history moved on to other identity keys (key succession, 8.6); proofs of later versions are checked with the keys it followed.') : null,
        );
    }

    if (info.kind === 'invalid')
        return h('div', 'card error-card', h('h3', null, 'Trust anchor ', badge('invalid', 'error')), h('p', null, info.error));

    return h('div', 'card warn-card', h('h3', null, 'Trust anchor ', badge('none', 'warn')),
             h('p', null, 'No trust anchor was given. The signatures are checked against the keys the network states itself — that shows that the history is consistent, not who made it.'));

}


function networkCard(report) {
    const network = report.head?.version.network;
    if (network === undefined)
        return null;
    const operator = network.operator;
    return h('div', 'card',
        h('h3', null, networkName(network)),
        facts([
            [ 'Identification', h('code', null, network.id) ],
            [ 'Description', i18n(network.description) ],
            [ 'Operator', operator ? h('span', null, h('code', null, operator.id), i18n(get(operator.json, 'name')) ? ` · ${i18n(get(operator.json, 'name'))}` : '') : '—' ],
            [ 'Holders', operator ? [ ...new Set(operator.identityKeys.map(key => key.holderOrUnnamed)) ].sort().join(', ') : undefined ],
            [ 'Quorum', operator ? `${operator.minConsensus} of ${new Set(operator.identityKeys.map(key => key.holderOrUnnamed)).size} holders` : undefined ],
            [ 'Tree hashes', network.treeHashAlgorithms.join(', ') ],
        ]),
        h('p', 'note', 'As the verified head says it: the name and the description are part of the root the operator signs.'));
}


function headCard(report, actions) {
    const head = report.head;
    if (head === undefined)
        return null;
    const commit = head.version.commit;
    const epoch  = report.epochs.find(item => item.number === head.epoch);
    return h('div', 'card',
        h('h3', null, 'Head'),
        facts([
            [ 'Epoch', `${head.epoch} · ${epoch?.status ?? ''}` ],
            [ 'Revision', String(commit.revision) ],
            [ 'Commit', shortId(commit.id, 24) ],
            [ 'Identification hash', epoch?.profiles?.identificationHash ],
            [ 'Signature algorithms', epoch?.profiles?.signatureAlgorithms?.length ? epoch.profiles.signatureAlgorithms.join(', ') : 'any the implementation signs with' ],
            [ 'Last change', formatTime(get(head.version.network.content, 'lastChange')) ],
        ]),
        etagList(commit.eTags),
        h('div', 'card-actions', linkButton('Explore this version →', () => actions.showVersion(head.epoch, commit.revision))));
}


function countsCard(report) {
    const network = report.head?.version.network;
    if (network === undefined)
        return null;
    const counts = countEntities(network.content);
    const tile   = (value, label) => h('div', 'tile', h('div', 'tile-value', value.toLocaleString('en')), h('div', 'tile-label', label));
    return h('div', 'card',
        h('h3', null, 'Charging infrastructure at the head'),
        h('div', 'tiles',
            tile(counts.operators, 'charging station operators'),
            tile(counts.pools, 'charging pools'),
            tile(counts.stations, 'charging stations'),
            tile(counts.evses, 'EVSEs'),
            tile(counts.tariffs, 'charging tariffs'),
            tile(counts.templates, 'templates'),
            tile(counts.groups, 'groups'),
            tile(counts.parties, 'parties in all')));
}


function historyCard(report) {
    const commits     = report.verdict.commits;
    const checkpoints = report.verdict.checkpoints;
    const witnessed   = report.epochs.flatMap(epoch => epoch.steps).filter(step => step.type === 'checkpoint' && (step.signatureCheck?.witnessedBy?.length ?? 0) > 0).length;
    const statements  = report.epochs.flatMap(epoch => epoch.steps).reduce((sum, step) => sum + (step.priceStatements?.statements?.length ?? 0), 0);
    const notTaken    = report.epochs.reduce((sum, epoch) => sum + epoch.notTaken.length, 0) + report.looseCommits.length;
    return h('div', 'card',
        h('h3', null, 'History'),
        facts([
            [ 'Epochs', report.epochs.map(epoch => `${epoch.number} (${epoch.status ?? 'not started'})`).join(', ') || '—' ],
            [ 'Commits taken', String(commits) ],
            [ 'Checkpoints taken', `${checkpoints}${witnessed ? `, ${witnessed} of them witnessed` : ''}` ],
            [ 'Trusted witnesses', report.witnesses.length ? `${[ ...new Set(report.witnesses.map(item => item.witness)) ].join(', ')} — ${report.requiredWitnesses} required` : 'none configured' ],
            [ 'Price statements in checkpoints', statements ? String(statements) : undefined ],
            [ 'Not taken', notTaken ? plural(notTaken, 'document part') : undefined ],
            [ 'Checked as of', formatTime(report.at) ],
        ]));
}


function appCard(report, actions) {
    const rows = [
        [ 'Station proofs',            report.proofs ],
        [ 'Evidence of sessions',      report.evidence ],
        [ 'Proofs of commits',         report.commitProofs ],
        [ 'Proofs of price statements', report.priceStatementProofs ],
        [ 'Attestations',              report.attestations ],
        [ 'QI-Digital papers',         report.qiDigital ],
    ].filter(([ , list ]) => list.length > 0);
    if (rows.length === 0)
        return null;
    return h('div', 'card',
        h('h3', null, 'What an app checks'),
        facts(rows.map(([ label, list ]) => {
            const ok = list.filter(item => item.ok).length;
            return [ label, h('span', null, badge(`${ok} of ${list.length} verify`, ok === list.length ? 'ok' : 'error')) ];
        })),
        h('div', 'card-actions', linkButton('Proofs & prices →', () => actions.switchTab('proofs'))));
}


/** The history as one strip per epoch: a dot per commit, a diamond per checkpoint. */
function timeline(report, actions) {

    const strip = h('div', 'timeline');

    for (const epoch of report.epochs) {

        const row = h('div', 'timeline-row', h('div', 'timeline-label', `Epoch ${epoch.number}`, h('span', 'muted', epoch.profiles ? ` ${epoch.profiles.identificationHash}` : '')));
        const track = h('div', 'timeline-track');

        epoch.steps.forEach((step, index) => {
            const kind  = step.type === 'checkpoint' ? 'cp' : step.type === 'root' ? 'root' : 'commit';
            const state = step.ok === false || step.operatorCheck?.ok === false ? 'bad' : 'good';
            const mark  = h('button', `mark ${kind} ${state}`);
            mark.type   = 'button';
            mark.title  = step.type === 'checkpoint' ? `Checkpoint ${step.checkpoint.sequence}${step.checkpoint.isFinal ? ' (final)' : ''}`
                        : step.type === 'root'       ? `Start: revision ${step.revision} (${step.kind})`
                        :                              `Revision ${step.revision}: ${step.changeSet?.description ?? ''}`;
            mark.addEventListener('click', () => actions.showStep(epoch.number, index));
            track.append(mark);
        });

        for (const item of epoch.notTaken) {
            const mark = h('span', `mark ${item.type === 'checkpoint' ? 'cp' : 'commit'} ${item.refused ? 'bad' : 'skipped'}`);
            mark.title = `${item.refused ? 'Refused' : 'Not taken'}: ${item.reason}`;
            track.append(mark);
        }

        row.append(track);
        strip.append(row);

    }

    return strip;

}


export function renderOverview(container, state, actions) {

    const report = state.report;

    container.append(verdictBanner(report));

    const grid = h('div', 'cards');
    for (const card of [ networkCard(report), trustAnchorCard(report), headCard(report, actions), countsCard(report), historyCard(report), appCard(report, actions) ])
        if (card)
            grid.append(card);
    container.append(grid);

    if (report.epochs.length > 0)
        container.append(section('Timeline', h('p', 'note', 'Each dot is a commit, each diamond a checkpoint; red where something does not verify, grey where the documents give it but the history could not take it. Click to see it in the history.'), timeline(report, actions)));

    if (report.issues.length > 0) {
        const list = h('ul', 'issues');
        for (const issue of report.issues)
            list.append(h('li', issue.level, badge(issue.level, issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warn' : 'info'), ' ', issue.text,
                          issue.ref ? h('span', null, ' ', linkButton(issue.ref.name, () => actions.showDocument(issue.ref))) : null));
        container.append(section(`Findings (${report.issues.length})`, list));
    }
    else if (report.head !== undefined)
        container.append(section('Findings', emptyState('Nothing to report: every signature, ETag, tree and chain checked holds.')));

}
