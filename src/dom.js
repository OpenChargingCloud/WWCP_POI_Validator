/*
 * Small DOM helpers, formatters and the collapsible JSON viewer the views share.
 */

import { canonicalJSON, isArray, isObject, Decimal } from '@open-charging-cloud/wwcp-poi';


export const $ = (id) => document.getElementById(id);

/** An element with a class and children: nodes, texts, numbers; null and undefined are left out, arrays flattened. */
export function h(tag, className, ...children) {
    const element = document.createElement(tag);
    if (className)
        element.className = className;
    append(element, children);
    return element;
}

function append(element, children) {
    for (const child of children) {
        if (child == null || child === false)
            continue;
        if (Array.isArray(child))
            append(element, child);
        else
            element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

/** Sets attributes on an element and returns it, e.g. `attrs(h('a'), { href })`. */
export function attrs(element, attributes) {
    for (const [name, value] of Object.entries(attributes))
        if (value != null && value !== false)
            element.setAttribute(name, value === true ? '' : String(value));
    return element;
}

export function clear(element) {
    while (element.firstChild)
        element.firstChild.remove();
    return element;
}

export function button(label, onClick, className = 'ghost') {
    const element = h('button', className, label);
    element.type = 'button';
    element.addEventListener('click', onClick);
    return element;
}

/** Yields to the browser, so that a long calculation keeps the page responsive and its progress visible. */
export const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));


//  ------------------------------------------------------------------
//  Formatting
//  ------------------------------------------------------------------

export const plural = (count, singular, pluralForm = singular + 's') =>
    `${count.toLocaleString('en')} ${count === 1 ? singular : pluralForm}`;

/** A long identification as its first characters, the whole one as a tooltip. */
export function shortId(id, length = 12) {
    const text = String(id ?? '');
    const span = h('code', 'id', text.length > length + 1 ? text.slice(0, length) + '…' : text);
    span.title = text;
    return span;
}

export function formatTime(value) {
    if (value === undefined || value === null)
        return '—';
    const date = new Date(typeof value === 'number' ? value : Date.parse(value));
    if (Number.isNaN(date.getTime()))
        return String(value);
    return date.toISOString().replace('T', ' ').replace(/\.000Z$/, 'Z').replace(/(\.\d{3})Z$/, '$1Z');
}

export function formatBytes(count) {
    if (count < 1024)
        return `${count} B`;
    if (count < 1024 * 1024)
        return `${(count / 1024).toFixed(1)} KB`;
    return `${(count / 1024 / 1024).toFixed(2)} MB`;
}

/** The first text of an internationalized text object, e.g. `{ "en": "Jena Paradies" }`. */
export function i18n(value) {
    if (typeof value === 'string')
        return value;
    if (isObject(value)) {
        const english = value['en'];
        if (typeof english === 'string')
            return english;
        const first = Object.values(value).find(text => typeof text === 'string');
        if (first !== undefined)
            return first;
    }
    return undefined;
}

/** A JSON value of POI as plain text: decimals as written, objects as canonical JSON. */
export function jsonText(value) {
    if (value === undefined)
        return '—';
    if (value instanceof Decimal)
        return value.toString();
    if (isObject(value) || isArray(value))
        return canonicalJSON(value);
    return String(value);
}

/** A badge: ok, warn, error, info or a neutral one. */
export function badge(text, kind = 'info', title) {
    const element = h('span', `badge ${kind}`, text);
    if (title)
        element.title = title;
    return element;
}

export function statusIcon(ok) {
    return ok === true  ? badge('✓', 'ok')
         : ok === false ? badge('✗', 'error')
         :                badge('–', 'info');
}

/** A definition list of label and value pairs, values left out when undefined. */
export function facts(pairs) {
    const list = h('dl', 'facts');
    for (const [label, value] of pairs) {
        if (value === undefined || value === null)
            continue;
        list.append(h('dt', null, label), h('dd', null, value));
    }
    return list;
}

export function section(title, ...children) {
    return h('section', 'panel', h('div', 'panel-head', h('h2', null, title)), h('div', 'panel-body', ...children));
}


//  ------------------------------------------------------------------
//  The JSON viewer: collapsible, lazy, decimals as written
//  ------------------------------------------------------------------

const MAX_INLINE = 80;

/**
 * A collapsible tree of a JSON value as POI reads it (decimals stay decimals). Children are rendered when expanded, so
 * that documents of hundreds of kilobytes open at once. `open` is how many levels start expanded.
 */
export function jsonView(value, { open = 1, highlight } = {}) {
    const root = h('div', 'json-view');
    root.append(jsonNode(undefined, value, open, '$', highlight));
    return root;
}

function scalar(value) {
    if (value === null)
        return h('span', 'j-kw', 'null');
    if (typeof value === 'boolean')
        return h('span', 'j-kw', String(value));
    if (typeof value === 'number' || typeof value === 'bigint')
        return h('span', 'j-num', String(value));
    if (value instanceof Decimal)
        return h('span', 'j-num', value.toString());
    if (typeof value === 'string')
        return h('span', 'j-str', JSON.stringify(value));
    return h('span', 'j-kw', String(value));
}

function jsonNode(key, value, open, path, highlight) {

    const row      = h('div', 'j-row');
    const keyLabel = key === undefined ? null : h('span', 'j-key', typeof key === 'number' ? `${key}` : JSON.stringify(key));
    const note     = highlight?.(path, value);

    if (!isObject(value) && !isArray(value)) {
        append(row, [ h('span', 'j-toggle-space'), keyLabel, keyLabel ? h('span', 'j-punct', ': ') : null, scalar(value), note ]);
        return row;
    }

    const entries  = isArray(value) ? value.map((item, index) => [ index, item ]) : Object.entries(value);
    const brackets = isArray(value) ? [ '[', ']' ] : [ '{', '}' ];

    if (entries.length === 0) {
        append(row, [ h('span', 'j-toggle-space'), keyLabel, keyLabel ? h('span', 'j-punct', ': ') : null, h('span', 'j-punct', brackets.join('')), note ]);
        return row;
    }

    const toggle   = h('button', 'j-toggle', '▸');
    toggle.type    = 'button';
    const summary  = h('span', 'j-summary', preview(value, entries.length));
    const children = h('div', 'j-children');
    let rendered   = false;

    const setOpen = (expanded) => {
        if (expanded && !rendered) {
            for (const [childKey, child] of entries)
                children.append(jsonNode(childKey, child, open - 1, `${path}${typeof childKey === 'number' ? `[${childKey}]` : `.${childKey}`}`, highlight));
            children.append(h('div', 'j-row', h('span', 'j-toggle-space'), h('span', 'j-punct', brackets[1])));
            rendered = true;
        }
        children.hidden  = !expanded;
        summary.hidden   = expanded;
        toggle.textContent = expanded ? '▾' : '▸';
        row.classList.toggle('open', expanded);
    };

    toggle.addEventListener('click', () => setOpen(children.hidden));

    const head = h('div', 'j-head', toggle, keyLabel, keyLabel ? h('span', 'j-punct', ': ') : null, h('span', 'j-punct', brackets[0]), summary, note);
    head.addEventListener('dblclick', () => setOpen(children.hidden));
    row.append(head, children);
    setOpen(open > 0);

    return row;

}

function preview(value, count) {
    if (isArray(value))
        return ` ${count} item${count === 1 ? '' : 's'} ]`;
    const id   = value['@id'];
    const text = typeof id === 'string' ? ` "@id": ${JSON.stringify(id.length > MAX_INLINE ? id.slice(0, MAX_INLINE) + '…' : id)}, … }` : ` ${count} propert${count === 1 ? 'y' : 'ies'} }`;
    return text;
}


/** A small "copy" button that copies the text the callback gives. */
export function copyButton(text, label = 'Copy') {
    const element = button(label, async () => {
        try {
            await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
            element.textContent = 'Copied';
            setTimeout(() => { element.textContent = label; }, 1200);
        }
        catch {
            element.textContent = 'Copy failed';
        }
    }, 'copy');
    return element;
}
