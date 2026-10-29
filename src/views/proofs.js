/*
 * What an app checks: the proof of a charging station and the price statements of its EVSEs before charging (8.4 to 8.6,
 * 12.4), the evidence of a session months later (12.4, 10.4), proofs of commits and price statements in checkpoints,
 * attestations of the head, and the archive of compacted commits.
 */

import { CHILD_ARRAYS, etagToText, get, isArray, isObject } from '@open-charging-cloud/wwcp-poi';

import { badge, button, facts, formatBytes, formatTime, h, i18n, jsonText, jsonView, plural, section, shortId } from '../dom.js';
import { emptyState, linkButton } from './common.js';
import { priceSummary } from './history.js';
import { qiDigitalCard } from './qidigital.js';


/** The forms of the child arrays of a proof (8.4): complete, pruned, or partial with audit paths. */
function proofStructure(roamingNetwork) {

    const list   = h('ul', 'proof-structure');
    let hashes   = 0;
    let complete = 0;

    const walk = (entity, kind, target, depth) => {

        for (const [ array, childKind ] of Object.entries(CHILD_ARRAYS[kind] ?? {})) {

            const value = get(entity, array);

            if (value === undefined)
                continue;

            const item = h('li', null);

            if (isArray(value)) {
                complete += value.length;
                item.append(h('code', null, array), ' ', badge(`complete: ${value.length}`, 'ok'), ' ', h('span', 'muted', value.map(child => String(child['@id'])).join(', ')));
                const nested = h('ul');
                for (const child of value)
                    if (isObject(child))
                        walk(child, childKind, nested, depth + 1);
                if (nested.childElementCount)
                    item.append(nested);
            }
            else if (isObject(value) && '@leaves' in value) {
                const leaves = isArray(value['@leaves']) ? value['@leaves'] : [];
                const paths  = leaves.reduce((sum, leaf) => sum + (isArray(leaf['@auditPath']) ? leaf['@auditPath'].length : 0), 0);
                hashes += paths;
                item.append(h('code', null, array), ' ', badge(`partial: ${leaves.length} of ${value['@size']}`, 'info'), ' ',
                            h('span', 'muted', leaves.map(leaf => `${String(leaf['@entity']?.['@id'])} at ${leaf['@index']} (${(leaf['@auditPath'] ?? []).length} hashes)`).join(', ')));
                const nested = h('ul');
                for (const leaf of leaves)
                    if (isObject(leaf['@entity']))
                        walk(leaf['@entity'], childKind, nested, depth + 1);
                if (nested.childElementCount)
                    item.append(nested);
            }
            else if (isObject(value) && '@merkleRoot' in value) {
                hashes++;
                item.append(h('code', null, array), ' ', badge(`pruned: ${value['@size']}`, 'warn'), ' ', h('span', 'muted', 'only its root'));
            }

            target.append(item);

        }

    };

    walk(roamingNetwork, 'roamingNetwork', list, 0);

    return { list, hashes, complete };

}


function evseTable(station, prices) {

    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'EVSE'), h('th', null, 'Power'), h('th', null, 'Connectors'), h('th', null, 'Energy meter'), h('th', null, 'Tariffs'), h('th', null, 'Price now'))));
    const body = h('tbody');

    for (const evse of station.evses) {
        const id      = String(evse['@id']);
        const meter   = isObject(evse['energyMeter']) ? evse['energyMeter'] : undefined;
        const keys    = isArray(meter?.['publicKeys']) ? meter['publicKeys'] : [];
        const tariffs = station.tariffs.get(id) ?? [];
        const price   = prices?.get(`EVSE:${id}`);
        body.append(h('tr', null,
            h('td', null, h('code', null, id), isArray(evse['currentTypes']) ? h('div', 'muted small', evse['currentTypes'].join(', ')) : null),
            h('td', 'nowrap', evse['maxPower'] !== undefined ? `${(Number(jsonText(evse['maxPower'])) / 1000).toLocaleString('en')} kW` : '—'),
            h('td', null, isArray(evse['chargingConnectors']) ? evse['chargingConnectors'].map(connector => `${connector['type'] ?? '?'}${connector['format'] ? ' ' + String(connector['format']).toLowerCase() : ''}`).join(', ') : '—'),
            h('td', null, meter ? h('span', null, h('code', null, String(meter['@id'])), meter['serialNumber'] ? h('div', 'muted small', `serial ${meter['serialNumber']}`) : null,
                                    keys.length ? h('div', 'muted small', `${plural(keys.length, 'public key')}: `, ...keys.map(key => shortId(String(key['@id']), 8))) : null) : '—'),
            h('td', null, tariffs.length ? h('div', 'stack', ...tariffs.map(tariff => h('span', null, h('code', null, String(tariff['@id'])), i18n(tariff['name']) ? ` · ${i18n(tariff['name'])}` : ''))) : '—'),
            h('td', null, price ? h('span', null, priceSummary(price.statement), h('div', 'muted small', `statement ${price.statement.sequence}, ${formatTime(price.statement.validFrom)} – ${price.statement.validUntil ? formatTime(price.statement.validUntil) : 'next'}`)) : h('span', 'muted', '—')),
        ));
    }

    table.append(body);
    return table;

}


const namedByText = (namedBy) => `${namedBy.entityType === 'ChargingStation' ? 'station' : 'meter'} ${namedBy.entityId}`;

/** The model and versions a certificate is for: `GD-DC300 of GraphDefined, hardware 1.0, firmware 2.5.0`. */
function certificateSubject(certificate) {
    const model        = certificate['chargingStationModel'] ?? certificate['energyMeterModel'];
    const manufacturer = certificate['chargingStationManufacturerId'] ?? certificate['energyMeterManufacturerId'];
    const versions     = (name, values) => isArray(values) && values.length ? `${name} ${values.map(jsonText).join(', ')}` : null;
    return [ `${model ?? '?'} of ${manufacturer ?? '?'}`, versions('hardware', certificate['hardwareRevisions']), versions('firmware', certificate['firmwareVersions']) ].filter(Boolean).join(', ');
}

/** The certificates the station and its meters name (`certificateIds`), as the proof gives them (A13). */
function certificateTable(station) {
    if (station.certificates.length === 0)
        return null;
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Named by'), h('th', null, 'Certificate'), h('th', null, 'For'), h('th', null, 'Issued by'), h('th', null, 'Valid'), h('th', null, 'For this model'))));
    const body = h('tbody');
    for (const item of station.certificates) {
        const certificate = item.certificate;
        const meters      = isArray(certificate['energyMeters']) ? certificate['energyMeters'] : [];
        body.append(h('tr', null,
            h('td', null, namedByText(item.namedBy)),
            h('td', null, h('code', null, String(certificate['@id'])), certificate['legislation'] ? h('div', 'muted small', String(certificate['legislation'])) : null,
                          typeof certificate['documentURL'] === 'string' ? h('div', 'small', h('a', null, 'document')) : null),
            h('td', null, certificateSubject(certificate),
                          meters.length ? h('div', 'muted small', `issued with ${meters.map(meter => `${meter['modelId']} of ${meter['manufacturerId']}`).join(', ')}`) : null,
                          isArray(certificate['verifiedTransparencySoftwareIds']) && certificate['verifiedTransparencySoftwareIds'].length
                              ? h('div', 'muted small', `verifies ${certificate['verifiedTransparencySoftwareIds'].join(', ')}`) : null),
            h('td', null, String(item.body['@id']), item.statedBy === 'RoamingNetworkOperator' ? h('div', 'muted small', 'stated by the roaming network operator in its place') : null),
            h('td', 'small', `${formatTime(certificate['notBefore'])} – ${formatTime(certificate['notAfter'])}`),
            h('td', null, item.forThisModel ? badge('yes', 'ok', 'For the model, the hardware revision and the firmware version of what names it') : badge('no', 'warn', 'Not for the model, hardware revision or firmware version of what names it'))));
        const link = body.lastElementChild.querySelector('a');
        if (link) {
            link.href = String(certificate['documentURL']);
            link.rel  = 'noopener';
        }
    }
    table.append(body);
    return table;
}

/** Who checks the measurements: the releases the station and its meters name, with the certificates proving them (A13). */
function softwareTable(station) {
    if (station.transparencySoftware.length === 0)
        return null;
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Named by'), h('th', null, 'Legal status'), h('th', null, 'Release'), h('th', null, 'Manufacturer'), h('th', null, 'Proven by'))));
    const body = h('tbody');
    for (const item of station.transparencySoftware)
        body.append(h('tr', null,
            h('td', null, namedByText(item.namedBy)),
            h('td', null, item.legalStatus ?? '—'),
            h('td', null, `${i18n(item.release['name']) ?? String(item.release['@id'])} ${jsonText(item.release['version'])}`,
                          item.release['supportUntil'] ? h('div', 'muted small', `supported until ${formatTime(item.release['supportUntil'])}`) : null),
            h('td', null, `${String(item.manufacturer['@id'])}${item.manufacturer['craRole'] ? ` (${item.manufacturer['craRole']})` : ''}`),
            h('td', null, item.certificates.length
                              ? h('div', 'stack', ...item.certificates.map(named => h('span', null, h('code', null, String(named.certificate['@id'])), ' ', named.forThisModel ? badge('for this model', 'ok') : badge('other model', 'warn'))))
                              : h('span', 'muted', 'no certificate names it'))));
    table.append(body);
    return table;
}

/** The hardware revision, firmware version and serial number of the station and its meters, as the proof gives them. */
function versionsOf(station) {
    const rows = [ { what: `station ${String(station.chargingStation['@id'])}`, json: station.chargingStation },
                   ...station.energyMeters.map(meter => ({ what: `meter ${String(meter['@id'])}`, json: meter })) ];
    if (!rows.some(row => row.json['hardwareRevision'] !== undefined || row.json['firmwareVersion'] !== undefined || row.json['serialNumber'] !== undefined))
        return null;
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Device'), h('th', null, 'Model'), h('th', null, 'Hardware'), h('th', null, 'Firmware'), h('th', null, 'Serial number'))));
    const body = h('tbody');
    for (const { what, json } of rows)
        body.append(h('tr', null, h('td', null, what), h('td', null, json['modelId'] ? `${json['modelId']} of ${json['manufacturerId'] ?? '?'}` : '—'),
                              h('td', null, jsonText(json['hardwareRevision'])), h('td', null, jsonText(json['firmwareVersion'])), h('td', null, jsonText(json['serialNumber']))));
    table.append(body);
    return table;
}


function proofCard(report, result, actions) {

    const station  = result.station;
    const json     = result.document.json;
    const version  = station ? [ ...report.versions.values() ].find(item => item.commit.id === station.commitId) : undefined;
    const structure = isObject(get(json, 'roamingNetwork')) ? proofStructure(get(json, 'roamingNetwork')) : undefined;

    const basis = result.basis === 'pinned'   ? 'against the trust anchor'
                : result.basis === 'followed' ? 'against the identity keys the history followed — the trust anchor names older ones'
                : result.basis === 'tofu'     ? 'against the keys the head states itself (no trust anchor)'
                :                               '';

    return h('div', `card proof-card ${result.ok ? '' : 'error-card'}`,
        h('div', 'card-title-row',
            h('h3', null, station ? `Charging station ${String(station.chargingStation['@id'])}` : result.document.name),
            result.ok ? badge('verified', 'ok') : badge('refused', 'error')),
        result.ok ? h('p', 'note', `Verified ${basis}, as of ${formatTime(report.at)}.`) : h('p', 'error-text', result.error),
        result.pinnedError ? h('p', 'note', `With the trust anchor as pinned: ${result.pinnedError}`) : null,

        station ? facts([
            [ 'Roaming network', `${station.roamingNetwork.name ?? ''} (${station.roamingNetwork.id})` ],
            [ 'Operator', `${String(station.operator['@id'])}${i18n(station.operator['name']) ? ' · ' + i18n(station.operator['name']) : ''}` ],
            [ 'Charging pool', `${String(station.chargingPool['@id'])}${i18n(station.chargingPool['name']) ? ' · ' + i18n(station.chargingPool['name']) : ''}` ],
            [ 'Manufacturer', station.manufacturer ? `${String(station.manufacturer.manufacturer['@id'])}${station.manufacturer.model ? ', model ' + String(station.manufacturer.model['@id']) : ''}` : undefined ],
            [ 'Version', h('span', null, `revision ${station.revision}, commit `, shortId(station.commitId, 12), version ? h('span', null, ' ', linkButton(`epoch ${version.epoch}`, () => actions.showEntity(version.epoch, version.revision, { type: 'ChargingStation', id: String(station.chargingStation['@id']) }))) : null) ],
            [ 'Root', h('code', 'small', etagToText(station.eTag)) ],
            [ 'Attested by', station.attestedBy.join(', ') ],
            [ 'Document', h('span', null, linkButton(result.document.name, () => actions.showDocument(result.document)), ` (${formatBytes(result.document.size)})`) ],
        ]) : null,

        station?.warnings.length ? h('ul', 'warnings', ...station.warnings.map(warning => h('li', null, badge('warning', 'warn'), ' ', warning))) : null,

        station ? h('h4', null, 'EVSEs, as they are at runtime') : null,
        station ? evseTable(station, result.prices) : null,

        station && versionsOf(station) ? h('h4', null, 'Devices: models, versions, serial numbers') : null,
        station ? versionsOf(station) : null,

        station && certificateTable(station) ? h('h4', null, 'Certificates the station and its meters name') : null,
        station ? certificateTable(station) : null,

        station && softwareTable(station) ? h('h4', null, 'Who checks the measurements: transparency software') : null,
        station ? softwareTable(station) : null,
        station && (station.certificates.length || station.transparencySoftware.length)
            ? h('p', 'note', 'A certificate is for a model, in the hardware revisions and firmware versions it covers; "for this model" tells whether it covers what names it. POI proves who states them, not that they are true.') : null,

        result.statements?.length ? h('div', null,
            h('h4', null, 'Price statements of the station, its pool and its EVSEs'),
            h('ul', 'statements', ...result.statements.map(item => h('li', null,
                item.ok ? badge('valid', 'ok') : badge('does not count', 'warn', 'Not signed by a signing key of the operator as this proof gives it'), ' ',
                h('code', null, `${item.statement.entityId} #${item.statement.sequence}`), ' ', h('span', 'muted', `signed ${formatTime(item.statement.signedAt)} by ${item.statement.signer}`),
                item.ok ? null : h('div', 'check-detail', item.error)))),
            result.pricesError ? h('p', 'error-text', result.pricesError) : null,
            h('p', 'note', 'Each is checked against the signing keys of the operator that the proof gives, and its prices against the tariffs of its EVSE (12.4). A statement signed by a key the operator replaced since does not count.')) : null,

        structure ? h('details', 'raw', h('summary', null, `How the proof is pruned: ${structure.complete} entities complete, ${structure.hashes} hashes for everything else`),
            structure.list,
            h('p', 'note', 'Complete arrays are hashed by the verifier, pruned ones are taken as their root, partial ones give some children with their audit paths (8.4). The verifier calculates the root bottom-up and compares it with the attestations.')) : null,

        h('details', 'raw', h('summary', null, 'The proof as JSON'), jsonView(json, { open: 1 })),
    );

}


function evidenceCard(report, result, actions) {

    const verified = result.verified;
    const evidence = result.evidence;

    return h('div', `card ${result.ok ? '' : 'error-card'}`,
        h('div', 'card-title-row', h('h3', null, `Evidence of a session at ${evidence?.evseId ?? '?'}`), result.ok ? badge('verified', 'ok') : badge('refused', 'error')),
        result.ok ? null : h('p', 'error-text', result.error),
        evidence ? facts([
            [ 'Charging began', formatTime(evidence.chargingStarted) ],
            [ 'Trust anchor kept', result.sameAnchor === true ? badge('the one given here', 'ok') : result.sameAnchor === false ? badge('another one than given here', 'warn') : 'as kept by the app' ],
            [ 'Station', verified ? `${String(verified.station.chargingStation['@id'])}, revision ${verified.station.revision}, attested by ${verified.station.attestedBy.join(', ')}` : undefined ],
            [ 'Price as charging began', verified ? h('div', null, ...[ ...verified.prices.values() ].map(price => priceSummary(price.statement))) : undefined ],
            [ 'Checkpoints', verified ? verified.checkpoints.map(item => `${item.checkpoint.sequence} (operator: ${item.signatures.signedBy.join(', ')}; witnesses: ${item.signatures.witnessedBy.join(', ') || 'none'})`).join('; ') : undefined ],
            [ 'Version witnessed', verified?.versionCheckpoint ? `its commit is part of checkpoint ${verified.versionCheckpoint.sequence}` : undefined ],
            [ 'Statements witnessed', verified ? [ ...verified.statementCheckpoints.values() ].map(item => `made after checkpoint ${item.after?.sequence ?? '—'}, named by checkpoint ${item.namedBy.sequence}`).join('; ') : undefined ],
            [ 'Document', linkButton(result.document.name, () => actions.showDocument(result.document)) ],
        ]) : null,
        h('p', 'note', 'Months later, e.g. disputing an invoice: the station proof attested as charging began, the price statement valid then, the commit of the proof and the statement each proven to be part of checkpoints the trusted witnesses signed (12.4). The attestations have long expired; the checkpoints carry it.'));

}


function commitProofTable(report, actions) {
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Commit'), h('th', null, 'Checkpoint'), h('th', 'num', 'Index'), h('th', 'num', 'Size'), h('th', 'num', 'Audit path'), h('th', null, 'Verdict'))));
    const body = h('tbody');
    for (const result of report.commitProofs) {
        const proof = result.proof;
        body.append(h('tr', null,
            h('td', null, proof ? h('span', null, `revision ${jsonText(proof.leaf?.['revision'] ?? get(result.document.json, 'leaf')?.['revision'])} `, shortId(String(get(result.document.json, 'leaf')?.['commitId']), 10)) : result.document.name),
            h('td', null, result.checkpointStep ? `${result.checkpointStep.checkpoint.sequence} of epoch ${result.checkpointStep.checkpoint.epoch}` : shortId(String(get(result.document.json, 'checkpointId')), 10)),
            h('td', 'num', jsonText(get(result.document.json, '@index'))),
            h('td', 'num', jsonText(get(result.document.json, '@size'))),
            h('td', 'num', String((get(result.document.json, '@auditPath') ?? []).length)),
            h('td', null, result.ok ? badge('in the checkpoint', 'ok') : badge('refused', 'error', result.error), result.ok ? null : h('div', 'check-detail', result.error))));
    }
    table.append(body);
    return h('div', null, table, h('p', 'note', 'The leaf binds the commit with its ETags; its audit path leads to the commits root of the checkpoint, which the operator and the witnesses signed (10.4).'));
}

function statementProofTable(report) {
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Statement'), h('th', null, 'Checkpoint'), h('th', 'num', 'Index'), h('th', 'num', 'Size'), h('th', null, 'Verdict'))));
    const body = h('tbody');
    for (const result of report.priceStatementProofs) {
        const statement = get(result.document.json, 'priceStatement');
        body.append(h('tr', null,
            h('td', null, h('code', null, `${statement?.['entityId']} #${statement?.['sequence']}`)),
            h('td', null, result.checkpointStep ? `${result.checkpointStep.checkpoint.sequence} of epoch ${result.checkpointStep.checkpoint.epoch}` : shortId(String(get(result.document.json, 'checkpointId')), 10)),
            h('td', 'num', jsonText(get(result.document.json, '@index'))),
            h('td', 'num', jsonText(get(result.document.json, '@size'))),
            h('td', null, result.ok ? badge('named by the checkpoint', 'ok') : badge('refused', 'error', result.error), result.ok ? null : h('div', 'check-detail', result.error))));
    }
    table.append(body);
    return h('div', null, table, h('p', 'note', 'Proves that the statement was made before the checkpoint naming it (12.3).'));
}

function attestationTable(report) {
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Holder'), h('th', null, 'Signed'), h('th', null, 'Valid until'), h('th', null, 'At the time checked'), h('th', null, 'Verdict'))));
    const body = h('tbody');
    for (const result of report.attestations) {
        const attestation = result.attestation;
        body.append(h('tr', null,
            h('td', null, result.version ? `epoch ${result.version.epoch}, revision ${result.version.revision}` : attestation ? `revision ${attestation.revision}` : '?'),
            h('td', null, result.holder ?? attestation?.signer ?? '—'),
            h('td', 'small', attestation ? formatTime(attestation.signedAt) : '—'),
            h('td', 'small', attestation?.validUntil ? formatTime(attestation.validUntil) : '—'),
            h('td', null, result.validNow === true ? badge('valid', 'ok') : result.validNow === false ? badge('expired', 'warn') : '—'),
            h('td', null, result.ok ? badge('signature valid, root matches', 'ok') : badge('refused', 'error', result.error), result.ok ? null : h('div', 'check-detail', result.error))));
    }
    table.append(body);
    return h('div', null, table, h('p', 'note', 'An attestation states that a version is the one its signer has, at a point in time, by the root of its effective tree; it is fresh for minutes (8.5). A proof embeds those it was made for.'));
}

function archiveTable(report) {
    const archive = report.archive;
    const table = h('table', 'grid');
    table.append(h('thead', null, h('tr', null, h('th', 'num', 'Segment'), h('th', null, 'Revisions'), h('th', 'num', 'Commits'), h('th', null, 'Archived'), h('th', null, 'Commits held by the history'))));
    const body = h('tbody');
    for (const segment of archive.segments)
        body.append(h('tr', null,
            h('td', 'num', segment.info.number),
            h('td', null, `${segment.info.fromRevision} – ${segment.info.toRevision}`),
            h('td', 'num', segment.info.size),
            h('td', 'small', formatTime(segment.info.archivedAt)),
            h('td', null, segment.ok ? badge('all of them', 'ok') : badge(`${segment.missing.length} missing`, 'warn'))));
    table.append(body);
    return h('div', null,
        archive.error ? h('p', 'error-text', archive.error) : archive.lineOk ? h('p', null, badge('the segments follow each other', 'ok')) : null,
        table,
        h('p', 'note', 'A history drops old commits only before the commit of a checkpoint and archives them, one segment per compaction, never changed once written: a checkpoint proves only what someone can still show (10.6).'));
}


function lookupForm(report, actions, demo) {
    const anchor = report.anchor.kind === 'pinned' ? report.anchor.anchor : undefined;
    // The servers of a recorded demo are not online: its proofs are the ones it recorded.
    if (anchor === undefined || demo !== undefined || anchor.urls.every(url => url.includes('unknown.invalid')))
        return null;
    const input = h('input', 'filter');
    input.type = 'text';
    input.placeholder = 'EVSE or charging station ids, e.g. DE*GEF*E1*1';
    const go = button('Fetch proofs and prices from the servers', () => {
        const ids = input.value.split(/[\s,;]+/).filter(Boolean);
        if (ids.length)
            actions.lookupStations(ids);
    }, 'primary small');
    return section('Ask the servers, as an app does',
        h('p', 'note', `GET …/EVSEs/{EVSE_Id}/proof and …/priceStatements, or …/CSs/{CS_Id}/…, from ${anchor.urls[0]}, checked against the trust anchor.`),
        h('div', 'toolbar', input, go));
}


export function renderProofs(container, state, actions) {

    const report = state.report;

    const lookup = lookupForm(report, actions, state.manifest);
    if (lookup)
        container.append(lookup);

    if (report.proofs.length > 0) {
        const cards = h('div', 'proof-cards');
        for (const result of report.proofs)
            cards.append(proofCard(report, result, actions));
        container.append(section(`Charging station proofs (${report.proofs.length})`,
            h('p', 'note', 'What a driver\'s app gets for the station it selected: one small document, checked offline — the trust anchor, the key statement, the attestations of the root, the root calculated from the pruned tree (8.4 to 8.6).'),
            cards));
    }

    if (report.evidence.length > 0)
        container.append(section(`Evidence of charging sessions (${report.evidence.length})`, ...report.evidence.map(result => evidenceCard(report, result, actions))));

    if (report.commitProofs.length > 0)
        container.append(section(`Proofs of commits in checkpoints (${report.commitProofs.length})`, commitProofTable(report, actions)));

    if (report.priceStatementProofs.length > 0)
        container.append(section(`Proofs of price statements in checkpoints (${report.priceStatementProofs.length})`, statementProofTable(report)));

    if (report.attestations.length > 0)
        container.append(section(`Attestations (${report.attestations.length})`, attestationTable(report)));

    if (report.qiDigital.length > 0) {
        const cards = h('div', 'proof-cards');
        for (const result of report.qiDigital)
            cards.append(qiDigitalCard(result, actions));
        container.append(section(`QI-Digital: the papers of what charges (${report.qiDigital.length})`,
            h('p', 'note', 'A proof of concept of WWCP_POI (example A14): calibration certificates, certificates of conformity and declarations of conformity, each signed by its issuer — a calibration laboratory, a notified body, a manufacturer — with a key the roaming network names for it, and checked against the network as it is: the issuer a party of it, the model and versions those of the network, the calibrated meter the one at runtime, with the serial number the network gives it.'),
            cards));
    }

    if (report.archive)
        container.append(section('Archive', archiveTable(report)));

    if (container.childElementCount === 0 || (container.childElementCount === 1 && lookup))
        container.append(section('Proofs & prices', emptyState('No proofs, price statements, attestations or evidence were loaded.',
            'Drop a station proof (GET …/CSs/{id}/proof), its price statements, or the evidence an app kept — or give EVSE ids when loading from the servers.')));

}
