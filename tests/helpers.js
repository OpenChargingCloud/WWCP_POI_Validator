/*
 * What the tests share: the demos as the page loads them, the settings their manifests give, and the analysis of
 * WWCP_POI.TS run on them in Node, without a browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { analyze } from '../src/analyze.js';
import { DocumentPool } from '../src/documents.js';


export const ROOT = join(import.meta.dirname, '..');


/** The manifest of a demo and its documents, as text: a test changes the text, as a user editing a document would. */
export function readDemo(id) {
    const folder   = join(ROOT, 'demo', id);
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    const files    = new Map(manifest.files.map(file => [ file.path, readFileSync(join(folder, file.path), 'utf8') ]));
    return { manifest, files };
}

/** The settings of the page for a demo: its trust anchor, its witnesses, checked as of the time of its recording. */
export function settingsOf(manifest, overrides = {}) {
    return {
        trustAnchorText:    manifest.trustAnchor,
        witnesses:          manifest.witnesses ?? [],
        requiredWitnesses:  manifest.requiredWitnesses ?? 0,
        at:                 Date.parse(manifest.recordedAt),
        ...overrides,
    };
}

/** The analysis of the given documents, in the order given. */
export async function analyzeTexts(files, settings) {
    const pool = new DocumentPool();
    for (const [ name, text ] of files)
        pool.addText(name, text, 'demo');
    return analyze(pool, settings);
}

/** The analysis of a demo, its documents changed by `change` first where given. */
export async function analyzeDemo(id, { change, settings = {} } = {}) {
    const { manifest, files } = readDemo(id);
    change?.(files);
    return analyzeTexts(files, settingsOf(manifest, settings));
}

/** Replaces the one occurrence of `from` in a document; a test whose text is not there, or there twice, fails. */
export function replaceOnce(files, name, from, to) {
    const text  = files.get(name);
    const first = text.indexOf(from);
    if (first < 0 || text.indexOf(from, first + 1) >= 0)
        throw new Error(`'${from.slice(0, 60)}' is not exactly once in ${name}`);
    files.set(name, text.slice(0, first) + to + text.slice(first + from.length));
}


/** What a report comes to, in plain values a test compares. */
export function summaryOf(report) {
    return {
        verdict:      report.verdict,
        anchor:       report.anchor.kind,
        head:         report.head === undefined ? undefined : { epoch: report.head.epoch, revision: report.head.version.commit.revision },
        epochs:       report.epochs.map(epoch => ({
                          number:      epoch.number,
                          commits:     epoch.steps.filter(step => step.type === 'commit').length,
                          checkpoints: epoch.steps.filter(step => step.type === 'checkpoint').length,
                          notTaken:    epoch.notTaken.length,
                      })),
        proofs:       report.proofs.map(result => result.ok),
        evidence:     report.evidence.map(result => result.ok),
        commitProofs: report.commitProofs.map(result => result.ok),
        priceStatementProofs: report.priceStatementProofs.map(result => result.ok),
        attestations: report.attestations.map(result => result.ok),
        qiDigital:    report.qiDigital.map(result => result.ok),
        archive:      report.archive !== undefined,
        errors:       report.issues.filter(item => item.level === 'error').map(item => item.text),
        warnings:     report.issues.filter(item => item.level === 'warning').map(item => item.text),
    };
}
