/*
 * The file an app kept of a charging session paid with EV Taler (WWCP_POI example A16, concepts/EVTaler.md 7): the proof of
 * the charging station as the session began, the price statements the app held, the contract terms of every step it paid,
 * and the settlement statement of the operator. Months later, when the session is disputed, the file alone decides it.
 *
 * Every verdict is the library's (`verifyChargingStation`, `EVTalerContractTerms.verify`, `EVTalerSettlement.verify`). What
 * this file adds is the order an app checks them in, which part fails where one does, and the transparency software the
 * library asks for: the signed meter values are OCMF, verified by `verifyOCMF` (ocmf.js).
 */

import { EVTalerContractTerms, EVTalerSettlement, get, isArray, isObject } from '@open-charging-cloud/wwcp-poi';

import { verifyOCMF } from './ocmf.js';


const message = (e) => e instanceof Error ? e.message : String(e);

/**
 * Checks the files apps kept of sessions paid with EV Taler, each as its app would: the station proof at the time the
 * session began, with `verifyStation(proof, { at, evseId })`, which gives `{ station, basis }` or throws; then every step
 * after the one before; then the settlement statement against the steps. A part that fails ends it: the parts after it are
 * not checked, since each builds on the one before. Every finding goes to `issue`.
 */
export function analyzeEVTalerEvidence(documents, { verifyStation }, issue) {

    return documents.map(document => {

        const json   = document.json;
        const result = {
            document,
            ok:             false,
            evseId:         String(get(json, 'EVSEId') ?? ''),
            sessionStarted: typeof get(json, 'sessionStarted') === 'string' ? get(json, 'sessionStarted') : undefined,
            steps:          [],
        };

        const refuse = (part, e) => {
            result.failedAt = part;
            result.error    = message(e);
            issue('error', `The EV Taler session of '${document.name}' is refused, at ${part}: ${result.error}`, document);
            return result;
        };

        if (result.sessionStarted === undefined || Number.isNaN(Date.parse(result.sessionStarted)))
            return refuse('the file', new Error('It does not say when the session started.'));

        // The station as the app checked it then: at the time the session began, not at the time checked here, since its
        // attestations end minutes after they were signed.
        try {
            const { station, basis } = verifyStation(get(json, 'stationProof'), { at: result.sessionStarted, evseId: result.evseId });
            result.station = station;
            result.basis   = basis;
        }
        catch (e) {
            return refuse('the proof of its charging station', e);
        }

        const terms      = get(json, 'contractTerms');
        const statements = get(json, 'priceStatements') ?? [];

        if (!isArray(terms) || terms.length === 0)
            return refuse('its steps', new Error('It holds no contract terms: no step was paid.'));

        for (const [ index, item ] of terms.entries()) {
            const step = { index, orderId: isObject(item) && typeof item['order_id'] === 'string' ? item['order_id'] : undefined };
            result.steps.push(step);
            try {
                step.terms    = EVTalerContractTerms.parse(item);
                step.verified = step.terms.verify(result.station, statements, result.steps[index - 1]?.verified, verifyOCMF);
                step.ok       = true;
            }
            catch (e) {
                step.ok    = false;
                step.error = message(e);
                return refuse(`step ${index + 1}`, e);
            }
        }

        if (get(json, 'settlement') === undefined) {
            result.ok     = undefined;
            result.detail = 'It holds no settlement statement: its steps are those of the operator, at the price as the session began, but nothing says what was delivered and refunded.';
            issue('warning', `The EV Taler session of '${document.name}' holds no settlement statement: its steps verify, what was delivered and refunded is not said.`, document);
            return result;
        }

        try {
            result.settlement   = EVTalerSettlement.parse(get(json, 'settlement'));
            result.verification = result.settlement.verify(result.station, result.steps.map(step => step.verified), verifyOCMF);
        }
        catch (e) {
            return refuse('its settlement statement', e);
        }

        result.ok = true;
        return result;

    });

}
