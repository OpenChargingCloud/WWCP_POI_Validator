/*
 * The entities of a version of a roaming network, for the explorer: the tree of what embeds what, where an effective
 * value comes from (its own, or a template, 9.2), the path of an entity through the effective tree up to the root that
 * attestations and commits name (8.2), and the commits that changed an entity.
 */

import {
    CHILD_ARRAYS, auditPath, canonicalJSON, entityDigest, get, isArray, isObject, merkleRootOfLeafHashes, rootFromAuditPath, skeleton, toHex,
} from '@open-charging-cloud/wwcp-poi';

import { i18n } from './dom.js';


/** The entity type of the members of each child array (and of the embedded energy meters, which are no child array). */
export const ARRAY_TYPES = {
    chargingStationOperators:           'ChargingStationOperator',
    chargingStationManufacturers:       'ChargingStationManufacturer',
    eMobilityProviders:                 'EMobilityProvider',
    gridOperators:                      'GridOperator',
    parkingOperators:                   'ParkingOperator',
    energyMeterManufacturers:           'EnergyMeterManufacturer',
    transparencySoftwareManufacturers:  'TransparencySoftwareManufacturer',
    conformityAssessmentBodies:         'ConformityAssessmentBody',
    chargingPools:                      'ChargingPool',
    chargingStations:                   'ChargingStation',
    EVSEs:                              'EVSE',
    chargingTariffs:                    'ChargingTariff',
    EVSETemplates:                      'EVSETemplate',
    chargingStationTemplates:           'ChargingStationTemplate',
    chargingPoolTemplates:              'ChargingPoolTemplate',
    chargingTariffTemplates:            'ChargingTariffTemplate',
    energyMeterTemplates:               'EnergyMeterTemplate',
    EVSEGroups:                         'EVSEGroup',
    chargingStationGroups:              'ChargingStationGroup',
    chargingPoolGroups:                 'ChargingPoolGroup',
    chargingTariffGroups:               'ChargingTariffGroup',
    energyMeterGroups:                  'EnergyMeterGroup',
    chargingTariffOffers:               'ChargingTariffOffer',
    parkingSpaces:                      'ParkingSpace',
    gridConnectionPoints:               'GridConnectionPoint',
    parkingGarages:                     'ParkingGarage',
    parkingSensors:                     'ParkingSensor',
    parkingSpaceTemplates:              'ParkingSpaceTemplate',
    parkingSpaceGroups:                 'ParkingSpaceGroup',
    parkingProducts:                    'ParkingProduct',
    chargingStationModels:              'ChargingStationModel',
    energyMeterModels:                  'EnergyMeterModel',
    transparencySoftware:               'TransparencySoftware',
    transparencySoftwareCertificates:   'TransparencySoftwareCertificate',
};

/** How the arrays are shown in the tree: the infrastructure first, templates and groups after. */
export const ARRAY_LABELS = {
    chargingStationOperators:           'Charging station operators',
    chargingStationManufacturers:       'Charging station manufacturers',
    eMobilityProviders:                 'E-mobility providers',
    gridOperators:                      'Grid operators',
    parkingOperators:                   'Parking operators',
    energyMeterManufacturers:           'Energy meter manufacturers',
    transparencySoftwareManufacturers:  'Transparency software manufacturers',
    conformityAssessmentBodies:         'Conformity assessment bodies',
    chargingPools:                      'Charging pools',
    chargingStations:                   'Charging stations',
    EVSEs:                              'EVSEs',
    chargingTariffs:                    'Charging tariffs',
    EVSETemplates:                      'EVSE templates',
    chargingStationTemplates:           'Charging station templates',
    chargingPoolTemplates:              'Charging pool templates',
    chargingTariffTemplates:            'Charging tariff templates',
    energyMeterTemplates:               'Energy meter templates',
    EVSEGroups:                         'EVSE groups',
    chargingStationGroups:              'Charging station groups',
    chargingPoolGroups:                 'Charging pool groups',
    chargingTariffGroups:               'Charging tariff groups',
    energyMeterGroups:                  'Energy meter groups',
    chargingTariffOffers:               'Charging tariff offers',
    parkingSpaces:                      'Parking spaces',
    gridConnectionPoints:               'Grid connection points',
    parkingGarages:                     'Parking garages',
    parkingSensors:                     'Parking sensors',
    parkingSpaceTemplates:              'Parking space templates',
    parkingSpaceGroups:                 'Parking space groups',
    parkingProducts:                    'Parking products',
    chargingStationModels:              'Models',
    energyMeterModels:                  'Models',
    transparencySoftware:               'Releases',
    transparencySoftwareCertificates:   'Certificates',
};

const KIND_OF_TYPE = {
    RoamingNetwork:                     'roamingNetwork',
    ChargingStationOperator:            'chargingStationOperator',
    ChargingPool:                       'chargingPool',
    ChargingStation:                    'chargingStation',
    EMobilityProvider:                  'eMobilityProvider',
    GridOperator:                       'gridOperator',
    ParkingOperator:                    'parkingOperator',
    ChargingStationManufacturer:        'chargingStationManufacturer',
    EnergyMeterManufacturer:            'energyMeterManufacturer',
    TransparencySoftwareManufacturer:   'transparencySoftwareManufacturer',
    ConformityAssessmentBody:           'conformityAssessmentBody',
};

/** The kind of tree node of an entity type (8.2): the types with child arrays, every other one a leaf. */
export const kindOf = (type) => KIND_OF_TYPE[type] ?? 'leaf';


/** A short label of an entity: its name where it has one, else its identification. */
export function entityLabel(json) {
    const name = i18n(json['name']);
    const id   = String(json['@id'] ?? '');
    return name && name !== id ? `${id} · ${name}` : id;
}


/**
 * The tree of a version, as nodes `{ type, id, json, array, path, children, parent }`: the roaming network with its
 * operator and every child array (8.2), in the order of the content. `path` is the list of `{ array, id }` from the root.
 */
export function entityTree(content) {

    const root = { type: 'RoamingNetwork', id: String(content['@id']), json: content, array: undefined, path: [], children: [], parent: undefined, groups: [] };
    const index = new Map();

    index.set(`RoamingNetwork:${root.id}`, root);

    if (isObject(content['operator'])) {
        const operator = { type: 'RoamingNetworkOperator', id: String(content['operator']['@id']), json: content['operator'], array: 'operator', path: [ { array: 'operator', id: String(content['operator']['@id']) } ], children: [], parent: root, groups: [] };
        root.children.push(operator);
        index.set(`RoamingNetworkOperator:${operator.id}`, operator);
    }

    const walk = (node, kind) => {

        for (const array of Object.keys(CHILD_ARRAYS[kind] ?? {})) {

            const items = get(node.json, array);

            if (!isArray(items) || items.length === 0)
                continue;

            const group = { array, label: ARRAY_LABELS[array] ?? array, nodes: [] };
            node.groups.push(group);

            for (const item of items) {

                if (!isObject(item))
                    continue;

                const type  = ARRAY_TYPES[array] ?? array;
                const child = { type, id: String(item['@id']), json: item, array, path: [ ...node.path, { array, id: String(item['@id']) } ], children: [], parent: node, groups: [] };

                group.nodes.push(child);
                node.children.push(child);
                index.set(`${type}:${child.id}`, child);

                walk(child, CHILD_ARRAYS[kind][array]);

            }

        }

    };

    walk(root, 'roamingNetwork');

    return { root, index };

}

/** The entity a path names in a content, e.g. the same station in another version or as stored rather than effective. */
export function entityAt(content, path) {
    let current = content;
    for (const { array, id } of path) {
        if (array === 'operator') {
            current = isObject(current['operator']) ? current['operator'] : undefined;
            continue;
        }
        const items = get(current ?? {}, array);
        current = isArray(items) ? items.find(item => isObject(item) && String(item['@id']) === id) : undefined;
        if (current === undefined)
            return undefined;
    }
    return current;
}


/** Counts of a version: what an overview shows. */
export function countEntities(content) {

    const counts = { operators: 0, pools: 0, stations: 0, evses: 0, tariffs: 0, templates: 0, groups: 0, parties: 0 };

    for (const array of Object.keys(CHILD_ARRAYS.roamingNetwork))
        counts.parties += isArray(content[array]) ? content[array].length : 0;

    for (const operator of isArray(content['chargingStationOperators']) ? content['chargingStationOperators'] : []) {
        counts.operators++;
        counts.tariffs   += isArray(operator['chargingTariffs']) ? operator['chargingTariffs'].length : 0;
        for (const array of [ 'EVSETemplates', 'chargingStationTemplates', 'chargingPoolTemplates', 'chargingTariffTemplates', 'energyMeterTemplates' ])
            counts.templates += isArray(operator[array]) ? operator[array].length : 0;
        for (const array of [ 'EVSEGroups', 'chargingStationGroups', 'chargingPoolGroups', 'chargingTariffGroups', 'energyMeterGroups' ])
            counts.groups += isArray(operator[array]) ? operator[array].length : 0;
        for (const pool of isArray(operator['chargingPools']) ? operator['chargingPools'] : []) {
            counts.pools++;
            for (const station of isArray(pool['chargingStations']) ? pool['chargingStations'] : []) {
                counts.stations++;
                counts.evses += isArray(station['EVSEs']) ? station['EVSEs'].length : 0;
            }
        }
    }

    return counts;

}


//  ------------------------------------------------------------------
//  Where an effective value comes from (9.2)
//  ------------------------------------------------------------------

const TEMPLATE_ARRAYS = {
    EVSE:             'EVSETemplates',
    ChargingStation:  'chargingStationTemplates',
    ChargingPool:     'chargingPoolTemplates',
    ChargingTariff:   'chargingTariffTemplates',
};

/** The charging station operator of a path: the first node of it below the roaming network. */
function operatorOfPath(content, path) {
    const [ first ] = path;
    return first?.array === 'chargingStationOperators' ? entityAt(content, [ first ]) : undefined;
}

function templatesOf(content, path, type, json) {
    const operator = operatorOfPath(content, path);
    const array    = TEMPLATE_ARRAYS[type];
    const ids      = isArray(json?.['templateIds']) ? json['templateIds'].map(String) : [];
    const given    = operator !== undefined && array !== undefined && isArray(operator[array]) ? operator[array] : [];
    return ids.map(id => given.find(template => String(template['@id']).toUpperCase() === id.toUpperCase())).filter(Boolean);
}

/**
 * Where each property of an effective member comes from: `own`, a template (the first of its templates giving it), or
 * `merged` where an array unites its own elements with those of its templates. Its charging tariffs follow the templates
 * of the EVSE, its station and its pool (9.2).
 */
export function provenance(storedContent, path, type, effective) {

    const stored    = entityAt(storedContent, path) ?? {};
    const templates = templatesOf(storedContent, path, type, stored);
    const result    = new Map();

    for (const [ property, value ] of Object.entries(effective)) {

        if (CHILD_ARRAYS[kindOf(type)]?.[property] !== undefined)
            continue;

        const own = stored[property];

        if (own !== undefined && canonicalJSON(own) === canonicalJSON(value)) {
            result.set(property, { source: 'own' });
            continue;
        }

        if (property === 'lastChange') {
            result.set(property, { source: 'derived', note: 'the latest of its own, of its templates and of what it embeds (8.1)' });
            continue;
        }

        if (property === 'chargingTariffIds' && own === undefined) {
            const station = path.length >= 2 ? entityAt(storedContent, path.slice(0, -1)) : undefined;
            const pool    = path.length >= 3 ? entityAt(storedContent, path.slice(0, -2)) : undefined;
            const levels  = [ [ templates, 'EVSE template' ], [ templatesOf(storedContent, path.slice(0, -1), 'ChargingStation', station), 'charging station template' ],
                              [ templatesOf(storedContent, path.slice(0, -2), 'ChargingPool', pool), 'charging pool template' ] ];
            for (const [ list, what ] of levels) {
                const template = list.find(item => item['chargingTariffId'] !== undefined);
                if (template !== undefined) {
                    result.set(property, { source: 'template', templateId: String(template['@id']), note: `the chargingTariffId of its ${what}` });
                    break;
                }
            }
            if (!result.has(property))
                result.set(property, { source: 'derived' });
            continue;
        }

        const template = templates.find(item => item[property] !== undefined);

        if (own === undefined && template !== undefined)
            result.set(property, { source: 'template', templateId: String(template['@id']) });
        else if (isArray(value) && template !== undefined)
            result.set(property, { source: 'merged', templateId: String(template['@id']), note: 'its own elements united with those of its templates' });
        else if (isObject(value) && isObject(own))
            result.set(property, { source: 'merged', templateId: isArray(own['templateIds']) ? own['templateIds'].join(', ') : undefined,
                                   note: property === 'energyMeter' ? 'its own energy meter, with what its energy meter templates give it' : 'its own, with what its templates give it' });
        else if (own !== undefined)
            result.set(property, { source: 'own' });
        else
            result.set(property, { source: 'derived' });

    }

    return { stored, templates, properties: result };

}


//  ------------------------------------------------------------------
//  From an entity to the root of the effective tree (8.2)
//  ------------------------------------------------------------------

/**
 * The path of an entity through the effective tree: at each level the child array, the index of the entity in it, its
 * size, the digest of the entity and its audit path (RFC 9162), the root of the array that the parent's skeleton names;
 * at the top the root, the digest of the roaming network, which the `effectiveTree` ETag of the commit names. This is
 * what a proof of the entity gives (8.4), calculated here from the whole version.
 */
export function merklePath(effective, path, algorithm = 'sha256') {

    const levels = [];
    const nodes  = [ { json: effective, kind: 'roamingNetwork' } ];

    for (const { array, id } of path) {
        const parent = nodes.at(-1);
        if (array === 'operator')
            return undefined;
        const childKind = CHILD_ARRAYS[parent.kind]?.[array];
        const items     = get(parent.json, array);
        if (childKind === undefined || !isArray(items))
            return undefined;
        const index = items.findIndex(item => String(item['@id']) === id);
        if (index < 0)
            return undefined;
        nodes.push({ json: items[index], kind: childKind, array, index, siblings: items });
    }

    // Bottom-up: the digest of each node, its audit path in its array, the root of the array.
    let digest = entityDigest(nodes.at(-1).json, nodes.at(-1).kind, algorithm);

    for (let level = nodes.length - 1; level > 0; level--) {

        const node       = nodes[level];
        const leafHashes = node.siblings.map(item => entityDigest(item, node.kind, algorithm));
        const path       = auditPath(algorithm, leafHashes, node.index);
        const root       = merkleRootOfLeafHashes(algorithm, leafHashes);
        const recomputed = rootFromAuditPath(algorithm, digest, node.index, leafHashes.length, path);

        levels.unshift({
            array:     node.array,
            id:        String(node.json['@id']),
            type:      ARRAY_TYPES[node.array],
            index:     node.index,
            size:      leafHashes.length,
            digest:    toHex(digest),
            auditPath: path.map(toHex),
            root:      toHex(root),
            matches:   toHex(recomputed) === toHex(root),
        });

        digest = entityDigest(nodes[level - 1].json, nodes[level - 1].kind, algorithm);

    }

    const top = nodes.at(-1);

    return {
        levels,
        root:      toHex(entityDigest(effective, 'roamingNetwork', algorithm)),
        skeleton:  skeleton(top.json, top.kind, algorithm),
        digest:    toHex(entityDigest(top.json, top.kind, algorithm)),
        algorithm,
    };

}


//  ------------------------------------------------------------------
//  The commits that changed an entity
//  ------------------------------------------------------------------

function contains(value, id, depth = 0) {
    if (depth > 6 || !isObject(value))
        return undefined;
    for (const [ array, type ] of Object.entries(ARRAY_TYPES)) {
        const items = value[array];
        if (!isArray(items))
            continue;
        for (const item of items) {
            if (!isObject(item))
                continue;
            if (String(item['@id']) === id)
                return type;
            const found = contains(item, id, depth + 1);
            if (found !== undefined)
                return found;
        }
    }
    return undefined;
}

/**
 * The commits of the report that changed an entity: changes of it, of what embeds it when that is added or removed with
 * it, and of the templates it names, whose properties it takes (9.2).
 */
export function entityHistory(report, type, id, templateIds = []) {

    const result    = [];
    const templates = new Set(templateIds.map(item => item.toUpperCase()));

    for (const epoch of report.epochs) {
        for (const step of epoch.steps) {

            if (step.type !== 'commit' || step.changeSet === undefined)
                continue;

            const changes = [];

            for (const change of step.changeSet.changes) {
                if (change.entityId === id && change.entityType === type)
                    changes.push({ change, how: 'direct' });
                else if ((change.kind === 'Add' || change.kind === 'Remove') && contains(change.kind === 'Add' ? change.newValue : change.oldValue, id) !== undefined)
                    changes.push({ change, how: change.kind === 'Add' ? 'added with' : 'removed with' });
                else if (templates.has(change.entityId.toUpperCase()))
                    changes.push({ change, how: 'template' });
            }

            if (changes.length > 0)
                result.push({ step, changes });

        }
    }

    return result;

}
