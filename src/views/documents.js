/*
 * The documents: everything that was loaded, what each one is, where it came from, and its JSON as POI reads it. A
 * document can be edited here and verified again: change a price, a power or an identification, and see which check
 * refuses it.
 */

import { badge, button, copyButton, formatBytes, h, jsonView, section } from '../dom.js';


const ORIGINS = { demo: 'demo', file: 'file', http: 'server', paste: 'pasted' };


function editor(document, actions, onCancel) {

    const area = h('textarea', 'editor');
    area.spellcheck = false;
    area.rows = 28;

    // As loaded: reformatting it with JSON.parse would turn 0.50 into 0.5, which is another value to POI (1).
    area.value = document.text;

    return h('div', 'document-editor',
        h('p', 'note', 'Change a value — a price, the power of an EVSE, a timestamp, an identification, a signature — and verify again: the history shows which check refuses it, and why. Nothing leaves your browser.'),
        area,
        h('div', 'toolbar',
            button('Verify with this change', () => actions.replaceDocument(document, area.value), 'primary small'),
            button('Cancel', onCancel, 'small')));

}


export function renderDocuments(container, state, actions) {

    const pool     = state.pool;
    const selected = pool.documents.find(document => document.id === state.selection.document) ?? pool.documents[0];

    const table = h('table', 'grid documents');
    table.append(h('thead', null, h('tr', null, h('th', null, 'Document'), h('th', null, 'From'), h('th', null, 'Kind'), h('th', null, 'What'), h('th', 'num', 'Size'))));
    const body = h('tbody');

    for (const document of pool.documents) {
        const row = h('tr', `clickable${document === selected ? ' selected' : ''}${document.error ? ' failed' : ''}`,
            h('td', null, h('strong', null, document.name), document.edited ? h('span', null, ' ', badge('edited', 'warn')) : null,
                          document.description ? h('div', 'muted small', document.description) : null,
                          document.url && document.origin === 'http' ? h('div', 'muted small url', document.url) : null),
            h('td', null, ORIGINS[document.origin] ?? document.origin),
            h('td', null, document.error ? badge(document.type === 'failed' ? 'not loaded' : 'not JSON', 'error') : document.type === 'unknown' ? badge('unknown', 'warn') : document.label),
            h('td', 'small', document.error ?? document.summary),
            h('td', 'num nowrap', document.size ? formatBytes(document.size) : '—'));
        row.addEventListener('click', () => {
            state.selection.document = document.id;
            container.replaceChildren();
            renderDocuments(container, state, actions);
            container.querySelector('.document-json')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
        body.append(row);
    }

    table.append(body);

    const total = pool.documents.reduce((sum, document) => sum + document.size, 0);

    container.append(section(`Documents (${pool.documents.length}, ${formatBytes(total)})`,
        h('p', 'note', 'Every document is read as POI reads JSON: numbers with a fraction stay decimals as written, strings stay strings — as they are hashed and signed (1). What a document is follows from its JSON-LD context, or from its shape where it names none.'),
        h('div', 'table-scroll', table)));

    if (selected !== undefined && selected.json !== undefined) {

        const content = h('div');
        const show    = () => content.replaceChildren(typeof selected.json === 'string' ? h('pre', 'json', selected.json) : jsonView(selected.json, { open: 2 }));
        const edit    = button('Edit and verify again', () => content.replaceChildren(editor(selected, actions, show)), 'small');

        const panel = section(selected.name,
            h('div', 'toolbar', copyButton(() => selected.text, 'Copy as loaded'), typeof selected.json === 'string' ? null : edit),
            content);

        panel.classList.add('document-json');
        container.append(panel);
        show();

    }

}
