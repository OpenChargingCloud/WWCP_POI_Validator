/*
 * The network: any version the history took, effective (as proofs and apps see it, templates resolved) or as stored, as a
 * tree and on a map; for each entity where its values come from, the commits that changed it, and its path through the
 * effective tree up to the root the commit names.
 */

import L from 'leaflet';

import { etagToText, get, isArray, isObject, jsonETag } from '@open-charging-cloud/wwcp-poi';

import { badge, button, facts, formatTime, h, i18n, jsonText, jsonView, plural, section, shortId } from '../dom.js';
import { ARRAY_TYPES, entityAt, entityHistory, entityLabel, entityTree, merklePath, provenance } from '../entities.js';
import { PARTY_LABELS } from '../keys.js';
import { changeChip, emptyState, headKey, linkButton, versionSelect } from './common.js';
import { priceSummary } from './history.js';
import { QI_DIGITAL_KINDS, papersOf } from './qidigital.js';


const TYPE_LABELS = {
    RoamingNetwork:          'roaming network',
    RoamingNetworkOperator:  'roaming network operator',
    ...Object.fromEntries(Object.values(ARRAY_TYPES).map(type => [ type, type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^E V S E/, 'EVSE').toLowerCase().replace(/^evse/, 'EVSE') ])),
    ...PARTY_LABELS,
};

const typeLabel = (type) => TYPE_LABELS[type] ?? type;

/** Up to this many entities below a node, it starts expanded. */
const AUTO_EXPAND = 40;

const OPERATOR_COLORS = [ '#0f766e', '#dc2626', '#4338ca', '#c026d3', '#ca8a04', '#0284c7', '#65a30d', '#9333ea', '#ea580c', '#475569' ];

let currentMap;


function descendants(node) {
    let count = 0;
    for (const child of node.children)
        count += 1 + descendants(child);
    return count;
}

function runtimeOf(report, version) {
    return report.runtime.find(item => item.commitId === version.commit.id);
}

function statusBadge(runtime, type, id) {
    if (runtime === undefined || ![ 'ChargingPool', 'ChargingStation', 'EVSE' ].includes(type))
        return null;
    const entry = runtime.status.get(type, id, 'status');
    if (entry === undefined)
        return null;
    const value = String(entry.value);
    const kind  = value === 'available' ? 'ok' : value === 'charging' || value === 'occupied' ? 'info' : value === 'outOfService' || value === 'error' || value === 'faulted' ? 'error' : 'warn';
    return badge(value, kind, `Runtime status at ${formatTime(entry.timestamp)}: unsigned, from the snapshot`);
}


//  ------------------------------------------------------------------
//  The tree
//  ------------------------------------------------------------------

function treeView(tree, selectedKey, runtime, onSelect) {

    const container = h('div', 'tree');

    const nodeRow = (node, depth) => {

        const key      = `${node.type}:${node.id}`;
        const hasKids  = node.groups.length > 0;
        const wrapper  = h('div', 'tree-node');
        const row      = h('div', `tree-row${key === selectedKey ? ' selected' : ''}`);
        const toggle   = h('button', 'tree-toggle', hasKids ? '▸' : '');
        toggle.type    = 'button';
        toggle.disabled = !hasKids;

        const label = h('button', 'tree-label',
            h('span', `type-dot t-${node.type}`),
            h('span', 'tree-text', entityLabel(node.json)),
            h('span', 'tree-type', typeLabel(node.type)),
            statusBadge(runtime, node.type, node.id));
        label.type = 'button';
        label.addEventListener('click', () => onSelect(node));

        row.style.paddingLeft = `${depth * 14}px`;
        row.append(toggle, label);
        wrapper.append(row);

        const children = h('div', 'tree-children');
        let rendered = false;

        const setOpen = (open) => {
            if (open && !rendered) {
                for (const group of node.groups)
                    children.append(groupRow(group, depth + 1));
                rendered = true;
            }
            children.hidden = !open;
            toggle.textContent = hasKids ? (open ? '▾' : '▸') : '';
        };

        if (hasKids) {
            toggle.addEventListener('click', () => setOpen(children.hidden));
            wrapper.append(children);
            // The roaming network, small subtrees and the parties of a network of few parties start expanded.
            const fewSiblings = node.parent?.parent === undefined && (node.parent?.groups.find(group => group.array === node.array)?.nodes.length ?? 99) <= 3;
            setOpen(node.parent === undefined || fewSiblings || descendants(node) <= AUTO_EXPAND || isAncestorOfSelected(node));
        }

        if (key === selectedKey)
            requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));

        return wrapper;

    };

    const isAncestorOfSelected = (node) => {
        let found = false;
        const visit = (current) => {
            if (found)
                return;
            if (`${current.type}:${current.id}` === selectedKey)
                found = true;
            current.children.forEach(visit);
        };
        node.children.forEach(visit);
        return found;
    };

    const groupRow = (group, depth) => {
        const wrapper  = h('div', 'tree-group');
        const toggle   = h('button', 'tree-toggle', '▸');
        toggle.type    = 'button';
        const head     = h('div', 'tree-group-head', toggle, h('span', null, group.label), h('span', 'count', group.nodes.length.toLocaleString('en')));
        head.style.paddingLeft = `${depth * 14}px`;
        const children = h('div', 'tree-children');
        let rendered   = false;
        const setOpen  = (open) => {
            if (open && !rendered) {
                for (const node of group.nodes)
                    children.append(nodeRow(node, depth + 1));
                rendered = true;
            }
            children.hidden = !open;
            toggle.textContent = open ? '▾' : '▸';
        };
        toggle.addEventListener('click', () => setOpen(children.hidden));
        head.addEventListener('dblclick', () => setOpen(children.hidden));
        wrapper.append(head, children);
        const total = group.nodes.reduce((sum, node) => sum + 1 + descendants(node), 0);
        setOpen(total <= AUTO_EXPAND || (depth <= 1 && group.nodes.length <= 12) || group.nodes.some(node => `${node.type}:${node.id}` === selectedKey || isAncestorOfSelected(node)));
        return wrapper;
    };

    container.append(nodeRow(tree.root, 0));
    return container;

}

function searchResults(tree, query, onSelect) {
    const needle  = query.toLowerCase();
    const results = [];
    for (const node of tree.index.values()) {
        if (results.length >= 200)
            break;
        const name = i18n(node.json['name']) ?? '';
        if (node.id.toLowerCase().includes(needle) || name.toLowerCase().includes(needle))
            results.push(node);
    }
    const list = h('div', 'search-results');
    if (results.length === 0)
        list.append(h('p', 'muted', 'Nothing found.'));
    for (const node of results) {
        const item = h('button', 'search-result', h('span', `type-dot t-${node.type}`), h('span', null, entityLabel(node.json)), h('span', 'tree-type', typeLabel(node.type)),
                       h('div', 'muted small', node.path.map(segment => segment.id).join(' › ')));
        item.type = 'button';
        item.addEventListener('click', () => onSelect(node));
        list.append(item);
    }
    if (results.length === 200)
        list.append(h('p', 'muted small', 'The first 200 matches.'));
    return list;
}


//  ------------------------------------------------------------------
//  The map
//  ------------------------------------------------------------------

function poolsWithLocation(content) {
    const pools = [];
    const operators = isArray(content['chargingStationOperators']) ? content['chargingStationOperators'] : [];
    operators.forEach((operator, operatorIndex) => {
        for (const pool of isArray(operator['chargingPools']) ? operator['chargingPools'] : []) {
            const location = pool['geoLocation'];
            const lat = Number(jsonText(location?.['lat']));
            const lng = Number(jsonText(location?.['lng']));
            if (isObject(location) && Number.isFinite(lat) && Number.isFinite(lng))
                pools.push({ operator, operatorIndex, pool, lat, lng });
        }
    });
    return pools;
}

/** The charging pools of a version on a map, coloured by operator; `highlight(path)` marks the pool of a selected entity. */
function mapView(content, tree, selectedPath, onSelect) {

    const pools = poolsWithLocation(content);

    if (pools.length === 0)
        return undefined;

    const element = h('div', 'map');
    const legend  = h('div', 'map-legend');
    const operators = isArray(content['chargingStationOperators']) ? content['chargingStationOperators'] : [];
    const markers = new Map();

    operators.forEach((operator, index) => {
        const dot = h('span', 'legend-dot');
        dot.style.background = OPERATOR_COLORS[index % OPERATOR_COLORS.length];
        legend.append(h('span', 'legend-item', dot, entityLabel(operator), h('span', 'muted', ` (${isArray(operator['chargingPools']) ? operator['chargingPools'].length : 0})`)));
    });

    const style = (stations, selected) => ({
        radius:  selected ? 9 : Math.min(8, 4 + stations),
        color:   selected ? '#111827' : '#ffffff',
        weight:  selected ? 3 : 1,
    });

    let highlighted;

    const highlight = (path) => {
        const poolId = path?.[0]?.array === 'chargingStationOperators' ? path?.[1]?.id : undefined;
        if (highlighted !== undefined)
            highlighted.marker.setStyle(style(highlighted.stations, false));
        highlighted = poolId === undefined ? undefined : markers.get(poolId);
        if (highlighted !== undefined) {
            highlighted.marker.setStyle(style(highlighted.stations, true));
            highlighted.marker.bringToFront();
        }
    };

    requestAnimationFrame(() => {

        currentMap?.observer.disconnect();
        currentMap?.map.remove();

        const map = L.map(element, { preferCanvas: true, scrollWheelZoom: false, zoomSnap: 0.25 });

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);

        const bounds = [];

        for (const { operator, operatorIndex, pool, lat, lng } of pools) {

            const stations = isArray(pool['chargingStations']) ? pool['chargingStations'] : [];
            const evses    = stations.reduce((sum, station) => sum + (isArray(station['EVSEs']) ? station['EVSEs'].length : 0), 0);
            const marker   = L.circleMarker([ lat, lng ], {
                ...style(stations.length, false),
                fillColor:    OPERATOR_COLORS[operatorIndex % OPERATOR_COLORS.length],
                fillOpacity:  0.9,
            }).addTo(map);

            markers.set(String(pool['@id']), { marker, stations: stations.length });

            marker.bindTooltip(`${entityLabel(pool)} — ${String(operator['@id'])}, ${stations.length} station${stations.length === 1 ? '' : 's'}, ${evses} EVSE${evses === 1 ? '' : 's'}`);
            marker.on('click', () => {
                const node = tree.index.get(`ChargingPool:${String(pool['@id'])}`);
                if (node)
                    onSelect(node);
            });

            bounds.push([ lat, lng ]);

        }

        map.fitBounds(bounds, { padding: [ 24, 24 ], maxZoom: 13 });
        highlight(selectedPath);

        // Once the layout settled, and whenever the map changes its size: fitted to the pools again.
        const observer = new ResizeObserver(() => {
            if (element.isConnected && element.clientWidth > 0) {
                map.invalidateSize();
                map.fitBounds(bounds, { padding: [ 24, 24 ], maxZoom: 13 });
            }
        });
        observer.observe(element);

        currentMap = { map, observer };

    });

    return { element: h('div', 'map-panel', element, legend), highlight };

}


//  ------------------------------------------------------------------
//  The details of an entity
//  ------------------------------------------------------------------

function propertyTable(entity, origin, mode) {

    const table = h('table', 'grid properties');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Property'), h('th', null, 'Value'), mode === 'effective' ? h('th', null, 'From') : null)));
    const body = h('tbody');

    for (const [ property, value ] of Object.entries(entity)) {

        if (ARRAY_TYPES[property] !== undefined && isArray(value))
            continue;

        const text = jsonText(value);
        const from = origin?.properties.get(property);

        body.append(h('tr', from?.source === 'template' ? 'from-template' : null,
            h('td', null, h('code', null, property)),
            h('td', null, text.length <= 120 ? h('code', 'value', text) : jsonView(value, { open: 0 })),
            mode === 'effective'
                ? h('td', 'small', from === undefined ? '' :
                      from.source === 'own'      ? h('span', 'muted', 'own') :
                      from.source === 'template' ? h('span', null, badge('template', 'info', from.note), ' ', h('code', null, from.templateId), from.note ? h('div', 'muted', from.note) : null) :
                      from.source === 'merged'   ? h('span', null, badge('own + template', 'info', from.note), from.templateId ? h('code', null, ' ' + from.templateId) : null, from.note ? h('div', 'muted', from.note) : null) :
                                                   h('span', 'muted', from.note ?? 'derived'))
                : null));

    }

    table.append(body);
    return table;

}

function childSummary(node) {
    if (node.groups.length === 0)
        return null;
    return h('div', 'child-summary', ...node.groups.map(group => h('span', 'chip', `${group.nodes.length} ${group.label.toLowerCase()}`)));
}

const kW = (value) => value === undefined ? '—' : `${(Number(jsonText(value)) / 1000).toLocaleString('en')} kW`;

/** The EVSEs of a station, or the stations of a pool, at a glance; a click selects one. */
function childTable(node, runtime, onSelect) {

    if (node.type !== 'ChargingStation' && node.type !== 'ChargingPool')
        return null;

    const table = h('table', 'grid');
    const body  = h('tbody');

    if (node.type === 'ChargingStation') {
        table.append(h('thead', null, h('tr', null, h('th', null, 'EVSE'), h('th', null, 'Power'), h('th', null, 'Current'), h('th', null, 'Connectors'), h('th', null, 'Tariffs'), h('th', null, 'Status'))));
        for (const child of node.children) {
            const evse = child.json;
            const row  = h('tr', 'clickable',
                h('td', null, h('code', null, child.id)),
                h('td', 'nowrap', kW(evse['maxPower'])),
                h('td', null, isArray(evse['currentTypes']) ? evse['currentTypes'].join(', ') : '—'),
                h('td', null, isArray(evse['chargingConnectors']) ? evse['chargingConnectors'].map(connector => String(connector['type'])).join(', ') : '—'),
                h('td', null, isArray(evse['chargingTariffIds']) ? evse['chargingTariffIds'].join(', ') : '—'),
                h('td', null, statusBadge(runtime, 'EVSE', child.id) ?? '—'));
            row.addEventListener('click', () => onSelect(child));
            body.append(row);
        }
    }
    else {
        table.append(h('thead', null, h('tr', null, h('th', null, 'Charging station'), h('th', 'num', 'EVSEs'), h('th', null, 'Power together'), h('th', null, 'Templates of its EVSEs'))));
        for (const child of node.children) {
            const evses = child.children.map(item => item.json);
            const total = evses.reduce((sum, evse) => sum + (evse['maxPower'] !== undefined ? Number(jsonText(evse['maxPower'])) : 0), 0);
            const row   = h('tr', 'clickable',
                h('td', null, h('code', null, child.id)),
                h('td', 'num', evses.length),
                h('td', 'nowrap', total ? `${(total / 1000).toLocaleString('en')} kW` : '—'),
                h('td', null, [ ...new Set(evses.flatMap(evse => isArray(evse['templateIds']) ? evse['templateIds'] : [])) ].join(', ') || '—'));
            row.addEventListener('click', () => onSelect(child));
            body.append(row);
        }
    }

    table.append(body);
    return h('div', null, h('h3', null, node.type === 'ChargingStation' ? 'Its EVSEs' : 'Its charging stations'), table);

}

function tariffsOfEvse(effectiveContent, path, evse) {
    const ids = isArray(evse['chargingTariffIds']) ? evse['chargingTariffIds'].map(String) : [];
    if (ids.length === 0)
        return null;
    const operator = entityAt(effectiveContent, path.slice(0, 1));
    const tariffs  = isArray(operator?.['chargingTariffs']) ? operator['chargingTariffs'] : [];
    const list = h('div', 'tariffs');
    for (const id of ids) {
        const tariff = tariffs.find(item => String(item['@id']) === id);
        if (tariff === undefined) {
            list.append(h('div', null, h('code', null, id), h('span', 'muted', ' — not given')));
            continue;
        }
        list.append(h('div', 'tariff', h('code', null, id), i18n(tariff['name']) ? ` · ${i18n(tariff['name'])}` : '', tariff['currency'] ? ` · ${tariff['currency']}` : '',
                      priceSummary({ prices: [ { chargingTariffId: id, elements: tariff['elements'] } ] })));
    }
    return list;
}

function groupsOf(content, path, type, id) {
    const operator = path[0]?.array === 'chargingStationOperators' ? entityAt(content, path.slice(0, 1)) : undefined;
    if (operator === undefined)
        return [];
    const member = { EVSE: [ 'EVSEGroups', 'EVSEIds' ], ChargingStation: [ 'chargingStationGroups', 'chargingStationIds' ], ChargingPool: [ 'chargingPoolGroups', 'chargingPoolIds' ], ChargingTariff: [ 'chargingTariffGroups', 'chargingTariffIds' ] }[type];
    if (member === undefined)
        return [];
    const groups = isArray(operator[member[0]]) ? operator[member[0]] : [];
    return groups.filter(group => isArray(group[member[1]]) && group[member[1]].map(String).some(item => item.toUpperCase() === id.toUpperCase()));
}

function historyList(report, node, actions) {

    const templateIds = isArray(node.json['templateIds']) ? node.json['templateIds'].map(String) : [];
    const entries     = entityHistory(report, node.type, node.id, templateIds);

    if (entries.length === 0)
        return h('p', 'muted', node.type === 'RoamingNetwork' ? 'Every commit changes the roaming network: see the history.' : 'No commit the history took changed it: it was there from the start.');

    const list = h('ol', 'entity-history');

    for (const { step, changes } of entries) {
        const epoch = report.epochs.find(item => item.number === step.epoch);
        const index = epoch.steps.indexOf(step);
        list.append(h('li', null,
            linkButton(`Epoch ${step.epoch} · revision ${step.revision}`, () => actions.showStep(step.epoch, index)), ' ',
            h('span', 'muted', formatTime(step.changeSet.createdAt)), ' — ', step.changeSet.description ?? '',
            h('div', 'chips', ...changes.map(({ change, how }) => h('span', 'chip-with-note', changeChip(change),
                how === 'template' ? h('span', 'muted small', ' a template it names') : how !== 'direct' ? h('span', 'muted small', ` ${how} it`) : null)))));
    }

    return list;

}

function merklePanel(version, node) {

    const holder = h('div', 'merkle');
    const algorithm = version.network.treeHashAlgorithms[0] ?? 'sha256';

    if (node.type === 'RoamingNetworkOperator') {
        holder.append(h('p', 'muted', 'The roaming network operator is part of the skeleton of the roaming network itself: it has no leaf of its own.'));
        return holder;
    }

    const show = () => {

        const started = performance.now();
        const result  = merklePath(version.network.effectiveContent, node.path, algorithm);
        const millis  = Math.round(performance.now() - started);

        if (result === undefined) {
            holder.replaceChildren(h('p', 'muted', 'No path: this entity is not part of the effective tree.'));
            return;
        }

        const expected = version.commit.eTags.find(eTag => eTag.format === 'effectiveTree' && eTag.algorithm === algorithm);
        const same     = expected !== undefined && etagToText(expected).endsWith(result.root);

        const table = h('table', 'grid merkle-levels');
        table.append(h('thead', null, h('tr', null, h('th', null, 'Level'), h('th', null, 'Child array'), h('th', 'num', 'Index'), h('th', 'num', 'Size'), h('th', null, 'Digest of the entity'), h('th', null, 'Audit path'), h('th', null, 'Root of the array'))));
        const body = h('tbody');

        for (const level of [ ...result.levels ].reverse())
            body.append(h('tr', null,
                h('td', null, h('code', null, level.id), h('div', 'muted small', typeLabel(level.type))),
                h('td', null, h('code', null, level.array)),
                h('td', 'num', level.index),
                h('td', 'num', level.size),
                h('td', null, shortId(level.digest, 12)),
                h('td', null, level.auditPath.length ? h('div', 'stack', ...level.auditPath.map(hash => shortId(hash, 12))) : h('span', 'muted', 'empty')),
                h('td', null, shortId(level.root, 12), ' ', level.matches ? badge('✓', 'ok', 'The root calculated from the digest and its audit path is the root of the array') : badge('✗', 'error'))));

        table.append(body);

        holder.replaceChildren(
            h('p', null, `Bottom-up, as a verifier calculates it from a proof (8.4): the digest of each entity is H(0x00 ‖ canonical JSON of its skeleton), its audit path leads to the root of its array (RFC 9162), and that root is part of the skeleton of its parent.`),
            table,
            h('div', `merkle-root ${same ? 'ok' : 'error'}`,
                h('div', null, h('strong', null, 'Root of the effective tree: '), h('code', null, result.root)),
                h('div', null, h('strong', null, `effectiveTree ETag of the commit (${algorithm}): `), h('code', null, expected ? etagToText(expected) : 'none')),
                h('div', null, same ? badge('the same: this entity, as it is here, is part of the version the commit names', 'ok') : badge('they differ', 'error'))),
            h('p', 'muted small', `${plural(result.levels.reduce((sum, level) => sum + level.auditPath.length, 0), 'audit path hash', 'audit path hashes')} in all; calculated from the whole version in ${millis} ms.`),
            h('details', 'raw', h('summary', null, 'The skeleton of the entity, whose digest is its leaf'), jsonView(result.skeleton, { open: 1 })));

    };

    holder.append(button(`Calculate the path to the root (${algorithm})`, show, 'small'));
    return holder;

}

function entityDetail(report, version, node, mode, runtime, actions, onSelect) {

    const effective = version.network.effectiveContent;
    const stored    = version.network.content;
    const json      = node.json;
    const origin    = mode === 'effective' && [ 'EVSE', 'ChargingStation', 'ChargingPool', 'ChargingTariff' ].includes(node.type)
                          ? provenance(stored, node.path, node.type, json)
                          : undefined;

    const breadcrumb = h('div', 'breadcrumb');
    let current = node.parent;
    const parents = [];
    while (current) {
        parents.unshift(current);
        current = current.parent;
    }
    for (const parent of parents) {
        breadcrumb.append(linkButton(parent.id, () => onSelect(parent)), h('span', 'muted', ' › '));
    }
    breadcrumb.append(h('span', null, node.id));

    const fromTemplates = origin ? [ ...origin.properties.values() ].filter(item => item.source === 'template' || item.source === 'merged').length : 0;
    const groups        = groupsOf(stored, node.path, node.type, node.id);
    const statusEntries = runtime && [ 'ChargingPool', 'ChargingStation', 'EVSE' ].includes(node.type)
                              ? [ 'status', 'adminStatus', 'energyStatus', 'priceStatus' ].map(kind => [ kind, runtime.status.get(node.type, node.id, kind) ]).filter(([ , entry ]) => entry !== undefined)
                              : [];

    const detail = h('div', 'detail',
        breadcrumb,
        h('div', 'detail-head',
            h('div', 'muted', typeLabel(node.type)),
            h('h2', null, node.id, i18n(json['name']) && i18n(json['name']) !== node.id ? h('span', 'thin', ` · ${i18n(json['name'])}`) : null),
            h('div', 'badges',
                fromTemplates > 0 ? badge(`${fromTemplates} propert${fromTemplates === 1 ? 'y' : 'ies'} from templates`, 'info') : null,
                isArray(json['templateIds']) ? badge(`templates: ${json['templateIds'].join(', ')}`, 'info') : null,
                statusBadge(runtime, node.type, node.id))),
        childSummary(node),
        node.type === 'RoamingNetworkOperator' ? h('p', 'note', 'Its keys, key statement and certificates are shown in the trust view.', ' ', linkButton('Trust →', () => actions.switchTab('trust'))) : null,
        mode === 'effective' ? childTable(node, runtime, onSelect) : null,

        h('h3', null, mode === 'effective' ? 'Properties, effective' : 'Properties, as stored'),
        propertyTable(json, origin, mode),
        origin ? h('p', 'note', 'The effective member takes, of every property a template may give, its own value, else the one of the first of its templates giving one; arrays are united (9.2). Proofs and apps see the effective member.') : null,

        node.type === 'EVSE' && mode === 'effective' ? h('div', null, h('h3', null, 'Charging tariffs it takes'), tariffsOfEvse(effective, node.path, json) ?? h('p', 'muted', 'none')) : null,

        groups.length ? h('div', null, h('h3', null, 'Member of'), h('div', 'chips', ...groups.map(group => h('span', 'chip', `${String(group['@id'])}${i18n(group['name']) ? ' · ' + i18n(group['name']) : ''}`))),
                          h('p', 'note', 'Groups name members and give them nothing: no effective value depends on a group (9.3).')) : null,

        statusEntries.length ? h('div', null, h('h3', null, 'Runtime status'),
            facts(statusEntries.map(([ kind, entry ]) => [ kind, h('span', null, h('code', null, jsonText(entry.value)), h('span', 'muted', ` at ${formatTime(entry.timestamp)}`)) ])),
            h('p', 'note', 'From the snapshot beside this version: unsigned, as trustworthy as the server telling it, and no part of the version (12.5).')) : null,

        papersSection(report, node, actions),

        h('h3', null, 'Commits that changed it'),
        historyList(report, node, actions),

        mode === 'effective' && node.type !== 'RoamingNetwork' ? h('div', null, h('h3', null, 'Its path to the root of the effective tree'), merklePanel(version, node)) : null,

        h('details', 'raw', h('summary', null, mode === 'effective' ? 'Effective JSON' : 'Stored JSON'), jsonView(json, { open: 1 })),
        mode === 'effective' && origin ? h('details', 'raw', h('summary', null, 'Stored JSON (as the change sets wrote it)'), jsonView(origin.stored, { open: 1 })) : null,
    );

    return detail;

}

/** The QI-Digital papers of an EVSE's energy meter or of a charging station: its calibration, the certificates covering it. */
function papersSection(report, node, actions) {

    if (node.type !== 'EVSE' && node.type !== 'ChargingStation')
        return null;

    const papers = papersOf(report, node.type, node.id);

    if (papers.length === 0)
        return null;

    return h('div', null,
        h('h3', null, node.type === 'EVSE' ? 'Papers of its energy meter (QI-Digital)' : 'Its papers (QI-Digital)'),
        h('ul', 'statements', ...papers.map(result => h('li', null,
            result.ok === true ? badge('verified', 'ok') : result.ok === false ? badge('refused', 'error') : badge('not checked', 'warn'), ' ',
            `${QI_DIGITAL_KINDS[result.kind]} `, h('code', null, result.doc?.id ?? result.document.name),
            result.kind === 'calibrationCertificate' && result.doc
                ? h('span', 'muted', ` by ${result.doc.calibrationLaboratoryId}, ${result.doc.passes ? 'every point passes' : 'not every point passes'}${result.doc.recalibrationDue !== undefined ? `, due ${formatTime(result.doc.recalibrationDue)}` : ''}`)
                : result.doc ? h('span', 'muted', ` by ${result.doc.conformityAssessmentBodyId ?? ''}, module ${result.doc.module ?? '?'}`) : null))),
        h('div', 'card-actions', linkButton('All QI-Digital papers →', () => actions.switchTab('proofs'))));

}

function networkSummary(version) {
    const network = version.network;
    const content = network.content;
    return h('div', 'detail',
        h('div', 'detail-head', h('div', 'muted', 'roaming network'), h('h2', null, network.id, i18n(network.name) ? h('span', 'thin', ` · ${i18n(network.name)}`) : null)),
        facts([
            [ 'Description', i18n(network.description) ],
            [ 'Operator', network.operator ? `${network.operator.id}${i18n(get(network.operator.json, 'name')) ? ' · ' + i18n(get(network.operator.json, 'name')) : ''}` : undefined ],
            [ 'Created', formatTime(get(content, 'created')) ],
            [ 'Last change', formatTime(get(content, 'lastChange')) ],
            [ 'Revision', `${version.revision} of epoch ${version.epoch}` ],
            [ 'json ETag', h('code', null, etagToText(jsonETag(content))) ],
        ]),
        h('p', 'note', 'Choose an entity in the tree or on the map.'));
}


export function renderNetwork(container, state, actions) {

    const report = state.report;
    const key    = state.selection.version && report.versions.has(state.selection.version) ? state.selection.version : headKey(report);

    if (key === undefined) {
        container.append(section('Network', emptyState('No version was taken.', 'Load a snapshot or a history to explore a network.')));
        return;
    }

    state.selection.version = key;

    const version = report.versions.get(key);
    const mode    = state.selection.networkMode ?? 'effective';
    let content;

    try {
        content = mode === 'effective' ? version.network.effectiveContent : version.network.content;
    }
    catch (e) {
        container.append(section('Network', h('p', 'error-text', `The effective content of this version can not be calculated: ${e.message}`)));
        return;
    }

    const tree    = entityTree(content);
    const runtime = runtimeOf(report, version);

    let selected = state.selection.entity ? tree.index.get(`${state.selection.entity.type}:${state.selection.entity.id}`) : undefined;
    if (selected === undefined && state.selection.entity?.path) {
        const json = entityAt(content, state.selection.entity.path);
        if (json)
            selected = tree.index.get(`${state.selection.entity.type}:${String(json['@id'])}`);
    }

    let map;

    // Selecting an entity changes the tree, the details and the marker, not the whole view: the map keeps where it is.
    const select = (node) => {
        state.selection.entity = { type: node.type, id: node.id, path: node.path };
        selected = node;
        renderTree();
        renderDetail();
        map?.highlight(node.path);
        const top = right.getBoundingClientRect().top;
        if (top < 0)
            window.scrollBy({ top: top - 56 });
    };

    // The toolbar.
    const modeSwitch = h('div', 'segmented');
    for (const [ value, label ] of [ [ 'effective', 'Effective' ], [ 'stored', 'As stored' ] ]) {
        const item = button(label, () => { state.selection.networkMode = value; actions.render(); }, value === mode ? 'active' : '');
        item.title = value === 'effective' ? 'As proofs and apps see it: templates resolved, the tariffs of each EVSE (8.1, 9.2)' : 'As the change sets wrote it, what the json and cbor ETags hash (2)';
        modeSwitch.append(item);
    }

    const search = h('input', 'filter');
    search.type = 'search';
    search.placeholder = 'Search an id or name …';
    search.value = state.selection.networkSearch ?? '';

    const versionPicker = versionSelect(report, key, (value) => { state.selection.version = value; actions.render(); });

    container.append(h('div', 'toolbar network-toolbar',
        h('label', null, 'Version ', versionPicker),
        modeSwitch,
        runtime ? badge(`runtime status of ${formatTime(runtime.timestamp)}`, 'info', 'This version has a snapshot with runtime status beside it') : null));

    map = mapView(content, tree, selected?.path, select);
    if (map)
        container.append(map.element);

    const left  = h('div', 'network-left', search);
    const right = h('div', 'network-right');

    const treeHolder = h('div', 'tree-holder');
    left.append(treeHolder);

    function renderTree() {
        const query = search.value.trim();
        treeHolder.replaceChildren(query ? searchResults(tree, query, select) : treeView(tree, selected ? `${selected.type}:${selected.id}` : undefined, runtime, select));
    }

    function renderDetail() {
        if (selected === undefined && state.selection.entity !== undefined)
            right.replaceChildren(emptyState(`${state.selection.entity.id} is not part of this version.`, 'It was added later, or removed before.'));
        else if (selected === undefined || selected.type === 'RoamingNetwork')
            right.replaceChildren(networkSummary(version));
        else
            right.replaceChildren(entityDetail(report, version, selected, mode, runtime, actions, select));
    }

    search.addEventListener('input', () => {
        state.selection.networkSearch = search.value;
        renderTree();
    });

    renderTree();
    renderDetail();

    container.append(h('div', 'network-layout', left, right));

}
