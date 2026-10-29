/*
 * A stand-in for a POI_API server, for trying the validator's "Load from its servers" without a server of WWCP_POI:
 * it serves the documents of a demo below the paths POI_API serves them (README of WWCP_POI, specification 10.5, 10.6,
 * 11.5, 12.5), with CORS, so that a page of another origin may read them.
 *
 *   node tools/mock-poi-server.mjs [demo] [port] [heavy reads per minute]    e.g.  node tools/mock-poi-server.mjs qa 8139
 *
 * With a number of heavy reads per minute it limits them as POI3 does (specification 5.5): snapshots, pages of commits
 * and archive segments beyond it are answered with 429 and Retry-After, to see the validator wait and ask again.
 *
 * It replays the history of the demo with WWCP_POI.TS once, to have the version of every checkpoint as a snapshot, and
 * prints the trust anchor naming its own URL. It answers only what the demo recorded: it is no implementation of POI,
 * it signs nothing, and it does not check what it serves — the validator does.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as POI from '@open-charging-cloud/wwcp-poi';

import { DocumentPool } from '../src/documents.js';


const demo   = process.argv[2] ?? 'qa';
const port   = Number(process.argv[3] ?? 8139);
const limit  = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const folder = join(import.meta.dirname, '..', 'demo', demo);

const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
const pool     = new DocumentPool();

for (const file of manifest.files)
    pool.addText(file.path, readFileSync(join(folder, file.path), 'utf8'), 'demo');

const anchorOfDemo = POI.TrustAnchor.parse(manifest.trustAnchor);
const networkId    = anchorOfDemo.id;
const base         = `/RNs/${encodeURIComponent(networkId)}`;
const ownURL       = `http://localhost:${port}${base}`;
const anchor       = POI.TrustAnchor.create(networkId, [ ownURL ], anchorOfDemo.keys, anchorOfDemo.minConsensus, anchorOfDemo.name, anchorOfDemo.description);


//  ------------------------------------------------------------------
//  What the demo holds, by epoch: commits, checkpoints, the version of each commit
//  ------------------------------------------------------------------

const commits     = new Map();
const checkpoints = new Map();

for (const document of pool.ofType('commit', 'commits'))
    for (const json of document.type === 'commit' ? [ document.json ] : document.json)
        commits.set(String(json['@id']), json);

for (const document of pool.ofType('checkpoint', 'checkpoints'))
    for (const json of document.type === 'checkpoint' ? [ document.json ] : document.json)
        checkpoints.set(String(json['@id']), json);

const epochs = new Map();   // number → { history, checkpoints: [], commits: [] }

const genesisSnapshots = pool.ofType('snapshot').filter(document => document.json['commit']?.['revision'] === 0).sort((left, right) => (left.json['epoch']?.['epoch'] ?? 1) - (right.json['epoch']?.['epoch'] ?? 1));

// A stand-in checks nothing: it takes the genesis unanchored, and the signatures as they are. The validator checks them.
const unchecked = { verifyCommit: () => {}, verifyCheckpoint: () => {} };

let history = POI.History.fromSnapshot(genesisSnapshots[0].json, { ...unchecked, unanchored: true });

for (;;) {

    const number = history.epoch.number;
    const entry  = { history, profiles: history.epoch.profiles.toJSON(), checkpoints: [], commits: [] };
    epochs.set(number, entry);

    // Parent by parent from the root, every checkpoint after its commit.
    let head = history.root.commit.id;

    for (;;) {
        for (const checkpoint of [ ...checkpoints.values() ].filter(item => item['commitId'] === head).sort((left, right) => left['sequence'] - right['sequence'])) {
            history.takeCheckpoint(checkpoint);
            entry.checkpoints.push(checkpoint);
        }
        const next = [ ...commits.values() ].find(item => item['parentIds']?.[0] === head);
        if (next === undefined || history.finalCheckpoint !== undefined)
            break;
        history.append(next);
        entry.commits.push(next);
        head = String(next['@id']);
    }

    if (history.finalCheckpoint === undefined)
        break;

    history = history.startNextEpoch();

}

const current = Math.max(...epochs.keys());

const epochJSON = (number) => {
    const entry = epochs.get(number);
    const final = entry.history.finalCheckpoint;
    return {
        epoch:     number,
        profiles:  entry.profiles,
        status:    entry.history.epochStatus,
        ...(entry.history.previousEpoch ? { previous: { epoch: entry.history.previousEpoch.epoch, checkpointId: entry.history.previousEpoch.checkpointId } } : {}),
        ...(final ? { finalCheckpointId: final.id } : {}),
    };
};

const snapshotOf = (version, extra = {}) => ({ commit: version.commit.json, roamingNetwork: version.network.content, ...extra });

const runtimeStatus = pool.ofType('snapshot').map(document => document.json['runtimeStatus']).find(Boolean);

const priceStatements = pool.ofType('priceStatements').flatMap(document => POI.isArray(document.json) ? document.json : document.json['priceStatements']);

function currentStatements() {
    const latest = new Map();
    for (const statement of priceStatements) {
        const key = `${statement['entityType']}:${statement['entityId']}`;
        if ((latest.get(key)?.['sequence'] ?? -1) < statement['sequence'])
            latest.set(key, statement);
    }
    return [ ...latest.values() ];
}

function proofOf(kind, id) {
    for (const document of pool.ofType('stationProof')) {
        const operators = document.json['roamingNetwork']?.['chargingStationOperators']?.['@leaves'] ?? [];
        for (const operatorLeaf of operators)
            for (const poolLeaf of operatorLeaf['@entity']?.['chargingPools']?.['@leaves'] ?? [])
                for (const stationLeaf of poolLeaf['@entity']?.['chargingStations']?.['@leaves'] ?? []) {
                    const station = stationLeaf['@entity'];
                    if (kind === 'CSs' ? station['@id'] === id : (station['EVSEs'] ?? []).some(evse => evse['@id'] === id))
                        return { proof: document.json, station, poolId: poolLeaf['@entity']['@id'] };
                }
    }
    return undefined;
}


//  ------------------------------------------------------------------
//  The routes
//  ------------------------------------------------------------------

function route(path, query) {

    if (!path.startsWith(base))
        return path === '/' || path === '' ? [ 200, { trustAnchor: anchor.toURL(), qrCode: anchor.toQRCode(), roamingNetwork: ownURL } ] : [ 404, { description: `Only ${base} is served here.` } ];

    const rest = path.slice(base.length) || '/';
    let match;

    if (rest === '/trustAnchor')
        return [ 200, { roamingNetworkId: networkId, identityKeyIds: anchor.keys, minConsensus: anchor.minConsensus, uri: anchor.toURL(), qrCode: anchor.toQRCode(), trustAnchor: anchor.toJSON() } ];

    if (rest === '/history/epoch')
        return [ 200, epochJSON(current) ];

    if (rest === '/history/epochs')
        return [ 200, [ ...epochs.keys() ].sort().map(epochJSON) ];

    if ((match = /^\/history\/epochs\/(\d+)\/checkpoints$/.exec(rest)))
        return epochs.has(Number(match[1])) ? [ 200, epochs.get(Number(match[1])).checkpoints ] : [ 404, { description: `No epoch ${match[1]} here.` } ];

    if ((match = /^\/history\/epochs\/(\d+)\/commits\/([0-9a-f]+)$/.exec(rest))) {
        const commit = epochs.get(Number(match[1]))?.history.versionOf(match[2])?.commit.json ?? commits.get(match[2]);
        return commit ? [ 200, commit ] : [ 404, { description: `The commit '${match[2]}' is unknown in the epoch ${match[1]}!` } ];
    }

    if (rest === '/history/checkpoints')
        return [ 200, epochs.get(current).checkpoints ];

    if ((match = /^\/history\/checkpoints\/([0-9a-f]+)\/snapshot$/.exec(rest))) {
        for (const entry of epochs.values()) {
            const checkpoint = entry.checkpoints.find(item => item['@id'] === match[1]);
            const version    = checkpoint && entry.history.versionOf(checkpoint['commitId']);
            if (version)
                return [ 200, snapshotOf(version, { checkpoint, ...(entry.history.epoch.number > 1 ? { epoch: epochJSON(entry.history.epoch.number) } : {}) }) ];
        }
        return [ 404, { description: `The checkpoint '${match[1]}' is unknown here!` } ];
    }

    if ((match = /^\/history\/checkpoints\/([0-9a-f]+)\/priceStatements$/.exec(rest))) {
        const json = checkpoints.get(match[1]);
        if (json === undefined)
            return [ 404, { description: `The checkpoint '${match[1]}' is unknown here!` } ];
        const checkpoint = POI.Checkpoint.parse(json);
        if (checkpoint.priceStatements === undefined)
            return [ 200, { priceStatements: [] } ];
        // The list of the demo whose tree is the one the checkpoint names.
        for (const document of pool.ofType('priceStatements')) {
            const list = POI.isArray(document.json) ? document.json : document.json['priceStatements'];
            const { root, size } = POI.priceStatementsRoot(POI.parsePriceStatements(list), checkpoint.identificationHash);
            if (size === checkpoint.priceStatements.size && POI.toHex(root) === POI.toHex(checkpoint.priceStatements.root))
                return [ 200, { priceStatements: list } ];
        }
        return [ 404, { description: 'The demo did not record the price statements of this checkpoint.' } ];
    }

    if (rest === '/history/snapshot') {
        const entry = epochs.get(current);
        return [ 200, snapshotOf(entry.history.head, { ...(current > 1 ? { epoch: epochJSON(current) } : {}), ...(query.get('runtimeStatus') !== 'false' && runtimeStatus ? { runtimeStatus } : {}), timestamp: new Date().toISOString() }) ];
    }

    if (rest === '/history/commits') {
        const list  = epochs.get(current).commits;
        const since = query.get('since');
        const max   = Math.min(Number(query.get('max') ?? 1000), 1000);
        const from  = since ? list.findIndex(item => item['@id'] === since) + 1 : 0;
        if (since && from === 0 && epochs.get(current).history.root.commit.id !== since)
            return [ 404, { description: `The commit '${since}' is unknown here!` } ];
        return [ 200, list.slice(from, from + max) ];
    }

    if (rest === '/history/archive') {
        const document = pool.ofType('archiveSegments')[0];
        return document ? [ 200, document.json ] : [ 200, [] ];
    }

    if ((match = /^\/history\/archive\/(\d+)$/.exec(rest))) {
        const document = pool.ofType('archiveSegment').find(item => String(item.json['info']?.['number']) === match[1]);
        return document ? [ 200, document.json ] : [ 404, { description: `No archive segment ${match[1]}.` } ];
    }

    if (rest === '/attestations') {
        const document = pool.ofType('attestations')[0];
        return [ 200, { attestations: document ? (POI.isArray(document.json) ? document.json : document.json['attestations']) : [] } ];
    }

    if (rest === '/history/priceStatements')
        return [ 200, { priceStatements: currentStatements() } ];

    if ((match = /^\/(EVSEs|CSs)\/([^/]+)\/(proof|priceStatements)$/.exec(rest))) {
        const id    = decodeURIComponent(match[2]);
        const found = proofOf(match[1], id);
        if (found === undefined)
            return [ 404, { description: `No proof of '${id}' was recorded.` } ];
        if (match[3] === 'proof')
            return [ 200, found.proof ];
        const ids = new Set([ found.poolId, found.station['@id'], ...(found.station['EVSEs'] ?? []).map(evse => evse['@id']) ]);
        return [ 200, { priceStatements: priceStatements.filter(statement => ids.has(statement['entityId'])) } ];
    }

    return [ 404, { description: `${rest} is not served by this stand-in.` } ];

}


//  ------------------------------------------------------------------
//  The heavy reads (5.5): a bucket of `limit` reads, filled again within a minute
//  ------------------------------------------------------------------

const isHeavy = (path) => /\/history\/(snapshot|commits|archive\/\d+|checkpoints\/[0-9a-f]+\/snapshot)$/.test(path);

let tokens = limit;
let filled = Date.now();

/** The seconds to wait for the next heavy read, or 0 where one is taken now. */
function takeHeavyRead() {
    const now = Date.now();
    tokens = Math.min(limit, tokens + (now - filled) * limit / 60_000);
    filled = now;
    if (tokens >= 1) {
        tokens--;
        return 0;
    }
    return Math.max(1, Math.ceil((1 - tokens) * 60 / limit));
}


createServer((request, response) => {

    const url = new URL(request.url ?? '/', `http://localhost:${port}`);

    const headers = {
        'Access-Control-Allow-Origin':   '*',
        'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers':  'Accept',
        'Cache-Control':                 'no-store',
    };

    if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
        return;
    }

    let status;
    let body;

    // Retry-After is not exposed to other origins (Access-Control-Expose-Headers), as POI_API does not either: a page
    // reads the seconds from the description.
    const wait = limit !== undefined && isHeavy(url.pathname) ? takeHeavyRead() : 0;

    if (wait > 0) {
        response.writeHead(429, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(wait) });
        response.end(JSON.stringify({ description: `Too many heavy reads: try again in ${wait} seconds!` }));
        console.log(`${request.method} ${url.pathname}${url.search} → 429, try again in ${wait} s`);
        return;
    }

    try {
        [ status, body ] = route(url.pathname, url.searchParams);
    }
    catch (e) {
        [ status, body ] = [ 500, { description: e instanceof Error ? e.message : String(e) } ];
    }

    response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
    response.end(POI.isObject(body) || POI.isArray(body) ? POI.canonicalJSON(body) : JSON.stringify(body));

    console.log(`${request.method} ${url.pathname}${url.search} → ${status}`);

}).listen(port, () => {

    console.log(`A stand-in POI_API server for the demo '${demo}' (${manifest.title}) at ${ownURL}`);
    console.log(`Epochs: ${[ ...epochs.entries() ].map(([ number, entry ]) => `${number} (${entry.commits.length} commits, ${entry.checkpoints.length} checkpoints)`).join(', ')}`);
    if (limit !== undefined)
        console.log(`Heavy reads: ${limit} per minute, beyond them 429`);
    console.log('');
    console.log('Its trust anchor — paste one of these into the validator and press "Load from its servers":');
    console.log('');
    console.log(`  ${anchor.toURL()}`);
    console.log('');
    console.log(`  ${anchor.toQRCode()}`);
    console.log('');

});
