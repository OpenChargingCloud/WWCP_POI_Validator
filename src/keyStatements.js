/*
 * The key statements of a roaming network operator one after the other, as a server gives them
 * (`GET ~/RNs/{RN_Id}/keyStatements`, SPECIFICATION.md 8.6): how an app that scanned a trust anchor some time ago comes to
 * the keys of today without replaying the history.
 *
 * The verdict is the library's (`KeyStatement.verifyChain`). What this file adds is bookkeeping for the page: which
 * statement the trust anchor takes, which ones before it are passed over, who signed each, and where the history loaded
 * states it.
 */

import { KeyStatement, canonicalJSON } from '@open-charging-cloud/wwcp-poi';


const message = (e) => e instanceof Error ? e.message : String(e);


/**
 * Verifies the key statements among the documents, each document a chain of its own. `settings`: `anchor` (the trust
 * anchor of the settings), `trustedIdentityKeyIds` (its keys trusted; all of them when undefined), `at`, `versions` (the
 * versions the history took) and `head` (the version of its head). Every finding goes to `issue`.
 */
export function analyzeKeyStatements(documents, settings, issue) {

    const { anchor, trustedIdentityKeyIds, at, head } = settings;

    // Where the history states a key statement first.
    const statedAt = new Map();
    for (const version of [ ...settings.versions ].sort((left, right) => left.epoch - right.epoch || left.revision - right.revision)) {
        const statement = version.network.operator?.keyStatement;
        if (statement !== undefined && !statedAt.has(canonicalJSON(statement.json)))
            statedAt.set(canonicalJSON(statement.json), { epoch: version.epoch, revision: version.revision });
    }

    const headStatement = head?.network.operator?.keyStatement;

    return documents.map(document => {

        const result = { document, ok: false, statements: [] };

        let statements;
        try {
            statements = document.type === 'keyStatement' ? [ KeyStatement.parse(document.json) ] : KeyStatement.parseChain(document.json);
        }
        catch (e) {
            result.error = message(e);
            issue('error', `The key statements of '${document.name}' can not be read: ${result.error}`, document);
            return result;
        }

        // The holder of every identity key the statements name, for people.
        const holderNames = new Map(statements.flatMap(statement => statement.identityKeys.map(key => [ key.id, key.holderOrUnnamed ])));
        const namesOf     = (ids) => [ ...new Set(ids.map(id => holderNames.get(id) ?? '?')) ].sort();

        result.statements = statements.map((statement, index) => ({
            index,
            statement,
            holders:   namesOf(statement.identityKeys.map(key => key.id)),
            signedBy:  namesOf(statement.signatures.map(signature => signature.keyId)),
            statedAt:  statedAt.get(canonicalJSON(statement.json)),
            status:    'unchecked',
        }));

        if (anchor === undefined) {
            result.ok     = undefined;
            result.detail = 'No trust anchor is given: nothing says whose key statements these are, they are not checked.';
            return result;
        }

        const refuse = (error) => {
            result.error = error;
            issue('error', `The key statements of '${document.name}' are refused: ${error}`, document);
            return result;
        };

        const foreign = statements.find(statement => statement.roamingNetworkId !== anchor.id);
        if (foreign !== undefined)
            return refuse(`They are of the roaming network '${foreign.roamingNetworkId}', not of the trust anchor's '${anchor.id}'.`);

        // The identity keys trusted, per holder as the trust anchor names them: all of them, or those the user trusts.
        const trusted  = trustedIdentityKeyIds === undefined ? undefined : new Set(trustedIdentityKeyIds);
        const holders  = anchor.holders.map(keys => keys.filter(id => trusted === undefined || trusted.has(id))).filter(keys => keys.length > 0);
        const options  = { minConsensus: anchor.minConsensus, at };

        result.required = anchor.minConsensus;

        // The first statement the trust anchor takes as a single one, as the library looks for it: valid when the next one
        // was signed, the last one at the time checked.
        const first = statements.findIndex((statement, index) => {
            try {
                statement.verifyHolders(holders, [], { minConsensus: anchor.minConsensus, at: statements[index + 1]?.signedAt ?? at });
                return true;
            }
            catch {
                return false;
            }
        });

        const mark = (failedAt) => result.statements.forEach(item => {
            item.status = first < 0 || item.index < first ? 'passedOver'
                        : failedAt !== undefined && item.index === failedAt ? 'refused'
                        : failedAt !== undefined && item.index >   failedAt ? 'unchecked'
                        : item.index === first ? 'trusted' : 'followed';
        });

        // None of them is taken: nothing follows from the trust anchor, and nothing of them is trusted. Where the history
        // loaded states every one of them, they are no forgery, just not of the keys trusted: e.g. older than a trust anchor
        // of the keys of a later epoch.
        if (first < 0 && statements.length > 0) {
            const known   = result.statements.every(item => item.statedAt !== undefined);
            result.ok     = undefined;
            result.detail = `None of them is signed by the identity keys trusted here, of as many holders as the trust anchor requires: nothing of them is trusted.${known ? ' The history loaded states each of them, e.g. before the keys of the trust anchor.' : ''}`;
            mark();
            issue(known ? 'info' : 'warning', `The key statements of '${document.name}' lead nowhere from the trust anchor: none of them is signed by the identity keys trusted here.`, document);
            return result;
        }

        try {
            const { verified, holderOf } = KeyStatement.verifyChain(statements, holders, options);
            result.ok       = true;
            result.verified = verified;
            result.holderOf = holderOf;
            mark();
        }
        catch (e) {
            // Which one it refuses, the library says in its words: "The key statement 2 of 3 …".
            const named = /^The key statement (\d+) of \d+ /.exec(message(e));
            mark(named ? Number(named[1]) - 1 : undefined);
            return refuse(message(e));
        }

        // Whether they lead to the keys the head of the history states.
        if (headStatement !== undefined) {
            result.head = canonicalJSON(result.verified.json) === canonicalJSON(headStatement.json) ? 'same' : 'other';
            if (result.head === 'other') {
                const stated = result.statements.at(-1).statedAt;
                issue('info', stated !== undefined
                                  ? `The key statements of '${document.name}' end with the one revision ${stated.revision} of epoch ${stated.epoch} states: the head of the history states a later one, which they do not reach.`
                                  : `The key statements of '${document.name}' end with one no version of the history loaded states: whoever gave them was at another version.`, document);
            }
        }

        return result;

    });

}
