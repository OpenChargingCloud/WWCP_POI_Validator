/*
 * Trust transitions (WWCP_POI.TS 0.2.0, experimental): a compact certificate by which the holders of a trust anchor delegate
 * to another one - other identity keys, other servers, or the next epoch with the checkpoints that close the one before -,
 * signed by a quorum of the holders of both. A trust context does not follow the keys of the operator to their successors
 * by itself; a transition is how it may, explicitly.
 *
 * Each is verified from the trust anchor of the settings and the identity keys trusted there, a later one from the one it
 * continues: no transition authorizes itself. A transition verified gives a trust context of its target, with which the
 * proofs of that policy or epoch are checked.
 */

import { KeyStatement, RoamingNetworkOperator, TrustContext, TrustTransition, VerifiedTrustTransition, get, initialTrustEpoch, trustStatementDigest } from '@open-charging-cloud/wwcp-poi';


const message = (e) => e instanceof Error ? e.message : String(e);


/**
 * Verifies the trust transitions among the documents. `settings`: `anchor` (the trust anchor of the settings),
 * `trustedIdentityKeyIds` (its keys trusted; all of them when undefined), `at`, and `operators`, the roaming network
 * operators the documents give (of proofs, sessions and versions), as JSON, among which the one a transition continues is
 * found by the digest of its key statement. Every finding goes to `issue`.
 */
export function analyzeTransitions(documents, settings, issue) {

    const { anchor, trustedIdentityKeyIds, at } = settings;

    const operators = settings.operators.map(json => {
        try {
            return { json, digest: trustStatementDigest(KeyStatement.parse(get(json, 'keyStatement'))) };
        }
        catch {
            return undefined;
        }
    }).filter(Boolean);

    const results = documents.map(document => {
        const result = { document, ok: false };
        try {
            result.transition = TrustTransition.parse(document.json);
        }
        catch (e) {
            result.error = message(e);
            issue('error', `The trust transition '${document.name}' can not be read: ${message(e)}`, document);
        }
        return result;
    });

    // In the order of their sequence: the first from the trust anchor of the settings, every later one from the one it
    // continues, once that one is verified.
    for (const result of results.filter(item => item.transition !== undefined).sort((left, right) => left.transition.sequence - right.transition.sequence)) {

        const transition = result.transition;

        try {

            let basis;
            let fromOperator;
            let options;

            if (transition.previous === undefined) {

                if (anchor === undefined)
                    throw new Error('There is no trust anchor in the settings to verify it from.');

                const from = operators.find(item => item.digest === transition.fromStatementDigest);
                if (from === undefined)
                    throw new Error('The key statement it continues is in none of the documents loaded: load a proof, a session or a snapshot of the policy it starts from.');

                const operator = RoamingNetworkOperator.parse(from.json, anchor.id);
                basis          = TrustContext.create(anchor, operator.keyStatement, { trustedIdentityKeyIds: trustedIdentityKeyIds ?? anchor.keys, otherIdentityKeys: operator.identityKeys, at });
                fromOperator   = from.json;
                options        = { acceptedAt: at, epoch: initialTrustEpoch(), sequence: 0 };

            }
            else {

                const before = results.find(item => item.verified !== undefined && item.transition.digest() === transition.previous);
                if (before === undefined)
                    throw new Error('The transition it continues is not verified here.');

                basis          = before.verified.context;
                fromOperator   = before.transition.operator;
                options        = { acceptedAt: at, epoch: before.verified.epoch, sequence: before.transition.sequence + 1, previous: transition.previous };
                result.before  = before;

            }

            result.verified = VerifiedTrustTransition.verify(basis, fromOperator, transition, options);
            result.ok       = true;

        }
        catch (e) {
            result.error = message(e);
            issue('error', `The trust transition '${result.document.name}' is refused: ${message(e)}`, result.document);
        }

    }

    return results;

}
