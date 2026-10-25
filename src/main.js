/*
 * WWCP POI Validator
 *
 * One page, three ways in:
 *
 *   Trust anchor   the QR code text, URL or JSON of a roaming network: its servers are asked for the epochs, checkpoints,
 *                  snapshots, commits, archive, attestations and price statements, and all of it is checked from the
 *                  identity keys the trust anchor pins.
 *   Documents      files of any of these kinds, dropped onto the page.
 *   Demos          the recorded run of the WWCP_POI examples, and a generated test network of a federal state.
 *
 * Everything is verified by WWCP_POI.TS, locally in the browser.
 */

import { analyze }                                         from './analyze.js';
import { DocumentPool }                                    from './documents.js';
import { DEMOS, loadDemo, loadDemoManifest, loadFiles, loadFromServers } from './sources.js';
import { $, button, clear, formatTime, h }                 from './dom.js';

import { renderOverview }   from './views/overview.js';
import { renderTrust }      from './views/trust.js';
import { renderHistory }    from './views/history.js';
import { renderNetwork }    from './views/network.js';
import { renderProofs }     from './views/proofs.js';
import { renderDocuments }  from './views/documents.js';


const VIEWS = {
    overview:   renderOverview,
    trust:      renderTrust,
    history:    renderHistory,
    network:    renderNetwork,
    proofs:     renderProofs,
    documents:  renderDocuments,
};

const state = {
    pool:       new DocumentPool(),
    report:     undefined,
    manifest:   undefined,
    tab:        'primer',
    running:    false,
    /** What each view shows, kept while switching tabs. */
    selection: {
        historyStep:  undefined,   // { epoch, index }
        version:      undefined,   // 'epoch:revision'
        entity:       undefined,   // { type, id, path }
        trustVersion: undefined,
        document:     undefined,
    },
};


//  ------------------------------------------------------------------
//  Status and progress
//  ------------------------------------------------------------------

function setStatus(kind, text) {
    const status = $('status');
    status.className = `status ${kind}`;
    status.textContent = text;
}

function setProgress(fraction) {
    const bar = $('progressBar');
    $('progress').hidden = fraction === undefined || fraction >= 1;
    if (fraction !== undefined)
        bar.style.width = `${Math.round(Math.max(0.02, Math.min(1, fraction)) * 100)}%`;
}


//  ------------------------------------------------------------------
//  Settings
//  ------------------------------------------------------------------

function verificationTime() {
    const mode = $('atMode').value;
    if (mode === 'recorded' && state.manifest?.recordedAt)
        return Date.parse(state.manifest.recordedAt);
    if (mode === 'custom' && $('atCustom').value)
        return Date.parse($('atCustom').value + 'Z');
    return undefined;
}

function updateSettingsSummary() {
    const at        = verificationTime();
    const witnesses = (() => { try { return JSON.parse($('witnesses').value || '[]').length; } catch { return '?'; } })();
    $('settingsSummary').textContent = `— as of ${at === undefined ? 'now' : formatTime(at)}, ${witnesses} trusted witness${witnesses === 1 ? '' : 'es'}, ${$('requiredWitnesses').value} required per checkpoint`;
    $('atCustom').hidden = $('atMode').value !== 'custom';
    $('atMode').querySelector('option[value="recorded"]').disabled = !state.manifest?.recordedAt;
}

function readWitnesses() {
    const text = $('witnesses').value.trim();
    if (text === '')
        return [];
    return JSON.parse(text);
}


//  ------------------------------------------------------------------
//  Running the analysis
//  ------------------------------------------------------------------

async function run() {

    if (state.running)
        return;

    if (state.pool.size === 0 && $('trustAnchor').value.trim() === '') {
        setStatus('idle', 'Pick a demo, give a trust anchor, or drop documents.');
        return;
    }

    state.running = true;
    document.body.classList.add('busy');

    let witnesses;

    try {
        witnesses = readWitnesses();
    }
    catch (e) {
        setStatus('error', `The trusted witnesses are no JSON: ${e.message}`);
        state.running = false;
        document.body.classList.remove('busy');
        return;
    }

    const started = performance.now();

    try {

        setProgress(0.02);

        const report = await analyze(state.pool, {
            trustAnchorText:    $('trustAnchor').value,
            at:                 verificationTime(),
            witnesses,
            requiredWitnesses:  Number($('requiredWitnesses').value) || 0,
        }, (text, fraction) => {
            setStatus('working', text);
            if (fraction !== undefined)
                setProgress(fraction);
        });

        state.report = report;
        state.selection.version = undefined;
        state.selection.trustVersion = undefined;

        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        const verdict = report.verdict;

        if (verdict.level === 'ok')
            setStatus('ok', `Verified in ${seconds} s: ${verdict.commits} commits, ${verdict.checkpoints} checkpoints, ${report.proofs.length} proofs — everything holds.`);
        else if (verdict.level === 'warn')
            setStatus('warn', `Checked in ${seconds} s: ${verdict.commits} commits, ${verdict.checkpoints} checkpoints — ${verdict.warnings} warning${verdict.warnings === 1 ? '' : 's'}.`);
        else if (verdict.level === 'error')
            setStatus('error', `Checked in ${seconds} s: ${verdict.errors} problem${verdict.errors === 1 ? '' : 's'} found — see the overview.`);
        else
            setStatus('idle', `Read ${state.pool.size} documents: nothing to verify yet.`);

        enableTabs(true);

        if (state.tab === 'primer')
            switchTab('overview');
        else
            render();

    }
    catch (e) {
        console.error(e);
        setStatus('error', `The analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    finally {
        setProgress(undefined);
        state.running = false;
        document.body.classList.remove('busy');
    }

}


function reset() {
    state.pool     = new DocumentPool();
    state.report   = undefined;
    state.manifest = undefined;
    state.selection = { historyStep: undefined, version: undefined, entity: undefined, trustVersion: undefined, document: undefined };
    enableTabs(false);
    switchTab('primer');
}


//  ------------------------------------------------------------------
//  Sources
//  ------------------------------------------------------------------

async function startDemo(manifest) {

    reset();
    state.manifest = manifest;

    $('trustAnchor').value          = manifest.trustAnchor ?? '';
    $('witnesses').value            = JSON.stringify(manifest.witnesses ?? [], null, 2);
    $('requiredWitnesses').value    = String(manifest.requiredWitnesses ?? 0);
    $('atMode').value               = manifest.recordedAt ? 'recorded' : 'now';
    updateSettingsSummary();

    setStatus('working', `Loading the demo ${manifest.title} …`);
    setProgress(0.02);

    await loadDemo(manifest, state.pool, (text, fraction) => { setStatus('working', text); setProgress(fraction); });
    await run();

}

async function startServers() {

    const text = $('trustAnchor').value.trim();

    if (text === '') {
        setStatus('error', 'Give a trust anchor first: the text of its QR code, its URL or its JSON.');
        return;
    }

    reset();
    $('atMode').value = 'now';
    updateSettingsSummary();

    const stationIds = $('stationIds').value.split(/[\s,;]+/).map(id => id.trim()).filter(Boolean);

    try {
        setProgress(0.02);
        const { server } = await loadFromServers(text, state.pool, { stationIds, onProgress: (line) => setStatus('working', line) });
        setStatus('working', `Loaded ${state.pool.size} documents from ${server} …`);
        await run();
    }
    catch (e) {
        setProgress(undefined);
        setStatus('error', e instanceof Error ? e.message : String(e));
        if (state.pool.size > 0) {
            enableTabs(true);
            switchTab('documents');
        }
    }

}

async function addFiles(files) {

    if (files.length === 0)
        return;

    const added = await loadFiles(files, state.pool);

    // A trust anchor or a list of witnesses among them is configuration: it goes where the user would have put it.
    for (const document of added) {
        if (document.type === 'trustAnchor' && typeof document.json === 'string')
            $('trustAnchor').value = document.json;
        else if (document.type === 'trustAnchor' && document.json?.['qrCode'])
            $('trustAnchor').value = String(document.json['qrCode']);
        else if (document.type === 'witnesses')
            $('witnesses').value = JSON.stringify(document.json, null, 2);
    }

    updateSettingsSummary();
    await run();

}


//  ------------------------------------------------------------------
//  Tabs and views
//  ------------------------------------------------------------------

function enableTabs(enabled) {
    for (const tab of $('tabs').querySelectorAll('button'))
        if (tab.dataset.tab !== 'primer')
            tab.disabled = !enabled;
}

function switchTab(name) {
    state.tab = name;
    for (const tab of $('tabs').querySelectorAll('button')) {
        tab.classList.toggle('active', tab.dataset.tab === name);
        tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    }
    $('primer').hidden = name !== 'primer';
    $('view').hidden   = name === 'primer';
    render();
    // A new view starts at its top, below the tabs, wherever the one before was scrolled to.
    const top = $('tabs').getBoundingClientRect().top + window.scrollY;
    if (window.scrollY > top)
        window.scrollTo({ top });
}

function render() {
    if (state.tab === 'primer' || state.report === undefined)
        return;
    const container = clear($('view'));
    VIEWS[state.tab]?.(container, state, actions);
}

/** What the views may ask for: another tab, a step of the history, a version or an entity of the network. */
const actions = {
    switchTab,
    render,
    showStep(epoch, index) {
        state.selection.historyStep = { epoch, index };
        switchTab('history');
    },
    showVersion(epoch, revision) {
        state.selection.version = `${epoch}:${revision}`;
        switchTab('network');
    },
    showEntity(epoch, revision, entity) {
        state.selection.version = `${epoch}:${revision}`;
        state.selection.entity  = entity;
        switchTab('network');
    },
    showDocument(document) {
        state.selection.document = document.id;
        switchTab('documents');
    },
    async lookupStations(ids) {
        $('stationIds').value = ids.join(', ');
        await startServers();
    },
    async replaceDocument(document, text) {
        state.pool.replaceText(document, text);
        await run();
        switchTab('overview');
    },
};


//  ------------------------------------------------------------------
//  Wiring
//  ------------------------------------------------------------------

async function init() {

    $('appVersion').textContent = __APP_VERSION__;
    $('poiVersion').textContent = __POI_VERSION__;

    for (const tab of $('tabs').querySelectorAll('button'))
        tab.addEventListener('click', () => { if (!tab.disabled) switchTab(tab.dataset.tab); });

    $('loadServers').addEventListener('click', startServers);
    $('verifyButton').addEventListener('click', run);
    $('clearButton').addEventListener('click', () => {
        reset();
        $('trustAnchor').value = '';
        $('witnesses').value = '';
        $('requiredWitnesses').value = '0';
        $('atMode').value = 'now';
        updateSettingsSummary();
        setStatus('idle', 'Pick a demo, give a trust anchor, or drop documents.');
    });

    for (const id of [ 'atMode', 'atCustom', 'requiredWitnesses', 'witnesses' ])
        $(id).addEventListener('change', updateSettingsSummary);

    $('fileInput').addEventListener('change', async (event) => {
        await addFiles([ ...event.target.files ]);
        event.target.value = '';
    });

    const dropZone = $('dropZone');

    for (const name of [ 'dragenter', 'dragover' ])
        document.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });

    for (const name of [ 'dragleave', 'drop' ])
        document.addEventListener(name, (event) => { event.preventDefault(); if (name === 'drop' || event.relatedTarget === null) dropZone.classList.remove('dragging'); });

    document.addEventListener('drop', (event) => addFiles([ ...(event.dataTransfer?.files ?? []) ]));

    updateSettingsSummary();

    // The demos the page ships with.
    const container = $('demoButtons');

    for (const demo of DEMOS) {
        const manifest = await loadDemoManifest(demo);
        if (manifest === undefined)
            continue;
        const item = button(manifest.title, () => startDemo(manifest), 'demo');
        item.title = manifest.description;
        container.append(item);
    }

    if (container.childElementCount === 0)
        container.append(h('span', 'hint', 'none shipped with this build'));

    // ?demo=qa starts a demo right away, e.g. for a link in a README.
    const requested = new URLSearchParams(location.search).get('demo');
    if (requested) {
        const demo = DEMOS.find(item => item.id === requested);
        const manifest = demo ? await loadDemoManifest(demo) : undefined;
        if (manifest)
            await startDemo(manifest);
    }

}

init();
