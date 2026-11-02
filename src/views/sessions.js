/*
 * Charging sessions, as an app checks them (WWCP_POI.TS 0.2.0): for each session as Chargy writes it, whose trust it is
 * checked with, the meter of its EVSE and the key it signs with - as the network states them now, and as it stated them
 * when the meter measured -, the prices bound to the session at its start, and the receipts of their publication. What is
 * not proven is said as such: a session proves no more than its evidence does.
 */

import { badge, button, facts, formatTime, h, jsonView, plural, section, shortId } from '../dom.js';
import { emptyState } from './common.js';


/** A badge for a status WWCP_POI.TS gives, from what it means: holds, does not hold, or not proven. */
function statusBadge(status, title) {
    const level = [ 'valid', 'bound', 'counted', 'current-snapshot', 'historical-attestation', 'rno-checkpoint', 'witnessed-checkpoint', 'witnessed-before-signed-start' ].includes(status) ? 'ok'
                : [ 'invalid', 'ambiguous' ].includes(status) ? 'error'
                : 'warn';
    return badge(status, level, title);
}


/** Whose trust a session is checked with, and how the key statement of its operator fared against the keys trusted. */
function trustFacts(result, actions) {

    const evaluation = result.evaluation;

    return facts([
        [ 'Trust anchor', result.authority === 'pinned' ? h('span', null, badge('the one of the settings', 'ok'), ' ', h('span', 'muted small', 'the one the session brings is the same'))
                        : result.authority === 'other'  ? h('span', null, badge('another one', 'warn'), ' ', button('Use its trust anchor', () => actions.useTrustAnchor(String(result.offeredAnchor))))
                        : result.authority === 'none'   ? h('span', null, badge('none in the settings', 'warn'), ' ', button('Use its trust anchor', () => actions.useTrustAnchor(String(result.offeredAnchor))))
                        : result.authority === 'invalid' ? badge('can not be read', 'error') : undefined ],
        [ 'Key statement', evaluation ? h('span', null,
              statusBadge(evaluation.signatures, 'Every signature of the key statement verifies'), ' signatures ',
              statusBadge(evaluation.signers, 'Its signers are holders the trust anchor names, with keys valid when they signed'), ' signers ',
              statusBadge(evaluation.quorum, 'Trusted keys of as many holders as the larger quorum signed it'), ' quorum ',
              statusBadge(evaluation.validity, 'It is valid at the time checked'), ' validity',
              h('div', 'muted small', `${plural(evaluation.trustedHolderCount, 'holder')} trusted, ${evaluation.requiredConsensus} required, ${plural(evaluation.signatureCount, 'signature')}`)) : undefined ],
    ]);

}

/** The meter and its key, as the proof of the station states them now. */
function meterKeyPart(meterKey) {

    if (meterKey.error)
        return h('div', null, h('h4', null, 'Its meter now'), h('p', 'error-text', meterKey.error));

    const { binding, sessionKey } = meterKey;
    const evidence = binding.evidence;

    return h('div', null,
        h('h4', null, 'Its meter now ', statusBadge(evidence.association)),
        facts([
            [ 'Meter', h('span', null, h('code', null, binding.meterId), ` · serial ${binding.meterSerialNumber}, of the charging station `, h('code', null, binding.chargingStationId)) ],
            [ 'Its key', keyLine(binding.key, sessionKey) ],
            [ 'As of', h('span', null, `revision ${evidence.revision}, commit `, shortId(evidence.commitId, 12), `, valid until ${formatTime(evidence.validUntil)}`) ],
        ]),
        h('p', 'note', 'The meter of the EVSE and its key as the attested version states them now, the serial number exactly the one the session names: an observation of the current version, valid no longer than the attestations and the certified keys counted. No claim of the time it measured (WWCP_POI.TS, verifyMeterKey).'));

}

/** A measurement key, by its identification, and whether it is the key of the session. */
function keyLine(key, sessionKey) {
    return h('span', null,
        shortId(key.id, 16), h('span', 'muted small', ` ${key.idScheme}, ${key.algorithm} `),
        sessionKey === true  ? badge('the key of the session', 'ok', 'The SHA-256 of the SubjectPublicKeyInfo the session gives is its identification') :
        sessionKey === false ? badge('not the key of the session', 'error') : null);
}

/** The meter and its key as the network stated them when the meter measured, and the checkpoints naming those versions. */
function historicalPart(historical) {

    if (historical.error)
        return h('div', null, h('h4', null, 'Its meter when it measured'), h('p', 'error-text', historical.error));

    const { verification, sessionKey } = historical;

    return h('div', null,
        h('h4', null, 'Its meter when it measured ', statusBadge(verification.bindings[0]?.evidence.association ?? 'missing')),
        h('table', 'grid', h('thead', null, h('tr', null, h('th', null, 'Measured'), h('th', null, 'Meter and key'), h('th', null, 'Version'), h('th', null, 'Attested until'))),
            h('tbody', null, ...verification.bindings.map(binding => h('tr', null,
                h('td', null, ...binding.evidence.measurementTimes.map(time => h('div', null, formatTime(time)))),
                h('td', null, h('code', null, binding.meterId), h('div', null, keyLine(binding.key, sessionKey ? true : undefined))),
                h('td', null, `revision ${binding.evidence.revision}, `, shortId(binding.evidence.commitId, 12)),
                h('td', null, formatTime(binding.evidence.attestationValidUntil)))))),
        h('div', null, ...verification.versions.map(version => h('div', null, 'Published: ', statusBadge(version.publication),
            version.checkpointId ? h('span', null, ' in the checkpoint ', shortId(version.checkpointId, 12)) : null,
            version.witnessedBy.length ? h('span', 'muted small', ` witnessed by ${version.witnessedBy.join(', ')}`) : null))),
        facts([
            [ 'Independent time', statusBadge(verification.independentTime, 'The times are those the meter signed, not established otherwise') ],
            [ 'The latest version', statusBadge(verification.latestVersion, 'That no later version changed the meter is not shown') ],
        ]),
        h('p', 'note', 'The operator attested the meter and its key at the times the meter signed, each checked with the key statement and certificates of that time, though they expired since; a checkpoint names the version, signed by the operator or by witnesses trusted here. A checkpoint obtained later does not prove that it was public before the session (WWCP_POI.TS, verifyHistoricalMeterEvidence).'));

}

/** The prices bound to the session at its start, and the receipts of their publication. */
function pricesPart(prices) {

    if (prices.error)
        return h('div', null, h('h4', null, 'Its prices'), h('p', 'error-text', prices.error));

    const result   = prices.verification;
    const selected = result.selected;
    const rates    = selected?.rates;
    const witnesses = result.publicationWitnesses;

    return h('div', null,
        h('h4', null, 'Its prices ', statusBadge(result.applicability)),
        facts([
            [ 'Price statements', statusBadge(result.signatures, 'Signed by the operator with a key that may sign price statements, valid then') ],
            [ 'Agreement', h('span', null, statusBadge(result.agreement, 'The operator bound the selected price statement to the document of the start of this session, its meter and EVSE'), ' ', h('span', 'muted small', 'with the start of the session')) ],
            [ 'Price', selected ? h('span', null, h('code', null, String(selected.tariff['@id'] ?? '')), rates
                  ? ` · ${[ rates.energyPerKWh ? `${rates.energyPerKWh} ${rates.currency}/kWh` : null, rates.timePerHour ? `${rates.timePerHour} ${rates.currency}/h` : null, rates.flatFee ? `${rates.flatFee} ${rates.currency} per session` : null ].filter(Boolean).join(', ')}`
                  : ` · ${selected.currency}`,
                  h('div', 'muted small', `statement ${String(selected.statement['sequence'] ?? '')} of ${String(selected.statement['entityId'] ?? '')}, ${String(selected.statement['algorithm'] ?? '')}, signed by ${String(selected.statement['signer'] ?? '')}`)) : undefined ],
            [ 'Published in a checkpoint', h('span', null, statusBadge(result.publication), result.checkpointIds.length ? h('span', null, ' ', ...result.checkpointIds.map(id => shortId(id, 12))) : null,
                  result.witnessedBy.length ? h('span', 'muted small', ` witnessed by ${result.witnessedBy.join(', ')}`) : null) ],
            [ 'Published before the start', statusBadge(result.publicationBeforeStart, 'Receipts of independent witnesses, of organizations the policy of the settings authorizes, that retrieved this offer publicly before the signed start') ],
            [ 'Consent of the customer', statusBadge(result.customerConsent) ],
            [ 'The latest or only offer', statusBadge(result.latestOrSoleOffer) ],
            [ 'Gaps in the chain of statements', result.chainGaps ? badge('yes', 'warn') : undefined ],
        ]),
        witnesses?.receipts.length ? h('table', 'grid',
            h('thead', null, h('tr', null, h('th', null, 'Receipt of'), h('th', null, 'Organization'), h('th', null, 'Published by'), h('th', null, 'Counts'))),
            h('tbody', null, ...witnesses.receipts.map(receipt => h('tr', null,
                h('td', null, receipt.witnessId ? h('code', null, receipt.witnessId) : h('span', 'muted', '—')),
                h('td', null, receipt.organization ?? h('span', 'muted', '—')),
                h('td', null, receipt.latestPublicationAt !== undefined ? formatTime(receipt.latestPublicationAt) : '—', receipt.sourceURL ? h('div', 'muted small', receipt.sourceURL) : null),
                h('td', null, statusBadge(receipt.status), h('div', 'muted small', receipt.detail)))))) : null,
        witnesses ? h('p', 'muted small', `${plural(witnesses.organizations.length, 'organization')} of ${witnesses.requiredOrganizations} required counted; the start itself is ${witnesses.actualStartTime.replaceAll('-', ' ')}.`) : null,
        result.diagnostics.length ? h('ul', 'warnings', ...result.diagnostics.map(text => h('li', null, text))) : null,
        h('p', 'note', 'The operator signed the price statement and bound it to the start of this session: its assertion, not the consent of the customer. That the offer was public before the session started only receipts of witnesses can show, counted when their organizations, keys and clocks are authorized by the policy of the settings, once per organization; a receipt the session brings authorizes nobody (WWCP_POI.TS, verifySessionPriceEvidence).'));

}

function sessionCard(result, actions) {

    const readings = result.readings;
    const parts    = [ result.meterKey, result.historical, result.prices ].filter(Boolean);
    const status   = result.error !== undefined && result.authority !== 'pinned' ? badge('not checked', 'warn')
                   : result.error !== undefined || result.ok === false ? badge('refused', 'error')
                   : badge(parts.length ? 'verified' : 'nothing to check', parts.length ? 'ok' : 'info');

    const card = h('div', `card proof-card ${result.ok === false || (result.error && result.authority === 'pinned') ? 'error-card' : ''}`,
        h('div', 'card-title-row', h('h3', null, result.document.name), status),
        result.document.description ? h('p', 'muted', result.document.description) : null,
        facts([
            [ 'EVSE', h('code', null, result.evseId) ],
            [ 'Roaming network', result.roamingNetworkId ],
            [ 'Meter', readings ? `${readings.meterSerialNumber}${readings.meterManufacturer ? ` (${readings.meterManufacturer})` : ''}` : undefined ],
            [ 'Readings', readings ? h('div', null, ...readings.readings.map(item => h('div', null, `${item.value} ${item.unit ?? ''} at ${formatTime(item.time)}`, item.kind ? h('span', 'muted small', ` ${item.kind === 'B' ? 'begin' : item.kind === 'E' ? 'end' : item.kind}`) : null))) : undefined ],
            [ 'Its start', readings ? h('span', null, 'SHA-256 ', shortId(readings.startDocumentSHA256, 16)) : undefined ],
        ]),
        result.error ? h('p', result.authority === 'pinned' || result.authority === 'invalid' ? 'error-text' : 'note', result.error) : null,
        result.authority ? trustFacts(result, actions) : null,
        result.meterKey ? meterKeyPart(result.meterKey) : null,
        result.historical ? historicalPart(result.historical) : null,
        result.prices ? pricesPart(result.prices) : null,
        h('details', 'raw', h('summary', null, 'The session as JSON'), jsonView(result.document.json, { open: 1 })),
    );

    card.id = `session-${result.document.id}`;
    return card;

}

/** Every session at a glance: what holds for it, what does not, what is not proven. */
function summaryTable(sessions) {

    const cell = (part, status) => part === undefined ? h('td', 'muted', '—') : part.error ? h('td', null, badge('error', 'error', part.error)) : h('td', null, status(part));

    return h('table', 'grid',
        h('thead', null, h('tr', null, h('th', null, 'Session'), h('th', null, 'Its meter now'), h('th', null, 'When it measured'), h('th', null, 'Its prices'), h('th', null, 'Published before the start'))),
        h('tbody', null, ...sessions.map(result => {
            const row = h('tr', 'clickable',
                h('td', null, h('code', null, result.document.name), result.error ? h('div', 'muted small', result.error) : null),
                cell(result.meterKey, part => statusBadge(part.binding.evidence.association)),
                cell(result.historical, part => h('span', null, ...part.verification.versions.map(version => statusBadge(version.publication)))),
                cell(result.prices, part => statusBadge(part.verification.applicability)),
                cell(result.prices, part => statusBadge(part.verification.publicationBeforeStart)));
            row.addEventListener('click', () => document.getElementById(`session-${result.document.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            return row;
        })));

}


export function renderSessions(container, state, actions) {

    const sessions = state.report.sessions;

    if (sessions.length === 0) {
        container.append(section('Charging sessions', emptyState('No charging sessions were loaded.',
            'Drop a session as Chargy writes it (.chargy), with the evidence of WWCP POI for it — or start the demo "Charging sessions, as an app checks them".')));
        return;
    }

    container.append(section(`Charging sessions (${sessions.length})`,
        h('p', 'note', 'Each checked as an app checks it: with the trust anchor of the settings and the identity keys trusted there, never with the one the session brings; the witnesses of checkpoints and of price publications as the settings authorize them. The measurements, signed by the meter, are Chargy\'s to check; this checks what WWCP POI says of them.'),
        summaryTable(sessions)));

    const cards = h('div', 'proof-cards');
    for (const result of sessions)
        cards.append(sessionCard(result, actions));
    container.append(section('Each session', cards));

}
