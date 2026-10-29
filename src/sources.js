/*
 * Where documents come from: the demos shipped with the page, files the user drops, and the servers a trust anchor names.
 *
 * Every source only fills the document pool. The servers are asked what POI_API serves (README of WWCP_POI, sections 10.5,
 * 10.6, 11.5 and 12.5 of its specification) - the epochs, their checkpoints, the snapshot to join from, the commits since,
 * the archive, the attestations and the current price statements - and nothing they answer is trusted: the analysis checks
 * it like any file.
 */

import { TrustAnchor, isArray, isObject } from '@open-charging-cloud/wwcp-poi';


/** The demos shipped with the page, below `demo/`. */
export const DEMOS = [
    { id: 'qa',        path: 'demo/qa/manifest.json' },
    { id: 'thuringia', path: 'demo/thuringia/manifest.json' },
];


/** Loads the manifest of a demo; undefined where the demo is not shipped. */
export async function loadDemoManifest(demo) {
    try {
        const response = await fetch(demo.path, { cache: 'no-cache' });
        if (!response.ok)
            return undefined;
        return { ...await response.json(), base: demo.path.replace(/manifest\.json$/, '') };
    }
    catch {
        return undefined;
    }
}

/** Loads the documents of a demo into the pool. */
export async function loadDemo(manifest, pool, onProgress) {

    let done = 0;

    await Promise.all(manifest.files.map(async file => {
        const url = manifest.base + file.path;
        try {
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            file.document = pool.addText(file.path, text, 'demo', { url, description: file.description });
        }
        catch (e) {
            pool.addFailure(file.path, 'demo', e instanceof Error ? e.message : String(e), { url });
        }
        onProgress?.(`Loading the demo: ${++done} of ${manifest.files.length} documents …`, 0.3 * done / manifest.files.length);
    }));

    // In the order of the manifest, which tells the story of the network.
    const order = new Map(manifest.files.map((file, index) => [ file.path, index ]));
    pool.documents.sort((left, right) => (order.get(left.name) ?? 1e9) - (order.get(right.name) ?? 1e9));

}


/** Reads dropped or chosen files into the pool. */
export async function loadFiles(files, pool) {
    const added = [];
    for (const file of files) {
        const text = await file.text();
        added.push(pool.addText(file.name, text, 'file'));
    }
    return added;
}


//  ------------------------------------------------------------------
//  The servers of a trust anchor
//  ------------------------------------------------------------------

const MAX_COMMITS = 5000;

// A server may limit the heavy reads of a client, and answers one beyond with 429 and Retry-After (5.5): the page waits
// as long as told, a minute at most at a time, and asks again, up to six times.
const MAX_ASKED = 6;
const MAX_WAIT  = 60;

/**
 * The seconds a server answering 429 asks to wait: its Retry-After, in seconds or as a date. A page of another origin
 * reads that header only where the server exposes it (Access-Control-Expose-Headers); otherwise the seconds its
 * description names, as POI3 words it ("Too many heavy reads: try again in 7 seconds!").
 */
function retryAfterOf(response, body) {

    const header = response.headers.get('Retry-After')?.trim();

    if (header) {
        if (/^\d+$/.test(header))
            return Number(header);
        const date = Date.parse(header);
        if (!Number.isNaN(date))
            return Math.max(1, Math.ceil((date - Date.now()) / 1000));
    }

    const named = /try again in (\d+) seconds?/i.exec(body);
    return named ? Number(named[1]) : undefined;

}

/** Waits the given seconds, telling each one that is left. */
async function waitSeconds(seconds, signal, onSecond) {
    for (let left = seconds; left > 0; left--) {
        onSecond(left);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 1000);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
    }
}

/**
 * Asks the servers of the trust anchor, the preferred one first, for what the analysis needs. A server that does not
 * answer, or answers something else, is just one more document that did not load; the next one is asked only when the
 * first gave nothing at all.
 */
export async function loadFromServers(trustAnchorText, pool, { onProgress, signal, stationIds = [] } = {}) {

    const text   = trustAnchorText.trim();
    const anchor = text.startsWith('{') ? TrustAnchor.fromJSON(JSON.parse(text)) : TrustAnchor.parse(text);
    const errors = [];

    for (const url of anchor.urls) {

        const base   = url.replace(/\/+$/, '');
        let answered = 0;

        const get = async (path, label, { optional = false } = {}) => {

            const target = base + path;
            onProgress?.(`GET ${path} …`, undefined);

            try {
                for (let asked = 1; ; asked++) {

                    const response = await fetch(target, { headers: { Accept: 'application/json' }, signal, cache: 'no-store' });
                    const body     = await response.text();

                    if (response.status === 429 && asked < MAX_ASKED) {
                        const seconds = Math.min(retryAfterOf(response, body) ?? 2 ** asked, MAX_WAIT);
                        await waitSeconds(seconds, signal, left => onProgress?.(`GET ${path}: the server asks to wait (429), asking again in ${left} s …`, undefined));
                        continue;
                    }

                    if (!response.ok) {
                        // What is optional may be missing, but not refused for too many reads.
                        if (!optional || response.status === 429)
                            pool.addFailure(label, 'http', `HTTP ${response.status}${body ? ': ' + body.slice(0, 200) : ''}${asked > 1 ? ` (asked ${asked} times)` : ''}`, { url: target });
                        return undefined;
                    }

                    answered++;
                    return pool.addText(label, body, 'http', { url: target });

                }
            }
            catch (e) {
                if (signal?.aborted)
                    throw e;
                pool.addFailure(label, 'http', e instanceof TypeError
                                                   ? `${e.message} — no answer, or the server does not allow this page to read it (CORS: Access-Control-Allow-Origin)`
                                                   : e instanceof Error ? e.message : String(e), { url: target });
                return undefined;
            }

        };

        // The epochs, and the checkpoints of each (11.5).
        const epochsDocument = await get('/history/epochs', 'epochs');
        let epochs = isArray(epochsDocument?.json) ? epochsDocument.json.filter(isObject) : [];

        if (epochs.length === 0) {
            const current = await get('/history/epoch', 'epoch');
            if (isObject(current?.json))
                epochs = [ current.json ];
        }

        if (answered === 0) {
            errors.push(`${base}: no answer`);
            continue;
        }

        const current = epochs.reduce((latest, epoch) => Number(epoch['epoch']) > Number(latest?.['epoch'] ?? 0) ? epoch : latest, undefined);
        const checkpointsByEpoch = new Map();

        for (const epoch of epochs) {
            const number   = Number(epoch['epoch']);
            const document = await get(`/history/epochs/${number}/checkpoints`, `checkpoints of epoch ${number}`);
            checkpointsByEpoch.set(number, isArray(document?.json) ? document.json.filter(isObject) : []);
        }

        // The price statements each checkpoint names (12.3).
        for (const list of checkpointsByEpoch.values())
            for (const checkpoint of list.filter(item => isObject(item['priceStatements'])))
                await get(`/history/checkpoints/${checkpoint['@id']}/priceStatements`, `price statements of checkpoint ${checkpoint['sequence']} of epoch ${checkpoint['epoch'] ?? 1}`, { optional: true });

        // Closed epochs: the snapshot of their first checkpoint, where the server still serves it, to start them from.
        for (const [ number, list ] of checkpointsByEpoch) {
            const [ earliest ] = [ ...list ].sort((left, right) => Number(left['sequence']) - Number(right['sequence']));
            if (earliest !== undefined && number !== Number(epochs.at(-1)?.['epoch']))
                await get(`/history/checkpoints/${earliest['@id']}/snapshot`, `snapshot of checkpoint ${earliest['sequence']} of epoch ${number}`, { optional: true });
        }

        // The archive (10.6): every segment, its snapshot and the commits dropped after it.
        const segments = await get('/history/archive', 'archive', { optional: true });
        for (const info of isArray(segments?.json) ? segments.json.filter(isObject) : [])
            await get(`/history/archive/${info['number']}`, `archive segment ${info['number']}`);

        // Where to join the current epoch (10.5): the snapshot of its first checkpoint, the head as the last resort.
        const currentNumber      = Number(current?.['epoch'] ?? 1);
        const currentCheckpoints = checkpointsByEpoch.get(currentNumber) ?? [];
        const [ first ]          = [ ...currentCheckpoints ].sort((left, right) => Number(left['sequence']) - Number(right['sequence']));

        if (first !== undefined)
            await get(`/history/checkpoints/${first['@id']}/snapshot`, `snapshot of checkpoint ${first['sequence']} of epoch ${currentNumber}`);

        await get('/history/snapshot?runtimeStatus=true', 'snapshot of the head');

        // The commits of the current epoch since its root, page by page.
        let since;
        let total = 0;

        for (;;) {
            const page = await get(`/history/commits?max=500${since ? `&since=${since}` : ''}`, since ? `commits since ${since.slice(0, 12)}…` : 'commits since the root');
            const list = isArray(page?.json) ? page.json : [];
            total += list.length;
            onProgress?.(`${total} commits of epoch ${currentNumber} …`, undefined);
            if (list.length === 0 || total >= MAX_COMMITS)
                break;
            since = String(list.at(-1)['@id']);
        }

        // The commits of closed epochs: parent by parent from the commit of their final checkpoint (11.5).
        for (const epoch of epochs.filter(item => Number(item['epoch']) !== currentNumber)) {

            const number = Number(epoch['epoch']);
            const final  = (checkpointsByEpoch.get(number) ?? []).find(item => item['final'] === true) ?? (checkpointsByEpoch.get(number) ?? []).at(-1);
            let   id     = final?.['commitId'];
            let   count  = 0;

            while (typeof id === 'string' && count < MAX_COMMITS) {
                const document = await get(`/history/epochs/${number}/commits/${id}`, `commit ${id.slice(0, 12)}… of epoch ${number}`);
                const parents  = isObject(document?.json) && isArray(document.json['parentIds']) ? document.json['parentIds'] : [];
                id = parents[0];
                count++;
            }

        }

        // What an app sees of the head: the attestations, the current price statements, proofs of the stations asked for.
        await get('/attestations', 'attestations', { optional: true });
        await get('/history/priceStatements', 'current price statements', { optional: true });

        for (const stationId of stationIds) {
            const kind = stationId.split('*').length >= 4 ? 'EVSEs' : 'CSs';
            await get(`/${kind}/${encodeURIComponent(stationId)}/proof`, `proof of ${stationId}`);
            await get(`/${kind}/${encodeURIComponent(stationId)}/priceStatements`, `price statements of ${stationId}`);
        }

        return { anchor, server: base };

    }

    throw new Error(`No server of the trust anchor answered: ${errors.join('; ')}`);

}
