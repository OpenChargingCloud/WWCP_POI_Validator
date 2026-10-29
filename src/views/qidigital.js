/*
 * QI-Digital (example A14 of WWCP_POI, a proof of concept): the papers of what charges - the digital calibration
 * certificate of an energy meter or a charging station, the digital certificates of conformity of a model or of the
 * quality system of a manufacturer, the digital declaration of conformity of a model - as WWCP_POI.TS read them and checked
 * them against the roaming network and against each other.
 */

import { badge, facts, formatTime, h, jsonText, jsonView, shortId } from '../dom.js';
import { checkList, linkButton } from './common.js';


/** The modules of conformity assessment of Decision 768/2008/EC a certificate may be issued under. */
const MODULES = {
    B:   'EU-type examination',
    D:   'conformity to type based on quality assurance of the production process',
    D1:  'quality assurance of the production process',
    E:   'conformity to type based on product quality assurance',
    E1:  'quality assurance of final product inspection and testing',
    F:   'conformity to type based on product verification',
    F1:  'conformity based on product verification',
    G:   'conformity based on unit verification',
    H:   'conformity based on full quality assurance',
    H1:  'conformity based on full quality assurance plus design examination',
};

const KINDS = {
    calibrationCertificate:   'Digital calibration certificate',
    certificateOfConformity:  'Digital certificate of conformity',
    declarationOfConformity:  'Digital declaration of conformity',
};

/** A unit of the D-SI, e.g. `\ampere`, as people write it. */
const UNITS = { ampere: 'A', volt: 'V', watt: 'W', kilowatt: 'kW', kilowatthour: 'kWh', percent: '%', degreecelsius: '°C', hertz: 'Hz', second: 's', ohm: 'Ω', one: '' };

const unitText = (unit) => {
    const name = String(unit ?? '').replace(/^\\/, '');
    return UNITS[name] ?? name;
};

const number = (value) => value === undefined ? undefined : jsonText(value);

/** A text of QI-Digital, its `[ language, text ]` pairs as WWCP_POI reads them: the English one, else the first. */
const qiText = (text) => text === undefined ? undefined : (text.find(([ language ]) => language === 'en') ?? text[0])?.[1];

/** A quantity: `0.42 % (U = 0.08, k = 2), tolerance −1.5 … 1.5` and its conformity. */
function quantityText(quantity) {
    const unit   = unitText(quantity.unit);
    const parts  = [ `${number(quantity.value)}${unit ? ' ' + unit : ''}` ];
    if (quantity.expandedUncertainty !== undefined)
        parts.push(`U = ${number(quantity.expandedUncertainty)}${quantity.coverageFactor !== undefined ? `, k = ${number(quantity.coverageFactor)}` : ''}`);
    if (quantity.toleranceLower !== undefined || quantity.toleranceUpper !== undefined)
        parts.push(`tolerance ${number(quantity.toleranceLower) ?? '…'} to ${number(quantity.toleranceUpper) ?? '…'}`);
    return parts.join(', ');
}

const conformityBadge = (conformity) => conformity === undefined ? null
    : badge(conformity, conformity === 'Pass' ? 'ok' : conformity === 'Fail' || conformity === 'NoPass' ? 'error' : 'warn');

const refTypeText = (refType) => refType ? String(refType).replace(/^(basic|mid)_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : undefined;


function signatureFacts(doc, result) {
    const signature = doc.signature;
    return [
        [ 'Signed', signature ? h('span', null, `${formatTime(signature.signedAt)}, ${signature.algorithm}, key `, shortId(signature.keyId, 12)) : 'not signed' ],
        [ 'Digest', shortId(doc.digest, 24) ],
        [ 'Checked against', result.checkedAgainst ? `the head, revision ${result.checkedAgainst.revision} of epoch ${result.checkedAgainst.epoch}` : undefined ],
    ];
}

function calibrationBody(doc, result, actions) {

    const item = doc.item;
    const resultsTable = h('table', 'grid');
    resultsTable.append(h('thead', null, h('tr', null, h('th', null, 'Measurement'), h('th', null, 'Point'), h('th', null, 'Quantities'), h('th', null, 'Conformity'))));
    const body = h('tbody');

    for (const measurement of doc.measurementResults)
        for (const point of measurement.results) {
            const measured = point.quantities.filter(quantity => quantity.conformity !== undefined);
            body.append(h('tr', null,
                h('td', null, qiText(measurement.name) ?? ''),
                h('td', null, qiText(point.name) ?? refTypeText(point.refType) ?? ''),
                h('td', null, h('div', 'stack', ...point.quantities.map(quantity => h('span', null, h('span', 'muted', `${refTypeText(quantity.refType) ?? qiText(quantity.name) ?? ''}: `), quantityText(quantity))))),
                h('td', null, ...measured.map(quantity => conformityBadge(quantity.conformity)))));
        }

    resultsTable.append(body);

    const conditions = doc.measurementResults.flatMap(measurement => measurement.influenceConditions);
    const methods    = doc.measurementResults.flatMap(measurement => measurement.usedMethods);

    return [
        facts([
            [ 'Laboratory', `${doc.calibrationLaboratoryId}${doc.calibrationLaboratoryCode ? ` (${doc.calibrationLaboratoryCode})` : ''}, ${doc.countryCode}` ],
            [ 'Item', h('span', null, item.text, result.holder ? h('span', null, ' — ', linkButton(`${result.holder.type === 'EVSE' ? 'the meter of the EVSE' : 'the charging station'} ${result.holder.id}`,
                                                                                               () => actions.showEntity(result.checkedAgainst.epoch, result.checkedAgainst.revision, { type: result.holder.type, id: result.holder.id, path: result.holder.path }))) : null) ],
            [ 'Model', item.modelId ? `${item.modelId} of ${item.manufacturerId ?? '?'}, hardware ${item.hardwareRevision ?? '?'}, firmware ${item.firmwareVersion ?? '?'}` : undefined ],
            [ 'Serial number', item.serialNumber ],
            [ 'Performed', `${formatTime(doc.beginPerformanceDate)} – ${formatTime(doc.endPerformanceDate)}, at the ${String(doc.performanceLocation).toLowerCase()}` ],
            [ 'Customer', doc.customer ? `${doc.customer}${doc.orderNumber ? `, order ${doc.orderNumber}` : ''}` : undefined ],
            [ 'Responsible', doc.respPersons.map(person => `${person.name}${person.role ? ` (${person.role})` : ''}${person.mainSigner ? ', main signer' : ''}`).join('; ') ],
            [ 'Result', doc.passes ? badge('every measured point passes', 'ok') : badge('not every point passes', 'warn') ],
            [ 'Recalibration due', doc.recalibrationDue !== undefined ? formatTime(doc.recalibrationDue) : undefined ],
            ...signatureFacts(doc, result),
        ]),
        doc.statements.length ? h('div', null, h('h4', null, 'Statements'),
            h('ul', 'statements', ...doc.statements.map(statement => h('li', null, conformityBadge(statement.conformity), ' ', qiText(statement.declaration) ?? '', statement.norm ? h('span', 'muted', ` (${statement.norm})`) : null)))) : null,
        h('h4', null, 'Measurement results'),
        methods.length ? h('p', 'note', `Methods: ${methods.map(method => `${method.reference}${qiText(method.title) ? ` — ${qiText(method.title)}` : ''}`).join('; ')}. ` +
                                        (conditions.length ? `Conditions: ${conditions.map(quantity => `${refTypeText(quantity.refType)} ${quantityText(quantity)}`).join('; ')}.` : '')) : null,
        resultsTable,
    ];

}

function certificateBody(doc, result) {
    return [
        facts([
            [ 'Module', `${doc.module} — ${MODULES[doc.module] ?? ''}` ],
            [ 'Legislation', `${doc.legislation.name}${doc.legislation.act ? `, ${doc.legislation.act}` : ''}` ],
            [ 'Notified body', `${doc.conformityAssessmentBodyId}, number ${doc.notifiedBodyNumber}` ],
            [ 'For the model', doc.model ? `${doc.model.modelId} of ${doc.model.manufacturerId}, hardware ${doc.model.hardwareRevisions.join(', ')}, firmware ${doc.model.firmwareVersions.join(', ')}` : undefined ],
            [ 'For the quality system of', doc.manufacturer ? `${doc.manufacturer.manufacturerId}${doc.manufacturer.scope.length ? `, for ${doc.manufacturer.scope.join(', ')}` : ''}` : undefined ],
            [ 'Valid', `${formatTime(doc.validFrom)} – ${doc.validUntil !== undefined ? formatTime(doc.validUntil) : 'open'}` ],
            [ 'Revision', String(doc.revision) ],
            [ 'Standards', doc.standards.length ? doc.standards.map(standard => standard.reference).join(', ') : undefined ],
            [ 'Characteristics', doc.characteristics.length ? h('div', 'stack', ...doc.characteristics.map(quantity => h('span', null, h('span', 'muted', `${refTypeText(quantity.refType)}: `), quantityText(quantity)))) : undefined ],
            [ 'Conclusion', qiText(doc.conclusion) ],
            [ 'Conditions', doc.conditions.length ? doc.conditions.map(condition => qiText(condition)).join(' ') : undefined ],
            [ 'Document', doc.documentURL ],
            ...signatureFacts(doc, result),
        ]),
    ];
}

function declarationBody(doc, result) {
    return [
        facts([
            [ 'Model', `${doc.model.modelId} of ${doc.model.manufacturerId}, hardware ${doc.model.hardwareRevisions.join(', ')}, firmware ${doc.model.firmwareVersions.join(', ')}` ],
            [ 'Legislations', doc.legislations.map(legislation => `${legislation.name}${legislation.act ? ` (${legislation.act})` : ''}`).join(', ') ],
            [ 'Standards', doc.standards.length ? doc.standards.map(standard => standard.reference).join(', ') : undefined ],
            [ 'Notified bodies', h('div', 'stack', ...doc.notifiedBodies.map(body => h('span', null,
                `${body.conformityAssessmentBodyId} (${body.notifiedBodyNumber}), module ${body.module ?? '?'}${body.certificateId ? `, certificate ${body.certificateId}` : ''}`,
                body.intervention ? h('span', 'muted', ` — ${qiText(body.intervention)}`) : null))) ],
            [ 'Additional information', qiText(doc.additionalInformation) ],
            [ 'Issued', `${doc.placeOfIssue}, by ${doc.signatory.name}${doc.signatory.role ? ` (${doc.signatory.role})` : ''}` ],
            ...signatureFacts(doc, result),
        ]),
    ];
}


/** One QI-Digital document as a card: what it is, whether it verifies, what it says and how it relates to the others. */
export function qiDigitalCard(result, actions) {

    const doc   = result.doc;
    const title = doc ? `${KINDS[result.kind]} ${doc.id}` : result.document.name;

    return h('div', `card proof-card ${result.ok === false ? 'error-card' : ''}`,
        h('div', 'card-title-row', h('h3', null, title),
          result.ok === true ? badge('verified', 'ok') : result.ok === false ? badge('refused', 'error') : badge('not checked', 'warn')),
        doc ? h('p', 'note', `Issued by ${doc.issuerText}, signed with a key of it that may sign '${doc.usage}'.`) : null,
        result.error ? h('p', 'error-text', result.error) : null,
        ...(doc === undefined ? []
            : result.kind === 'calibrationCertificate'  ? calibrationBody(doc, result, actions)
            : result.kind === 'certificateOfConformity' ? certificateBody(doc, result)
            :                                             declarationBody(doc, result)),
        result.relations.length ? h('div', null, h('h4', null, 'Against the other papers'),
            checkList(result.relations.map(relation => ({ label: relation.label, ok: relation.ok, detail: relation.ok === true ? undefined : relation.detail })))) : null,
        h('div', 'card-actions', linkButton(result.document.name, () => actions.showDocument(result.document))),
        doc ? h('details', 'raw', h('summary', null, 'As WWCP_POI writes it again: what its signature and digest cover'), jsonView(doc.signatureInput(), { open: 1 })) : null,
    );

}

/** The QI-Digital documents about an EVSE (its energy meter) or a charging station, for the network view. */
export function papersOf(report, type, id) {
    const direct = report.qiDigital.filter(result => result.holder?.type === type && result.holder?.id === id);
    const certificates = report.qiDigital.filter(result => result.kind === 'certificateOfConformity' &&
                                                           result.relations.some(relation => relation.ok === true && direct.some(item => item.document === relation.ref)));
    return [ ...direct, ...certificates ];
}

export { KINDS as QI_DIGITAL_KINDS };
