/*
 * What an app keeps (WWCP_POI.TS 0.2.0): the versions it observed, authenticated, in a journal of its own, and what it
 * concludes from them - the current version of each chain, versions older than one it saw (rollbacks), two of one place
 * (forks), and changes of the epoch no verified trust transition explains. As an app that observed the documents loaded,
 * in their order: station proofs, the price statements of their stations and EVSEs, and the trust transitions, each only
 * once it verified; nothing of what is observed is authenticated by observing it.
 */

import {
    ChargingStationProof, applyVerifiedTrustTransition, compareObservedVersions, emptyObservedVersions, priceVersionObservation, stationVersionObservation,
} from '@open-charging-cloud/wwcp-poi';


const message = (e) => e instanceof Error ? e.message : String(e);


/**
 * The journal of an app that observed the given documents in their order. `report`: its verified proofs (with the epoch
 * of each) and transitions; `order`, the position of each document. Returns each step - what was observed, whether the
 * journal took it, why not - and the journal at the end.
 */
export function observeVersions(report, order, at) {

    const items = [];

    // A station proof, at the epoch of its version, with the price statements that verified for it, in their order.
    const seen = new Set();
    for (const result of report.proofs.filter(item => item.ok)) {
        const statements = (result.statements ?? []).filter(item => item.ok && !seen.has(item.statement.digestHex()));
        statements.forEach(item => seen.add(item.statement.digestHex()));
        items.push({ document: result.document, kind: 'station', result, statements: statements.map(item => item.statement).sort((left, right) => left.sequence - right.sequence) });
    }

    for (const result of report.transitions.filter(item => item.verified !== undefined))
        items.push({ document: result.document, kind: 'transition', result });

    items.sort((left, right) => (order.get(left.document) ?? 1e9) - (order.get(right.document) ?? 1e9));

    let state   = emptyObservedVersions();
    const steps = [];

    for (const item of items) {

        const step = { document: item.document, kind: item.kind };
        steps.push(step);

        try {

            let comparison;

            if (item.kind === 'transition') {
                step.what  = `the transition to ${item.result.verified.context.anchor.urls.join(', ')}${item.result.verified.epoch.number !== item.result.verified.oldEpoch.number ? `, epoch ${item.result.verified.epoch.number}` : ''}`;
                comparison = applyVerifiedTrustTransition(state, item.result.verified, at);
            }
            else {
                const observations = [ stationVersionObservation(ChargingStationProof.parse(item.document.json), String(item.result.epochNumber)),
                                       ...item.statements.map(statement => priceVersionObservation(statement)) ];
                step.what  = `revision ${item.result.station.revision} of epoch ${item.result.epochNumber}${item.statements.length ? `, and ${item.statements.length} price statement${item.statements.length === 1 ? '' : 's'}` : ''}`;
                comparison = compareObservedVersions(state, observations, 'current', at);
            }

            step.status   = comparison.status;
            step.accepted = comparison.accepted;
            step.issues   = comparison.issues;

            if (comparison.accepted)
                state = comparison.state;

        }
        catch (e) {
            step.status   = 'rejected';
            step.accepted = false;
            step.issues   = [ { code: 'error', detail: message(e) } ];
        }

    }

    return { steps, state };

}
