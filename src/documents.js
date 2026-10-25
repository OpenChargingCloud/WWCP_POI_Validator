/*
 * What a document of WWCP POI is, from its JSON-LD context or, where it names none, from its shape; and the pool of all
 * documents loaded, from the demo, from files or from the servers of a trust anchor. The analysis takes what it needs
 * from the pool, whatever its source: a snapshot is a snapshot, whether a server sent it or it was dropped as a file.
 */

import { CONTEXT_PREFIX, TRUST_ANCHOR_QR_PREFIX, isArray, isObject, parseJSON } from '@open-charging-cloud/wwcp-poi';

import { formatBytes, i18n, plural } from './dom.js';


const ctx = (name) => CONTEXT_PREFIX + 'roamingNetwork/' + name;

const CONTEXTS = new Map([
    [ ctx('v1'),                          'roamingNetwork' ],
    [ ctx('commit/v3'),                   'commit' ],
    [ ctx('checkpoint/v1'),               'checkpoint' ],
    [ ctx('changeSet/v3'),                'changeSet' ],
    [ ctx('proof/v1'),                    'stationProof' ],
    [ ctx('attestation/v1'),              'attestation' ],
    [ ctx('priceStatement/v1'),           'priceStatement' ],
    [ ctx('priceStatementProof/v1'),      'priceStatementProof' ],
    [ ctx('checkpointProof/v1'),          'commitProof' ],
    [ ctx('archiveSegment/v1'),           'archiveSegment' ],
    [ ctx('archiveSegmentInfo/v1'),       'archiveSegmentInfo' ],
    [ ctx('trustAnchor/v2'),              'trustAnchor' ],
    [ ctx('epoch/v1'),                    'epoch' ],
    [ ctx('keyStatement/v3'),             'keyStatement' ],
]);


/** What each type of document is, for people. */
export const TYPE_LABELS = {
    trustAnchor:          'Trust anchor',
    snapshot:             'Snapshot',
    roamingNetwork:       'Roaming network (a version)',
    commit:               'Commit',
    commits:              'Commits',
    checkpoint:           'Checkpoint',
    checkpoints:          'Checkpoints',
    changeSet:            'Change set',
    priceStatement:       'Price statement',
    priceStatements:      'Price statements',
    stationProof:         'Charging station proof',
    attestation:          'Attestation',
    attestations:         'Attestations',
    commitProof:          'Proof of a commit in a checkpoint',
    priceStatementProof:  'Proof of a price statement in a checkpoint',
    evidence:             'Evidence of a charging session',
    witnesses:            'Trusted witnesses',
    archiveSegment:       'Archive segment',
    archiveSegments:      'Archive segments (list)',
    epoch:                'Epoch',
    epochs:               'Epochs',
    keyStatement:         'Key statement',
    party:                'Party',
    unknown:              'Unknown',
};


/** The type of a single JSON object. */
function typeOfObject(json) {

    const context = json['@context'];

    if (typeof context === 'string' && CONTEXTS.has(context))
        return CONTEXTS.get(context);

    if ('commit' in json && 'roamingNetwork' in json)
        return 'snapshot';

    if ('info' in json && 'base' in json && 'commits' in json)
        return 'archiveSegment';

    if ('trustAnchor' in json && 'EVSEId' in json && 'chargingStationProof' in json)
        return 'evidence';

    if ('hashAlgorithm' in json && 'roamingNetwork' in json)
        return 'stationProof';

    if ('checkpointId' in json && 'leaf' in json && '@auditPath' in json)
        return 'commitProof';

    if ('checkpointId' in json && 'priceStatement' in json && '@auditPath' in json)
        return 'priceStatementProof';

    if ('sequence' in json && 'commits' in json && 'commitId' in json)
        return 'checkpoint';

    if ('revision' in json && 'eTags' in json && 'roamingNetworkId' in json && '@id' in json && !('sequence' in json))
        return 'commit';

    if ('changes' in json && 'beforeETags' in json)
        return 'changeSet';

    if ('entityType' in json && 'priceStatus' in json && 'sequence' in json)
        return 'priceStatement';

    if ('eTag' in json && 'commitId' in json && 'validUntil' in json)
        return 'attestation';

    if ('epoch' in json && 'profiles' in json && 'status' in json)
        return 'epoch';

    if ('rootId' in json && 'endId' in json && 'fromRevision' in json)
        return 'archiveSegmentInfo';

    if ('roamingNetworkId' in json && 'identityKeyIds' in json && ('qrCode' in json || 'trustAnchor' in json))
        return 'trustAnchor';

    if ('@id' in json && 'urls' in json && 'keys' in json)
        return 'trustAnchor';

    if ('@id' in json && ('chargingStationOperators' in json || 'operator' in json) && !('signingKeys' in json))
        return 'roamingNetwork';

    if ('priceStatements' in json && isArray(json['priceStatements']))
        return 'priceStatements';

    if ('attestations' in json && isArray(json['attestations']) && !('roamingNetwork' in json))
        return 'attestations';

    if ('@id' in json && ('signingKeys' in json || 'identityKeys' in json))
        return 'party';

    return 'unknown';

}

const LIST_TYPES = {
    commit:              'commits',
    checkpoint:          'checkpoints',
    priceStatement:      'priceStatements',
    attestation:         'attestations',
    archiveSegmentInfo:  'archiveSegments',
    epoch:               'epochs',
};


/** The type of a document of JSON, as POI reads it. */
export function classify(json) {

    if (typeof json === 'string')
        return json.trim().startsWith(TRUST_ANCHOR_QR_PREFIX) || /^https?:\/\//i.test(json.trim()) ? 'trustAnchor' : 'unknown';

    if (isArray(json)) {

        if (json.length === 0)
            return 'unknown';

        if (json.every(item => isObject(item) && 'witness' in item && 'key' in item))
            return 'witnesses';

        const types = new Set(json.map(item => isObject(item) ? typeOfObject(item) : 'unknown'));
        const [ only ] = types;

        if (types.size === 1 && LIST_TYPES[only] !== undefined)
            return LIST_TYPES[only];

        return 'unknown';

    }

    return isObject(json) ? typeOfObject(json) : 'unknown';

}


/** One line about a document, e.g. "Commits 1 to 10 of QA". */
export function summarize(type, json) {

    try {

        switch (type) {

            case 'trustAnchor':
                return typeof json === 'string' ? json.slice(0, 48) + (json.length > 48 ? '…' : '') : `of ${json['@id'] ?? json['roamingNetworkId']}`;

            case 'snapshot': {
                const commit   = json['commit'];
                const epoch    = isObject(json['epoch']) ? json['epoch']['epoch'] : commit?.['epoch'] ?? 1;
                const extras   = [ json['checkpoint'] ? 'with its checkpoint' : null, json['runtimeStatus'] ? 'with runtime status' : null ].filter(Boolean);
                return `${json['roamingNetwork']?.['@id']}, revision ${commit?.['revision']} of epoch ${epoch}${extras.length ? ', ' + extras.join(', ') : ''}`;
            }

            case 'roamingNetwork':
                return `${json['@id']}${i18n(json['name']) ? ` (${i18n(json['name'])})` : ''}`;

            case 'commit':
                return `revision ${json['revision']}${json['epoch'] ? ` of epoch ${json['epoch']}` : ''}: ${i18n(json['changeSet']?.['description']) ?? 'genesis'}`;

            case 'commits': {
                const revisions = json.map(commit => commit['revision']);
                return `${plural(json.length, 'commit')}, revisions ${Math.min(...revisions)} to ${Math.max(...revisions)}${json[0]['epoch'] ? ` of epoch ${json[0]['epoch']}` : ''}`;
            }

            case 'checkpoint':
                return `sequence ${json['sequence']} of epoch ${json['epoch'] ?? 1}, revision ${json['revision']}${json['final'] ? ', final' : ''}`;

            case 'checkpoints':
                return `${plural(json.length, 'checkpoint')}, sequences ${json.map(item => item['sequence']).join(', ')}`;

            case 'priceStatement':
                return `${json['entityType']} ${json['entityId']}, sequence ${json['sequence']}`;

            case 'priceStatements': {
                const list = isArray(json) ? json : json['priceStatements'];
                return `${plural(list.length, 'statement')} of ${[ ...new Set(list.map(item => item['entityId'])) ].join(', ')}`;
            }

            case 'stationProof':
                return `revision ${json['revision']}, ${plural(json['attestations']?.length ?? 0, 'attestation')}, ${json['hashAlgorithm']}`;

            case 'attestations': {
                const list = isArray(json) ? json : json['attestations'];
                return `${plural(list.length, 'attestation')} of revision ${list[0]?.['revision']}`;
            }

            case 'commitProof':
                return `revision ${json['leaf']?.['revision']} in checkpoint ${String(json['checkpointId']).slice(0, 12)}…`;

            case 'priceStatementProof':
                return `${json['priceStatement']?.['entityId']} #${json['priceStatement']?.['sequence']} in checkpoint ${String(json['checkpointId']).slice(0, 12)}…`;

            case 'evidence':
                return `EVSE ${json['EVSEId']}, charging started ${json['chargingStarted']}`;

            case 'witnesses':
                return json.map(item => item['witness']).join(', ');

            case 'archiveSegment':
                return `segment ${json['info']?.['number']}: revisions ${json['info']?.['fromRevision']} to ${json['info']?.['toRevision']}`;

            case 'archiveSegments':
                return `${plural(json.length, 'segment')}`;

            case 'epoch':
                return `epoch ${json['epoch']}, ${json['status']}`;

            case 'epochs':
                return json.map(item => `epoch ${item['epoch']} (${item['status']})`).join(', ');

            case 'changeSet':
                return i18n(json['description']) ?? String(json['@id']);

            default:
                return '';

        }

    }
    catch {
        return '';
    }

}


let nextId = 1;

/**
 * The documents loaded, each read as POI reads JSON: decimals stay decimals. A document is the text it came as, its JSON,
 * its type and where it came from.
 */
export class DocumentPool {

    constructor() {
        this.documents = [];
    }

    get size() {
        return this.documents.length;
    }

    /** Adds a document given as text; returns it, with `error` set where it is no JSON and no trust anchor. */
    addText(name, text, origin, extra = {}) {

        const trimmed = text.trim();
        let json;
        let error;

        if (trimmed.startsWith(TRUST_ANCHOR_QR_PREFIX) || /^https?:\/\/\S+$/i.test(trimmed))
            json = trimmed;
        else {
            try {
                json = parseJSON(trimmed);
            }
            catch (e) {
                error = e instanceof Error ? e.message : String(e);
            }
        }

        const type = error === undefined ? classify(json) : 'unknown';

        const document = {
            id:       nextId++,
            name,
            origin,
            size:     new TextEncoder().encode(text).length,
            text,
            json,
            type,
            label:    TYPE_LABELS[type] ?? type,
            summary:  error === undefined ? summarize(type, json) : '',
            error,
            ...extra,
        };

        this.documents.push(document);

        return document;

    }

    /** Replaces the text of a document, e.g. after the user edited it to see what the verification says then. */
    replaceText(document, text) {
        const index = this.documents.indexOf(document);
        const { id, name, origin, url, description } = document;
        this.documents.splice(index, 1);
        const replaced = this.addText(name, text, origin, { url, description, edited: true });
        this.documents.splice(this.documents.indexOf(replaced), 1);
        this.documents.splice(index, 0, { ...replaced, id });
        return this.documents[index];
    }

    /** Records a request that gave no document, so that the user sees what was asked and why it failed. */
    addFailure(name, origin, error, extra = {}) {
        const document = { id: nextId++, name, origin, size: 0, json: undefined, type: 'failed', label: 'Not loaded', summary: '', error, ...extra };
        this.documents.push(document);
        return document;
    }

    ofType(...types) {
        return this.documents.filter(document => document.error === undefined && types.includes(document.type));
    }

    describe(document) {
        return `${document.label}${document.summary ? ' — ' + document.summary : ''} (${formatBytes(document.size)})`;
    }

}
