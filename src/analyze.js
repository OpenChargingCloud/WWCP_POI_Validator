/*
 * The analysis: what WWCP_POI.TS says about the documents of the pool, from a trust anchor.
 *
 * It does what a witness or an app following a roaming network does (SPECIFICATION.md 5, 8.6, 10, 11): it trusts the
 * roaming network operator by the identity keys its trust anchor pins, starts each epoch from a snapshot, takes the commits
 * since one after the other - each change set applied to the version before, signed by its owners and leading to the ETags
 * of its commit, each commit signed by the quorum of the operator - follows the keys the operator states, takes the
 * checkpoints with the signatures of the operator and the witnesses, and moves into the next epoch at the final checkpoint.
 *
 * Every verdict is the library's. What this file adds is bookkeeping: it records each step, so that the page can show who
 * signed what, and it goes on where it can, so that one refused signature does not hide the rest of the history.
 */

import {
    TrustAnchor, RoamingNetwork, Commit, ChangeSet, Checkpoint, History, OperatorTrust, POIPublicKey, Attestation,
    CheckpointProof, PriceStatement, PriceStatementProof, RuntimeStatus,
    verifyCheckpointSignatures, verifyChargingStation, verifyPriceStatements, verifyCheckpointPriceStatements,
    verifyEvidence, parseEvidence, parseTrustedWitnesses, parsePriceStatements, priceStatementsRoot,
    parseArchiveSegmentInfo, verifySegmentLine, sameETags, etagToText, canonicalJSON, toHex, get, isArray, isObject,
    DigitalCalibrationCertificate, DigitalCertificateOfConformity, DigitalDeclarationOfConformity,
    evTalerMerchantOf, evTalerTariffOf, evTalerExchangesAt,
} from '@open-charging-cloud/wwcp-poi';

import { keyDirectory } from './keys.js';
import { yieldToBrowser } from './dom.js';


const message = (e) => e instanceof Error ? e.message : String(e);

const PARTY_TYPES = new Set([ 'ChargingStationOperator', 'EMobilityProvider', 'GridOperator', 'ParkingOperator', 'ChargingStationManufacturer',
                              'EnergyMeterManufacturer', 'TransparencySoftwareManufacturer', 'ConformityAssessmentBody' ]);

const TARIFF_TYPES = new Set([ 'ChargingTariff', 'ChargingTariffTemplate', 'ChargingTariffGroup', 'ChargingTariffOffer' ]);

const PARTY_CHILDREN = {
    ChargingStationModel:             { parentType: 'ChargingStationManufacturer',       usage: 'models' },
    EnergyMeterModel:                 { parentType: 'EnergyMeterManufacturer',           usage: 'models' },
    TransparencySoftware:             { parentType: 'TransparencySoftwareManufacturer',  usage: 'software' },
    TransparencySoftwareCertificate:  { parentType: 'ConformityAssessmentBody',          usage: 'certificates' },
};


/**
 * Who owns a change, as the table of section 4.1 says, for people: the library checks the signatures of the owners itself
 * (`applyChangeSet`), this only names them.
 */
export function ownerOfChange(change, before) {

    const content = before?.content ?? {};

    if (change.entityType === 'RoamingNetworkOperator' || change.entityType === 'RoamingNetwork')
        return { type: 'RoamingNetworkOperator', id: before?.operator?.id, keys: [ 'identityKeys', 'minConsensus' ].includes(change.propertyName) ? 'identity keys' : 'signing keys', usage: 'party' };

    // The EV Taler merchant of a charging station operator by a key that may sign 'payments': whoever changes it redirects
    // the payments of every station (EVTaler.md 4.4).
    if (PARTY_TYPES.has(change.entityType))
        return change.kind === 'Add' || change.kind === 'Remove'
                   ? { type: 'RoamingNetworkOperator', id: before?.operator?.id, keys: 'signing keys', usage: 'party', note: 'decides who is a member' }
                   : { type: change.entityType, id: change.entityId, keys: change.propertyName === 'identityKeys' ? 'identity keys' : 'signing keys',
                       usage: change.entityType === 'ChargingStationOperator' && change.propertyName === 'evTaler' ? 'payments' : 'party' };

    const child = PARTY_CHILDREN[change.entityType];
    if (child !== undefined)
        return { type: child.parentType, id: change.parentEntityId, keys: 'signing keys', usage: child.usage };

    if (change.entityType === 'EnergyMeterTemplate' || change.entityType === 'EnergyMeterGroup')
        return { type: change.parentEntityType ?? 'ChargingStationOperator', id: change.parentEntityId ?? operatorIdOf(content, change.entityId), keys: 'signing keys', usage: 'infrastructure' };

    return { type: 'ChargingStationOperator', id: operatorIdOf(content, change.entityId), keys: 'signing keys', usage: TARIFF_TYPES.has(change.entityType) ? 'tariffs' : 'infrastructure' };

}

/** The charging station operator an identification names: the longest operator identification it starts with, and a '*'. */
export function operatorIdOf(content, entityId) {
    let found;
    for (const operator of isArray(content['chargingStationOperators']) ? content['chargingStationOperators'] : []) {
        const id = String(operator['@id']);
        if (entityId.startsWith(id + '*') && (found === undefined || id.length > found.length))
            found = id;
    }
    return found;
}


/**
 * Every price statement the documents give that no checkpoint names (those are checked with their checkpoint), against
 * the signing keys its operator states (12.2): the key it names, in the latest version held that states it. Where that
 * key does not verify it, the statement is refused: changed after it was signed, or never signed with that key. A key no
 * version held states leaves it unchecked; it does not count, for an app as here.
 */
function checkPriceStatements(report, priceLists, issue) {

    const versions = [ ...report.versions.values() ].sort((left, right) => right.epoch - left.epoch || right.revision - left.revision);
    const keysOf   = new Map();
    const checked  = new Set(priceLists.filter(list => list.checkpointId !== undefined).flatMap(list => list.statements.map(statement => statement.digestHex())));

    const signingKeys = (version, operatorId) => {
        const id = `${version.epoch}:${version.revision}:${operatorId}`;
        if (!keysOf.has(id)) {
            try {
                keysOf.set(id, POIPublicKey.parseAll(get(version.network.chargingStationOperator(operatorId) ?? {}, 'signingKeys'), 'signing keys'));
            }
            catch {
                keysOf.set(id, []);
            }
        }
        return keysOf.get(id);
    };

    for (const list of priceLists.filter(list => list.checkpointId === undefined))
        for (const statement of list.statements) {

            if (checked.has(statement.digestHex()))
                continue;
            checked.add(statement.digestHex());

            for (const version of versions) {
                const operatorId = operatorIdOf(version.network.content, statement.entityId) ?? statement.signer;
                const keys       = signingKeys(version, operatorId);
                if (!keys.some(key => key.id === statement.keyId))
                    continue;
                try {
                    statement.verify(report.roamingNetworkId, operatorId, keys);
                }
                catch (e) {
                    issue('error', `The price statement ${statement.sequence} of the ${statement.entityType} '${statement.entityId}' in '${list.document.name}' is refused: ${message(e)}`, list.document);
                }
                break;
            }

        }

}

/** A trust anchor made of the identity keys a version states itself: trust on first use, never as good as one pinned. */
function trustOnFirstUse(network) {
    const statement = network.operator?.keyStatement;
    if (statement === undefined)
        return undefined;
    return TrustAnchor.create(network.id, [ `https://unknown.invalid/RNs/${encodeURIComponent(network.id)}` ], keysByHolder(statement.identityKeys), statement.minConsensus);
}

/** The `@id`s of identity keys, one entry per holder, as a trust anchor names them: holders are counted, not keys (4.1, 8.6). */
function keysByHolder(identityKeys) {
    const holders = new Map();
    for (const key of identityKeys)
        holders.set(key.holderOrUnnamed, [ ...(holders.get(key.holderOrUnnamed) ?? []), key.id ]);
    return [ ...holders.values() ];
}


/**
 * Each signature of a commit or checkpoint, as a verifier trusting `trust` and the witnesses sees it. Where the library
 * verified them already (`verified`: the signatures it found invalid, by key), they are not verified again: the costly
 * algorithms (ES512, Ed448, ML-DSA) count twice otherwise.
 */
function describeRoleSignatures(signatures, trust, witnesses, verify, verified) {

    if (verified !== undefined)
        verify = (signature) => {
            const reason = verified.get(signature.keyId);
            if (reason !== undefined)
                throw new Error(reason);
        };

    return signatures.map(signature => {

        const result = { role: signature.role, signer: signature.signer, keyId: signature.keyId, algorithm: signature.algorithm, signedAt: signature.signedAt };

        if (signature.role === 'roamingNetworkOperator') {

            // Counted for the holder of the trusted identity key that certified the key, as the trust knows it.
            const key    = trust?.signingKeyOf(signature);
            const holder = trust?.holderOf(signature);

            if (key === undefined || holder === undefined)
                return { ...result, status: 'untrusted', detail: trust === undefined ? 'no trust in the roaming network operator' : 'no signing key a trusted identity key of its holder certifies, valid then and for the party' };

            try {
                verify(signature, key);
                return { ...result, status: 'valid', holder };
            }
            catch (e) {
                return { ...result, status: 'invalid', holder, detail: message(e) };
            }

        }

        if (signature.role === 'witness') {

            const witness = witnesses.find(item => item.witness === signature.signer && item.key.id === signature.keyId);

            if (witness === undefined)
                return { ...result, status: 'untrusted', detail: 'not a witness trusted here, or not with this key' };

            try {
                verify(signature, witness.key);
                return { ...result, status: 'valid', holder: witness.witness };
            }
            catch (e) {
                return { ...result, status: 'invalid', holder: witness.witness, detail: message(e) };
            }

        }

        return { ...result, status: 'ignored', detail: `a signature in the role '${signature.role}'` };

    });

}


/** The identity keys a change set enters anew: each must sign it, as its proof of possession (4.1). */
function newIdentityKeys(changeSet, before) {

    const keys = new Map();
    const known = new Set([ ...(before.operator?.identityKeys ?? []).map(key => key.id) ]);

    for (const party of Object.values(PARTY_ARRAYS))
        for (const item of isArray(before.content[party]) ? before.content[party] : [])
            for (const key of isArray(item['identityKeys']) ? item['identityKeys'] : [])
                if (isObject(key))
                    known.add(String(key['@id']));

    for (const change of changeSet.changes) {

        let value;

        if (PARTY_TYPES.has(change.entityType) && change.kind === 'Add' && isObject(change.newValue))
            value = change.newValue['identityKeys'];
        else if ((PARTY_TYPES.has(change.entityType) || change.entityType === 'RoamingNetworkOperator') && change.kind === 'UpdateProperty' && change.propertyName === 'identityKeys')
            value = change.newValue;

        if (!isArray(value))
            continue;

        for (const json of value) {
            try {
                const key = POIPublicKey.parse(json);
                if (!known.has(key.id))
                    keys.set(key.id, { key, ownerType: change.entityType, ownerId: change.entityId });
            }
            catch {
                // The library refuses it when it applies the change set.
            }
        }

    }

    return keys;

}

const PARTY_ARRAYS = {
    ChargingStationOperator:           'chargingStationOperators',
    EMobilityProvider:                 'eMobilityProviders',
    GridOperator:                      'gridOperators',
    ParkingOperator:                   'parkingOperators',
    ChargingStationManufacturer:       'chargingStationManufacturers',
    EnergyMeterManufacturer:           'energyMeterManufacturers',
    TransparencySoftwareManufacturer:  'transparencySoftwareManufacturers',
    ConformityAssessmentBody:          'conformityAssessmentBodies',
};


/**
 * Each signature of a change set: whose key, which kind, and whether it is valid. Where the library applied the change
 * set (`verified`), it verified every signature of it already: they are not verified again.
 */
function describeChangeSetSignatures(changeSet, before, witnesses, verified = false) {

    const directory = keyDirectory(before, { witnesses });
    const fresh     = newIdentityKeys(changeSet, before);

    return changeSet.signatures.map(signature => {

        const known = directory.get(signature.keyId);
        const added = fresh.get(signature.keyId);
        const key   = known?.key ?? added?.key;
        let valid;
        let detail;

        if (key !== undefined && verified)
            valid = true;

        else if (key !== undefined) {
            try {
                changeSet.verifySignature(signature, key);
                valid = true;
            }
            catch (e) {
                valid  = false;
                detail = message(e);
            }
        }

        return {
            keyId:      signature.keyId,
            algorithm:  signature.algorithm,
            entry:      known,
            proofOfPossession: added !== undefined ? { ownerType: added.ownerType, ownerId: added.ownerId } : undefined,
            valid,
            detail:     key === undefined ? 'a key no party of the version names' : detail,
        };

    });

}


/** A snapshot of the pool: its version and commit, read by the library. */
function readSnapshot(document, json) {
    const commit  = Commit.parse(get(json, 'commit'));
    const epochJS = get(json, 'epoch');
    const epoch   = isObject(epochJS) ? Number(epochJS['epoch']) : commit.epoch;
    return { document, json, commit, epoch, revision: commit.revision, checkpoint: get(json, 'checkpoint') };
}


/**
 * Analyzes the pool. `settings`: `trustAnchorText` (QR code text, URL or JSON of a trust anchor), `at` (when key statements,
 * attestations and prices must be valid; now when undefined), `witnesses` (trusted witnesses as JSON) and
 * `requiredWitnesses`. `onProgress(text, fraction)` is told how far it got.
 */
export async function analyze(pool, settings, onProgress = () => {}) {

    const at        = settings.at ?? Date.now();
    const issues    = [];
    const issue     = (level, text, ref) => issues.push({ level, text, ref });

    const report = {
        at,
        anchor:            { kind: 'none' },
        witnesses:         [],
        requiredWitnesses: settings.requiredWitnesses ?? 0,
        roamingNetworkId:  undefined,
        epochs:            [],
        versions:          new Map(),
        head:              undefined,
        proofs:            [],
        evidence:          [],
        commitProofs:      [],
        priceStatementProofs: [],
        attestations:      [],
        archive:           undefined,
        qiDigital:         [],
        runtime:           [],
        looseCommits:      [],
        issues,
    };

    // The trusted witnesses: configured, never taken from the network.
    try {
        report.witnesses = settings.witnesses === undefined || settings.witnesses === null ? [] : parseTrustedWitnesses(settings.witnesses);
    }
    catch (e) {
        issue('error', `The trusted witnesses can not be read: ${message(e)}`);
    }

    // The trust anchor, as the user gave it.
    let anchor;

    if (settings.trustAnchorText !== undefined && settings.trustAnchorText.trim() !== '') {
        const text = settings.trustAnchorText.trim();
        try {
            anchor = text.startsWith('{') ? TrustAnchor.fromJSON(JSON.parse(text)) : TrustAnchor.parse(text);
            report.anchor = { kind: 'pinned', anchor, text };
        }
        catch (e) {
            report.anchor = { kind: 'invalid', text, error: message(e) };
            issue('error', `The trust anchor can not be read: ${message(e)}`);
        }
    }

    onProgress('Reading the documents …', 0.02);
    await yieldToBrowser();


    //  ------------------------------------------------------------------
    //  What the pool holds, by epoch
    //  ------------------------------------------------------------------

    const snapshots    = [];
    const commits      = new Map();     // id → { commit, documents }
    const checkpoints  = new Map();     // id → { checkpoint, documents }
    const priceLists   = [];            // { document, statements }
    const refused      = [];            // { type, json, epoch, revision, sequence, error, documents }

    /** The union of the signatures of two copies: signatures are no part of an identification and may come later (5.4, 10.2). */
    const unionOf = (left, right) => {
        const seen = new Map();
        for (const signature of [ ...(isArray(left) ? left : []), ...(isArray(right) ? right : []) ])
            seen.set(canonicalJSON(signature), signature);
        return [ ...seen.values() ];
    };

    const sameSignatures = (left, right) => canonicalJSON(isArray(left) ? left : []) === canonicalJSON(isArray(right) ? right : []);

    const addCommit = (json, document) => {
        try {
            const commit = Commit.parse(json);
            const known  = commits.get(commit.id);
            if (known === undefined) {
                commits.set(commit.id, { commit, documents: [ document ] });
                return;
            }
            known.documents.push(document);
            // Another copy with other signatures, of the commit or of its change set: all of them are checked.
            const changeSet = isObject(json['changeSet']) ? json['changeSet'] : undefined;
            const knownSet  = known.commit.changeSet;
            if (!sameSignatures(known.commit.json['signatures'], json['signatures']) || (changeSet && !sameSignatures(knownSet?.['signatures'], changeSet['signatures']))) {
                const merged = { ...known.commit.json, signatures: unionOf(known.commit.json['signatures'], json['signatures']) };
                if (changeSet && knownSet)
                    merged['changeSet'] = { ...knownSet, signatures: unionOf(knownSet['signatures'], changeSet['signatures']) };
                known.commit = Commit.parse(merged);
                issue('info', `The documents give revision ${commit.revision} of epoch ${commit.epoch} with different signatures ('${known.documents.map(item => item.name).join("', '")}'): all of them are checked.`, document);
            }
        }
        catch (e) {
            refused.push({ type: 'commit', json, epoch: isObject(json) ? Number(json['epoch'] ?? 1) : undefined, revision: isObject(json) ? json['revision'] : undefined, error: message(e), documents: [ document ] });
            issue('error', `A commit of '${document.name}'${isObject(json) ? ` (revision ${json['revision']})` : ''} is refused: ${message(e)}`, document);
        }
    };

    const addCheckpoint = (json, document) => {
        try {
            const checkpoint = Checkpoint.parse(json);
            const known      = checkpoints.get(checkpoint.id);
            if (known === undefined) {
                checkpoints.set(checkpoint.id, { checkpoint, documents: [ document ] });
                return;
            }
            known.documents.push(document);
            if (!sameSignatures(known.checkpoint.json['signatures'], json['signatures']))
                known.checkpoint = Checkpoint.parse({ ...known.checkpoint.json, signatures: unionOf(known.checkpoint.json['signatures'], json['signatures']) });
        }
        catch (e) {
            refused.push({ type: 'checkpoint', json, epoch: isObject(json) ? Number(json['epoch'] ?? 1) : undefined, sequence: isObject(json) ? json['sequence'] : undefined, error: message(e), documents: [ document ] });
            issue('error', `A checkpoint of '${document.name}'${isObject(json) ? ` (sequence ${json['sequence']})` : ''} is refused: ${message(e)}`, document);
        }
    };

    for (const document of pool.ofType('snapshot')) {
        try {
            snapshots.push(readSnapshot(document, document.json));
            if (get(document.json, 'checkpoint') !== undefined)
                addCheckpoint(get(document.json, 'checkpoint'), document);
        }
        catch (e) {
            issue('error', `The snapshot '${document.name}' is refused: ${message(e)}`, document);
        }
    }

    for (const document of pool.ofType('archiveSegment')) {
        try {
            snapshots.push({ ...readSnapshot(document, get(document.json, 'base')), archive: true });
            for (const commit of get(document.json, 'commits') ?? [])
                addCommit(commit, document);
        }
        catch (e) {
            issue('error', `The archive segment '${document.name}' is refused: ${message(e)}`, document);
        }
    }

    for (const document of pool.ofType('commit'))
        addCommit(document.json, document);

    for (const document of pool.ofType('commits'))
        for (const json of document.json)
            addCommit(json, document);

    for (const document of pool.ofType('checkpoint'))
        addCheckpoint(document.json, document);

    for (const document of pool.ofType('checkpoints'))
        for (const json of document.json)
            addCheckpoint(json, document);

    for (const document of pool.ofType('priceStatements', 'priceStatement')) {
        try {
            const list = document.type === 'priceStatement' ? [ document.json ] : isArray(document.json) ? document.json : get(document.json, 'priceStatements');
            priceLists.push({ document, statements: parsePriceStatements(list) });
        }
        catch (e) {
            issue('error', `The price statements of '${document.name}' are refused: ${message(e)}`, document);
        }
    }

    // The roaming network: of the trust anchor, else of the documents.
    const networkIds = new Set([ ...snapshots.map(snapshot => snapshot.commit.roamingNetworkId), ...[ ...commits.values() ].map(item => item.commit.roamingNetworkId) ]);
    report.roamingNetworkId = anchor?.id ?? [ ...networkIds ][0];

    if (anchor !== undefined)
        for (const id of networkIds)
            if (id !== anchor.id)
                issue('error', `Documents of the roaming network '${id}' are not of the trust anchor's network '${anchor.id}': they are left out.`);

    const ofNetwork = (id) => report.roamingNetworkId === undefined || id === report.roamingNetworkId;

    const epochNumbers = [ ...new Set([
        ...snapshots.filter(snapshot => ofNetwork(snapshot.commit.roamingNetworkId)).map(snapshot => snapshot.epoch),
        ...[ ...commits.values() ].filter(item => ofNetwork(item.commit.roamingNetworkId)).map(item => item.commit.epoch),
        ...[ ...checkpoints.values() ].filter(item => ofNetwork(item.checkpoint.roamingNetworkId)).map(item => item.checkpoint.epoch),
    ]) ].sort((left, right) => left - right);


    //  ------------------------------------------------------------------
    //  Trust, the way the history follows it
    //  ------------------------------------------------------------------

    let trust;
    let previousHistory;
    const takenCommits = new Set();
    const takenCheckpoints = new Set();

    const totalCommits = [ ...commits.values() ].length || 1;
    let progressed = 0;

    /** Trusts the operator of a version that starts an epoch without a history before it: by the trust anchor, else on first use. */
    const establishTrust = (network, step) => {

        if (anchor !== undefined) {
            try {
                trust = OperatorTrust.of(anchor, network, at);
                step.trust = { ok: true, basis: 'pinned', signedBy: [ ...trust.statementSignedBy ], required: trust.requiredConsensus, warnings: trust.textWarnings(network) };
                for (const warning of step.trust.warnings)
                    issue('warning', `Trust anchor: ${warning}`);
                return;
            }
            catch (e) {
                step.trust = { ok: false, basis: 'pinned', error: message(e) };
                issue('error', `The key statement of the roaming network operator of revision ${step.revision} of epoch ${step.epoch} does not verify against the trust anchor: ${message(e)}`);
            }
        }

        // Without a trust anchor, or with one that does not verify: the keys the version states itself, so that the rest can
        // still be shown. Nothing is trusted this way, and the page says so.
        try {
            const tofu      = trustOnFirstUse(network);
            const statement = network.operator?.keyStatement;
            if (tofu === undefined || statement === undefined)
                throw new Error('the roaming network operator states no keys');
            let when = at;
            if (!statement.isValidAt(at))
                when = statement.signedAt;
            trust = OperatorTrust.of(tofu, network, when);
            step.tofu = { ok: true, keys: tofu.keys, minConsensus: tofu.minConsensus, at: when };
            if (anchor === undefined)
                issue('warning', 'No trust anchor is given: the signatures are checked against the keys the roaming network states itself (trust on first use), which proves nothing about who made it.');
        }
        catch (e) {
            trust = undefined;
            step.tofu = { ok: false, error: message(e) };
            issue('warning', `The signatures of the roaming network operator can not be checked: ${message(e)}`);
        }

    };


    for (const epochNumber of epochNumbers) {

        const epochReport = {
            number:      epochNumber,
            profiles:    undefined,
            status:      undefined,
            history:     undefined,
            steps:       [],
            notTaken:    [],
        };

        report.epochs.push(epochReport);

        const epochCommits     = [ ...commits.values() ].filter(item => item.commit.epoch === epochNumber && ofNetwork(item.commit.roamingNetworkId));
        const epochCheckpoints = [ ...checkpoints.values() ].filter(item => item.checkpoint.epoch === epochNumber && ofNetwork(item.checkpoint.roamingNetworkId))
                                                           .sort((left, right) => left.checkpoint.sequence - right.checkpoint.sequence);
        const epochSnapshots   = snapshots.filter(snapshot => snapshot.epoch === epochNumber && ofNetwork(snapshot.commit.roamingNetworkId))
                                          .sort((left, right) => left.revision - right.revision || Number(Boolean(right.checkpoint)) - Number(Boolean(left.checkpoint)));

        // Each step's record, filled by the callbacks the history calls.
        let currentStep;

        const options = {

            verifyCommit: (commit, before, after) => {

                const step = currentStep;

                if (trust === undefined)
                    step.operatorCheck = { ok: undefined, detail: 'The roaming network operator is not trusted: its signatures are not checked.' };
                else {
                    try {
                        const holders = trust.verifyOperatorSignatures(commit.signatures, (signature, key) => commit.verifySignature(signature, key), 'the commit');
                        step.operatorCheck = { ok: true, holders: [ ...holders ].sort(), required: trust.requiredConsensus };
                    }
                    catch (e) {
                        step.operatorCheck = { ok: false, error: message(e), required: trust.requiredConsensus };
                    }
                }

                // Every signature by a trusted key is valid where the library took them; otherwise each is checked to tell which.
                step.operatorSignatures = describeRoleSignatures(commit.signatures, trust, report.witnesses, (signature, key) => commit.verifySignature(signature, key),
                                                                 step.operatorCheck.ok === true ? new Map() : undefined);

                // The keys the operator states anew are followed when the trusted ones signed their statement (8.6, Succession).
                // The commit of a snapshot has no version before it here: its statement is the one trusted already.
                const statementBefore = before?.operator?.keyStatement;
                const statementAfter  = after.operator?.keyStatement;
                const changed         = before !== undefined && statementAfter !== undefined &&
                                        (statementBefore === undefined || canonicalJSON(statementBefore.json) !== canonicalJSON(statementAfter.json));

                if (trust !== undefined) {
                    try {
                        trust = trust.followedBy(after, at);
                        if (changed)
                            step.trustFollowed = { ok: true, signedBy: [ ...trust.statementSignedBy ], identityKeys: statementAfter.identityKeys.map(key => ({ id: key.id, holder: key.holder })) };
                    }
                    catch (e) {
                        step.trustFollowed = { ok: false, error: message(e) };
                    }
                }

            },

            verifyCheckpoint: (checkpoint) => {

                const step = currentStep;
                const verify = (signature, key) => checkpoint.verifySignature(signature, key);

                if (trust === undefined) {
                    step.signatures = describeRoleSignatures(checkpoint.signatures, trust, report.witnesses, verify);
                    step.signatureCheck = { ok: undefined, detail: 'The roaming network operator is not trusted: the signatures are not checked.' };
                    return;
                }

                try {
                    const result = verifyCheckpointSignatures(checkpoint, trust, { witnesses: report.witnesses, requiredWitnesses: report.requiredWitnesses });
                    step.signatureCheck = { ok: true, ...result, required: trust.requiredConsensus, requiredWitnesses: report.requiredWitnesses };
                }
                catch (e) {
                    step.signatureCheck = { ok: false, error: message(e), required: trust.requiredConsensus, requiredWitnesses: report.requiredWitnesses };
                }

                // Taken without an invalid signature, each counted one is valid; otherwise each is checked to tell which.
                const clean = step.signatureCheck.ok === true && !step.signatureCheck.ignored.some(reason => reason.includes('invalid'));
                step.signatures = describeRoleSignatures(checkpoint.signatures, trust, report.witnesses, verify, clean ? new Map() : undefined);

            },

        };

        // Where the epoch starts: the genesis derived from the final checkpoint before (11.3), else its earliest snapshot.
        let history;
        let rootStep;

        if (previousHistory?.finalCheckpoint !== undefined && previousHistory.finalCheckpoint.next?.number === epochNumber) {

            try {
                history  = previousHistory.startNextEpoch(options);
                rootStep = { type: 'root', kind: 'derived', epoch: epochNumber, revision: 0, commit: history.root.commit, network: history.root.network,
                             checks: [ { label: 'Derived from the final checkpoint of the epoch before: its version, revision 0, the next epoch and its profiles (11.3, 11.4)', ok: true } ] };

                const published = epochSnapshots.find(snapshot => snapshot.revision === 0);
                if (published !== undefined)
                    rootStep.checks.push({ label: `The genesis the server published ('${published.document.name}') is the one derived here`, ok: published.commit.id === history.root.commit.id,
                                           detail: published.commit.id === history.root.commit.id ? undefined : `published ${published.commit.id}, derived ${history.root.commit.id}` });

                rootStep.trust = trust !== undefined ? { ok: true, basis: 'followed', signedBy: [ ...trust.statementSignedBy ], required: trust.requiredConsensus } : undefined;
            }
            catch (e) {
                issue('error', `Epoch ${epochNumber} can not be started from the final checkpoint of epoch ${epochNumber - 1}: ${message(e)}`);
            }

        }

        if (history === undefined) {

            for (const snapshot of epochSnapshots) {

                const step = { type: 'root', kind: snapshot.archive ? 'archive' : snapshot.checkpoint ? 'checkpoint' : snapshot.revision === 0 ? 'genesis' : 'snapshot',
                               epoch: epochNumber, revision: snapshot.revision, commit: snapshot.commit, document: snapshot.document, checks: [] };

                try {
                    const network = RoamingNetwork.parse(get(snapshot.json, 'roamingNetwork'));
                    step.network  = network;

                    // Trust the operator of the version the epoch starts with, unless the history followed it here.
                    if (trust === undefined || previousHistory === undefined)
                        establishTrust(network, step);
                    else {
                        try {
                            trust = trust.followedBy(network, at);
                            step.trust = { ok: true, basis: 'followed', signedBy: [ ...trust.statementSignedBy ], required: trust.requiredConsensus };
                        }
                        catch (e) {
                            step.trust = { ok: false, basis: 'followed', error: message(e) };
                            establishTrust(network, step);
                        }
                    }

                    // A snapshot of another server is anchored in the trust anchor (10.5): a checkpoint by the signatures of the
                    // operator's quorum, the head by its attestations. A genesis, or the base of an archive segment, is taken
                    // unanchored: its key statement was verified against the trust anchor here, its commit is signed by the quorum.
                    const anchored = anchor !== undefined && step.trust?.ok === true && step.tofu === undefined && snapshot.revision > 0 && !snapshot.archive;

                    currentStep = step;
                    history = History.fromSnapshot(snapshot.json, anchored ? { ...options, trustAnchor: anchor, at } : { ...options, unanchored: true });
                    step.network = history.root.network;
                    step.anchored = anchored;
                    step.checks.push({ label: 'The roaming network of the snapshot leads to the ETags of its commit (3, 10.5)', ok: true });
                    if (snapshot.checkpoint)
                        step.checks.push({ label: 'Its checkpoint names its commit, with its revision and ETags', ok: true });
                    step.checks.push(anchored
                        ? { label: snapshot.checkpoint
                                       ? 'Anchored in the trust anchor: its checkpoint is signed by signing keys of the quorum of the operator, certified by trusted identity keys (10.5)'
                                       : 'Anchored in the trust anchor: its attestations attest the root of its head (8.5, 10.5)', ok: true }
                        : { label: 'Taken unanchored, its key statement verified against the trust anchor here and its commit signed by the quorum of the operator', ok: step.trust?.ok === true ? true : undefined });
                    if (step.operatorCheck?.ok === false)
                        issue('error', `The commit of the snapshot '${snapshot.document.name}' is not signed as the roaming network operator requires: ${step.operatorCheck.error}`, snapshot.document);
                    rootStep = step;
                    if (snapshot.checkpoint)
                        takenCheckpoints.add(history.checkpoints[0]?.id);
                    break;
                }
                catch (e) {
                    step.checks.push({ label: 'The snapshot is a version the library takes', ok: false, detail: message(e) });
                    issue('error', `The snapshot '${snapshot.document.name}' can not start epoch ${epochNumber}: ${message(e)}`, snapshot.document);
                }

            }

        }

        if (history === undefined) {

            // Nothing to start from: the commits and checkpoints of the epoch are listed, not replayed.
            for (const { commit, documents } of epochCommits.sort((left, right) => left.commit.revision - right.commit.revision))
                epochReport.notTaken.push({ type: 'commit', commit, documents, reason: 'no version to start this epoch from: a snapshot of its genesis, of a checkpoint, or the final checkpoint of the epoch before' });

            for (const { checkpoint, documents } of epochCheckpoints)
                epochReport.notTaken.push({ type: 'checkpoint', checkpoint, documents, reason: 'no version to start this epoch from' });

            if (epochCommits.length + epochCheckpoints.length > 0)
                issue('warning', `Epoch ${epochNumber} has no version to start from: its ${epochCommits.length} commits and ${epochCheckpoints.length} checkpoints are listed, not checked.`);

            continue;

        }

        epochReport.history  = history;
        epochReport.profiles = history.epoch.profiles;
        epochReport.steps.push(rootStep);
        takenCommits.add(history.root.commit.id);
        report.versions.set(`${epochNumber}:${history.root.commit.revision}`, { epoch: epochNumber, revision: history.root.commit.revision, network: history.root.network, commit: history.root.commit, step: rootStep });

        // The checkpoint of a snapshot is taken with it; record it as a step of its own.
        if (history.checkpoints.length > 0 && currentStep === rootStep && rootStep.signatures !== undefined) {
            const checkpoint = history.checkpoints[0];
            epochReport.steps.push({ type: 'checkpoint', epoch: epochNumber, checkpoint, ok: rootStep.signatureCheck?.ok !== false, signatures: rootStep.signatures, signatureCheck: rootStep.signatureCheck,
                                     checks: [ { label: 'Taken with the snapshot it names: the commits before it are not held, its signatures carry it (10.1, 10.5)', ok: true } ],
                                     documents: checkpoints.get(checkpoint.id)?.documents ?? [] });
            delete rootStep.signatures;
            delete rootStep.signatureCheck;
        }

        // The commits of the epoch from its root on, parent by parent.
        const children = new Map();
        for (const item of epochCommits)
            for (const parentId of item.commit.parentIds.slice(0, 1))
                children.set(parentId, [ ...(children.get(parentId) ?? []), item ]);

        const checkpointsOf = (commitId) => epochCheckpoints.filter(item => item.checkpoint.commitId === commitId && !takenCheckpoints.has(item.checkpoint.id));

        let stopped = false;

        const takeCheckpoints = (commitId) => {

            for (const { checkpoint, documents } of checkpointsOf(commitId)) {

                const step = { type: 'checkpoint', epoch: epochNumber, checkpoint, documents, checks: [] };
                currentStep = step;
                epochReport.steps.push(step);

                try {
                    history.takeCheckpoint(checkpoint);
                    takenCheckpoints.add(checkpoint.id);
                    step.ok = step.signatureCheck?.ok !== false;
                    step.checks.push({ label: 'Its commit is held here, with its revision and ETags; it follows the previous checkpoint, its sequence one more (10.1)', ok: true });
                    step.checks.push({ label: `Its commits tree is the one of the ${checkpoint.commits.size} commits since the previous checkpoint (10.1)`, ok: true });
                    if (checkpoint.isFinal)
                        step.checks.push({ label: `Final: it closes epoch ${epochNumber} and names epoch ${checkpoint.next?.number} and its profiles (11.2)`, ok: true });
                    if (checkpoint.previous !== undefined)
                        step.checks.push({ label: `Names the final checkpoint of epoch ${checkpoint.previous.epoch} it follows (11.3)`, ok: true });
                }
                catch (e) {
                    step.ok = false;
                    step.error = message(e);
                    step.checks.push({ label: 'The history takes the checkpoint', ok: false, detail: message(e) });
                }

                // The price statements it names (12.3): a list of the pool whose tree is its tree.
                if (checkpoint.priceStatements !== undefined) {

                    step.priceStatements = { size: checkpoint.priceStatements.size, root: toHex(checkpoint.priceStatements.root) };

                    // Its trees are calculated with the identification hash of its epoch (10.1, 11.1).
                    const match = priceLists.find(list => {
                        try {
                            const { root, size } = priceStatementsRoot(list.statements, checkpoint.identificationHash);
                            return size === checkpoint.priceStatements.size && toHex(root) === toHex(checkpoint.priceStatements.root);
                        }
                        catch {
                            return false;
                        }
                    });

                    if (match === undefined)
                        step.priceStatements.missing = true;
                    else {
                        match.checkpointId = checkpoint.id;
                        step.priceStatements.document = match.document;
                        // Signed by a signing key of its operator in the version of the checkpoint, or of the checkpoint before (12.3).
                        const previousCheckpoint = history.checkpoints.find(item => item.id === checkpoint.previousId);
                        const versions = [ history.versionOf(checkpoint.commitId)?.network, previousCheckpoint ? history.versionOf(previousCheckpoint.commitId)?.network : undefined ].filter(Boolean);
                        step.priceStatements.statements = match.statements.map(statement => {
                            let error = 'the version of the checkpoint is not held';
                            for (const version of versions) {
                                const operatorId = operatorIdOf(version.content, statement.entityId) ?? statement.signer;
                                try {
                                    const keys = POIPublicKey.parseAll(get(version.chargingStationOperator(operatorId) ?? {}, 'signingKeys'), 'signing keys');
                                    const key  = statement.verify(report.roamingNetworkId, operatorId, keys);
                                    return { statement, ok: true, keyId: key.id };
                                }
                                catch (e) {
                                    error = message(e);
                                }
                            }
                            return { statement, ok: false, error };
                        });
                        try {
                            verifyCheckpointPriceStatements(checkpoint, match.statements);
                            step.priceStatements.ok = step.priceStatements.statements.every(item => item.ok);
                        }
                        catch (e) {
                            step.priceStatements.ok = false;
                            step.priceStatements.error = message(e);
                        }
                    }

                }

            }

        };

        // Checkpoints of the root itself, beyond the one its snapshot took.
        takeCheckpoints(history.root.commit.id);

        let headId = history.root.commit.id;

        while (!stopped) {

            const next = children.get(headId) ?? [];

            if (next.length === 0)
                break;

            const [ item, ...others ] = next.sort((left, right) => left.commit.id < right.commit.id ? -1 : 1);

            for (const other of others)
                epochReport.notTaken.push({ type: 'commit', commit: other.commit, documents: other.documents, reason: `another child of '${headId.slice(0, 12)}…': branches and merges are not taken by WWCP_POI.TS yet` });

            const commit = item.commit;
            const before = history.head.network;
            const step   = { type: 'commit', epoch: epochNumber, revision: commit.revision, commit, before, documents: item.documents, checks: [] };

            try {
                step.changeSet = ChangeSet.parse(commit.changeSet);
                step.owners = step.changeSet.changes.map(change => ownerOfChange(change, before));
            }
            catch (e) {
                step.checks.push({ label: 'The change set can be read', ok: false, detail: message(e) });
            }

            currentStep = step;
            epochReport.steps.push(step);

            try {
                const version = history.append(commit);
                step.network  = version.network;
                step.ok       = step.operatorCheck?.ok !== false;
                takenCommits.add(commit.id);
                step.checks.push({ label: 'Its identification is the digest of its content (5.1)', ok: true });
                step.checks.push({ label: `It follows the head: its parent is revision ${commit.revision - 1}, its revision one more (5.2)`, ok: true });
                step.checks.push({ label: 'Its change set fits the version before it: the before ETags are those of that version (4)', ok: true });
                step.checks.push({ label: 'Its change set is signed by the owners of what it changes, with keys of the version before, valid when it was made (4.1)', ok: true });
                step.checks.push({ label: 'Applied, the change set leads to the after ETags and to the ETags of the commit: json, cbor and effectiveTree (3, 5.2, 8.3)', ok: true });
                report.versions.set(`${epochNumber}:${commit.revision}`, { epoch: epochNumber, revision: commit.revision, network: version.network, commit, step });
            }
            catch (e) {
                step.ok    = false;
                step.error = message(e);
                step.checks.push({ label: 'The history takes the commit (5.2): identification, parent, change set, owners, ETags', ok: false, detail: message(e) });
                issue('error', `Revision ${commit.revision} of epoch ${epochNumber} is refused: ${message(e)}`, item.documents[0]);
                stopped = true;
            }

            // Who signed the change set: applied, the library verified every signature of it.
            if (step.changeSet !== undefined)
                step.changeSetSigners = describeChangeSetSignatures(step.changeSet, before, report.witnesses, step.network !== undefined);

            if (step.ok === false && step.error === undefined && step.operatorCheck?.ok === false)
                issue('error', `Revision ${commit.revision} of epoch ${epochNumber} is not signed as the roaming network operator requires: ${step.operatorCheck.error}`, item.documents[0]);

            if (step.trustFollowed?.ok === false)
                issue('error', `After revision ${commit.revision} of epoch ${epochNumber}, the key statement of the operator is not signed by keys trusted before: ${step.trustFollowed.error}`);

            if (!stopped) {
                headId = commit.id;
                takeCheckpoints(commit.id);
            }

            progressed++;
            onProgress(`Epoch ${epochNumber}: revision ${commit.revision} …`, 0.05 + 0.75 * progressed / totalCommits);
            await yieldToBrowser();

        }

        for (const step of epochReport.steps.filter(step => step.type === 'checkpoint'))
            if (step.ok === false)
                issue('error', `Checkpoint ${step.checkpoint.sequence} of epoch ${epochNumber}: ${step.error ?? step.signatureCheck?.error}`, step.documents?.[0]);
            else if (step.priceStatements?.missing)
                issue('info', `Checkpoint ${step.checkpoint.sequence} of epoch ${epochNumber} names ${step.priceStatements.size} price statements the documents do not give.`);
            else if (step.priceStatements?.ok === false)
                issue('error', `The price statements of checkpoint ${step.checkpoint.sequence} of epoch ${epochNumber}: ${step.priceStatements.error ?? 'a statement does not verify'}`);

        // What the epoch holds and the history did not take.
        const whyNot = (commit) => {
            if (commit.revision <= history.root.commit.revision)
                return `before revision ${history.root.commit.revision}, where this history starts: its version before is not held`;
            const parentId = commit.parentIds[0];
            if (refused.some(item => item.json?.['@id'] === parentId))
                return `its parent, revision ${commit.revision - 1}, was refused`;
            if (!commits.has(parentId) && !takenCommits.has(parentId))
                return `its parent '${parentId.slice(0, 12)}…' is not among the documents`;
            if (!takenCommits.has(parentId))
                return 'its parent was not taken';
            return 'it does not follow the commits taken: another branch';
        };

        for (const { commit, documents } of epochCommits.filter(item => !takenCommits.has(item.commit.id)).sort((left, right) => left.commit.revision - right.commit.revision))
            if (!epochReport.notTaken.some(other => other.commit?.id === commit.id) && !epochReport.steps.some(step => step.commit?.id === commit.id))
                epochReport.notTaken.push({ type: 'commit', commit, documents, reason: whyNot(commit) });

        for (const { checkpoint, documents } of epochCheckpoints.filter(item => !takenCheckpoints.has(item.checkpoint.id)))
            if (!epochReport.steps.some(step => step.checkpoint?.id === checkpoint.id)) {
                const signatures = describeRoleSignatures(checkpoint.signatures, trust, report.witnesses, (signature, key) => checkpoint.verifySignature(signature, key));
                epochReport.notTaken.push({ type: 'checkpoint', checkpoint, documents, signatures,
                                            reason: checkpoint.revision < history.root.commit.revision ? `of revision ${checkpoint.revision}, before revision ${history.root.commit.revision}, where this history starts` : 'its commit is not held here' });
            }

        epochReport.status = history.epochStatus;
        previousHistory    = history;
        report.head        = { epoch: epochNumber, version: history.head, history };

    }

    // What the library refused to read at all, where it would have been in the history.
    for (const item of refused) {
        const epoch = report.epochs.find(candidate => candidate.number === item.epoch) ?? report.epochs.at(-1);
        if (epoch === undefined)
            continue;
        epoch.notTaken.push({
            type:        item.type,
            commit:      item.type === 'commit'     ? { id: String(item.json?.['@id'] ?? ''), revision: item.revision } : undefined,
            checkpoint:  item.type === 'checkpoint' ? { id: String(item.json?.['@id'] ?? ''), sequence: item.sequence } : undefined,
            documents:   item.documents,
            reason:      item.error,
            refused:     true,
        });
    }

    for (const epoch of report.epochs)
        epoch.notTaken.sort((left, right) => (left.type === right.type ? 0 : left.type === 'commit' ? -1 : 1) ||
                                             (left.commit?.revision ?? left.checkpoint?.sequence ?? 0) - (right.commit?.revision ?? right.checkpoint?.sequence ?? 0));

    // Commits of other networks, or of no epoch reached.
    for (const { commit, documents } of commits.values())
        if (!takenCommits.has(commit.id) && !report.epochs.some(epoch => epoch.notTaken.some(item => item.commit?.id === commit.id) || epoch.steps.some(step => step.commit?.id === commit.id)))
            report.looseCommits.push({ commit, documents });

    checkPriceStatements(report, priceLists, issue);


    //  ------------------------------------------------------------------
    //  Proofs, prices, evidence: as an app checks them
    //  ------------------------------------------------------------------

    onProgress('Checking proofs and price statements …', 0.85);
    await yieldToBrowser();

    // The trust anchor of the identity keys the history followed (8.6, Succession), for proofs of a later epoch.
    let followedAnchor;
    if (anchor !== undefined && trust !== undefined && report.anchor.kind === 'pinned') {
        try {
            const statement = trust.keyStatement;
            const ids       = statement.identityKeys.map(key => key.id);
            if (ids.some(id => !anchor.keys.includes(id)))
                followedAnchor = TrustAnchor.create(anchor.id, anchor.urls, keysByHolder(statement.identityKeys), Math.max(anchor.minConsensus, statement.minConsensus), anchor.name, anchor.description);
        }
        catch {
            followedAnchor = undefined;
        }
    }
    report.followedAnchor = followedAnchor;

    const proofAnchor = anchor ?? (report.head ? trustOnFirstUse(report.head.version.network) : undefined);

    for (const document of pool.ofType('stationProof')) {

        const result = { document, ok: false };
        report.proofs.push(result);

        const attempt = (trustAnchor) => verifyChargingStation(trustAnchor, document.json, { at });

        try {
            if (proofAnchor === undefined)
                throw new Error('There is no trust anchor to check it against.');
            try {
                result.station = attempt(proofAnchor);
                result.basis   = anchor !== undefined ? 'pinned' : 'tofu';
            }
            catch (e) {
                if (followedAnchor === undefined)
                    throw e;
                result.pinnedError = message(e);
                result.station     = attempt(followedAnchor);
                result.basis       = 'followed';
            }
            result.ok = true;
        }
        catch (e) {
            result.error = message(e);
            issue('error', `The proof '${document.name}' does not verify: ${message(e)}`, document);
        }

        // The price statements of its station, its pool and its EVSEs, wherever they came from: each checked against the
        // signing keys of the operator the proof gives (12.4), the current one of each entity of those that verify.
        if (result.station !== undefined) {

            const station    = result.station;
            const ids        = new Set([ String(station.chargingPool['@id']), String(station.chargingStation['@id']), ...station.evses.map(evse => String(evse['@id'])) ]);
            const statements = [];
            const seen       = new Set();

            for (const list of priceLists)
                for (const statement of list.statements)
                    if (ids.has(statement.entityId) && !seen.has(statement.digestHex())) {
                        seen.add(statement.digestHex());
                        statements.push(statement);
                    }

            result.statements = statements.map(statement => {
                try {
                    const key = statement.verify(station.roamingNetwork.id, String(station.operator['@id']), station.operatorSigningKeys);
                    return { statement, ok: true, keyId: key.id };
                }
                catch (e) {
                    // Signed with a key of the operator as the proof gives it, and still not verified: refused. Signed with
                    // another key, as one the operator replaced since: it does not count.
                    return { statement, ok: false, refused: station.operatorSigningKeys.some(key => key.id === statement.keyId), error: message(e) };
                }
            });

            const valid = result.statements.filter(item => item.ok).map(item => item.statement.json);

            if (valid.length > 0) {
                try {
                    result.prices = verifyPriceStatements(station, valid, { at });
                }
                catch (e) {
                    result.pricesError = message(e);
                }
            }

            // How its EVSEs are paid for with EV Taler, as the proof gives the merchant of its operator (EVTaler.md 4.1 to
            // 4.3): the EV Taler tariff of each, and the exchanges in its currency; none where its pool does not name it.
            const merchantJSON = get(station.operator, 'evTaler');
            if (merchantJSON !== undefined) {
                const merchant = evTalerMerchantOf(merchantJSON);
                result.evTaler = {
                    merchant: typeof merchant === 'string' ? undefined : merchant,
                    evses:    station.evses.map(evse => String(evse['@id'])).map(evseId => ({ evseId, tariff: evTalerTariffOf(station, evseId), exchanges: evTalerExchangesAt(station, evseId) })),
                };
            }

        }

    }

    for (const document of pool.ofType('evidence')) {
        const result = { document };
        report.evidence.push(result);
        try {
            const evidence = parseEvidence(document.json);
            result.evidence = evidence;
            // The evidence names the trust anchor the app pinned: the same identity keys as the one given here, or others.
            if (anchor !== undefined) {
                const kept = TrustAnchor.parse(evidence.trustAnchor);
                result.sameAnchor = kept.id === anchor.id && kept.keys.length === anchor.keys.length && kept.keys.every(key => anchor.keys.includes(key));
            }
            result.verified = verifyEvidence(evidence, { witnesses: report.witnesses, requiredWitnesses: report.requiredWitnesses });
            result.ok = true;
        }
        catch (e) {
            result.ok = false;
            result.error = message(e);
            issue('error', `The evidence '${document.name}' does not verify: ${message(e)}`, document);
        }
    }

    const checkpointById = (id) => {
        for (const epoch of report.epochs) {
            const step = epoch.steps.find(item => item.type === 'checkpoint' && item.checkpoint.id === id);
            if (step !== undefined)
                return step;
        }
        return undefined;
    };

    for (const document of pool.ofType('commitProof')) {
        const result = { document };
        report.commitProofs.push(result);
        try {
            const proof = CheckpointProof.parse(document.json);
            result.proof = proof;
            const step  = checkpointById(proof.checkpointId);
            if (step === undefined)
                throw new Error(`Its checkpoint '${proof.checkpointId}' is not one the history took.`);
            proof.verify(step.checkpoint);
            result.checkpointStep = step;
            result.ok = step.ok !== false;
            if (!result.ok)
                result.error = 'Its checkpoint does not carry the signatures required.';
        }
        catch (e) {
            result.ok = false;
            result.error = message(e);
            issue('error', `The proof of a commit '${document.name}' does not verify: ${message(e)}`, document);
        }
    }

    for (const document of pool.ofType('priceStatementProof')) {
        const result = { document };
        report.priceStatementProofs.push(result);
        try {
            const proof = PriceStatementProof.parse(document.json);
            result.proof = proof;
            const step  = checkpointById(proof.checkpointId);
            if (step === undefined)
                throw new Error(`Its checkpoint '${proof.checkpointId}' is not one the history took.`);
            proof.verify(step.checkpoint);
            result.checkpointStep = step;
            result.ok = step.ok !== false;
        }
        catch (e) {
            result.ok = false;
            result.error = message(e);
            issue('error', `The proof of a price statement '${document.name}' does not verify: ${message(e)}`, document);
        }
    }

    for (const document of pool.ofType('attestations', 'attestation')) {
        const list = document.type === 'attestation' ? [ document.json ] : isArray(document.json) ? document.json : get(document.json, 'attestations');
        for (const json of list) {
            const result = { document };
            report.attestations.push(result);
            try {
                const attestation = Attestation.parse(json);
                result.attestation = attestation;
                const version = [ ...report.versions.values() ].find(item => item.commit.id === attestation.commitId);
                result.version = version;
                if (version === undefined)
                    throw new Error(`It attests the commit '${attestation.commitId}', which the history did not take.`);
                const versionTrust = (() => { try { return OperatorTrust.of(anchor ?? trustOnFirstUse(version.network), version.network, at); } catch { return followedAnchor ? OperatorTrust.of(followedAnchor, version.network, at) : undefined; } })();
                const key = versionTrust?.signingKeyOf(attestation);
                if (key === undefined)
                    throw new Error('Its key is no signing key a trusted identity key of its holder certifies.');
                attestation.verifySignature(key);
                result.holder = key.holderOrUnnamed;
                const expected = version.network.effectiveTreeETag(attestation.eTag.algorithm);
                result.eTagMatches = toHex(expected.digest) === toHex(attestation.eTag.digest);
                if (!result.eTagMatches)
                    throw new Error(`It attests ${etagToText(attestation.eTag)}, but the version of its commit has ${etagToText(expected)}.`);
                result.validNow = attestation.isValidAt(at);
                result.ok = true;
            }
            catch (e) {
                result.ok = false;
                result.error = message(e);
            }
        }
    }

    analyzeQIDigital(pool, report, at, issue);

    // The archive (10.6): its segments a line, their commits those of the history.
    const segmentInfos = pool.ofType('archiveSegments').flatMap(document => document.json);
    if (segmentInfos.length > 0 || pool.ofType('archiveSegment').length > 0) {
        const archive = { segments: [], ok: true };
        report.archive = archive;
        try {
            const infos = segmentInfos.map(json => parseArchiveSegmentInfo(json));
            verifySegmentLine(infos);
            archive.lineOk = infos.length > 0 ? true : undefined;
            for (const info of infos) {
                const missing = info.commitIds.filter(id => !takenCommits.has(id));
                archive.segments.push({ info, missing, ok: missing.length === 0 });
                if (missing.length > 0)
                    archive.ok = false;
            }
        }
        catch (e) {
            archive.ok = false;
            archive.error = message(e);
            issue('error', `The archive: ${message(e)}`);
        }
    }

    // The runtime status of snapshots: unsigned, beside the version of their commit.
    for (const snapshot of snapshots.filter(item => isArray(get(item.json, 'runtimeStatus')))) {
        try {
            report.runtime.push({ document: snapshot.document, commitId: snapshot.commit.id, epoch: snapshot.epoch, revision: snapshot.revision,
                                  status: RuntimeStatus.fromSnapshot(snapshot.json), timestamp: get(snapshot.json, 'timestamp') });
        }
        catch (e) {
            issue('warning', `The runtime status of '${snapshot.document.name}' can not be read: ${message(e)}`, snapshot.document);
        }
    }

    onProgress('Done.', 1);

    report.verdict = verdictOf(report);

    return report;

}


//  ------------------------------------------------------------------
//  QI-Digital (example A14): the papers of what charges, checked against the network
//  ------------------------------------------------------------------

const QI_DIGITAL = {
    calibrationCertificate:   { parse: (text) => DigitalCalibrationCertificate.parseText(text),  what: 'digital calibration certificate' },
    certificateOfConformity:  { parse: (text) => DigitalCertificateOfConformity.parseText(text), what: 'digital certificate of conformity' },
    declarationOfConformity:  { parse: (text) => DigitalDeclarationOfConformity.parseText(text), what: 'digital declaration of conformity' },
};

/** The EVSE or charging station that holds an energy meter or is a charging station of the given identification, at runtime. */
function holderOfItem(network, item) {
    for (const operator of isArray(network.effectiveContent['chargingStationOperators']) ? network.effectiveContent['chargingStationOperators'] : [])
        for (const pool of isArray(operator['chargingPools']) ? operator['chargingPools'] : [])
            for (const station of isArray(pool['chargingStations']) ? pool['chargingStations'] : []) {
                if (item.type === 'ChargingStation' && String(station['@id']).replaceAll('*', '').toUpperCase() === item.id.replaceAll('*', '').toUpperCase())
                    return { type: 'ChargingStation', id: String(station['@id']), path: [ { array: 'chargingStationOperators', id: String(operator['@id']) }, { array: 'chargingPools', id: String(pool['@id']) }, { array: 'chargingStations', id: String(station['@id']) } ] };
                for (const evse of isArray(station['EVSEs']) ? station['EVSEs'] : [])
                    if (isObject(evse['energyMeter']) && String(evse['energyMeter']['@id']).toUpperCase() === item.id.toUpperCase())
                        return { type: 'EVSE', id: String(evse['@id']), meter: evse['energyMeter'],
                                 path: [ { array: 'chargingStationOperators', id: String(operator['@id']) }, { array: 'chargingPools', id: String(pool['@id']) }, { array: 'chargingStations', id: String(station['@id']) }, { array: 'EVSEs', id: String(evse['@id']) } ] };
            }
    return undefined;
}

/**
 * Reads every QI-Digital document as WWCP_POI reads it, checks it against the head of the network - signed by a key of its
 * issuer, a party of the network, that may sign it, valid when it signed and at `at`; its notified body, model and item
 * those of the network, the item as it is at runtime - and against each other: a declaration against the certificates it
 * names, a certificate against the item of a calibration certificate it covers.
 */
function analyzeQIDigital(pool, report, at, issue) {

    const network = report.head?.version.network;

    for (const document of pool.ofType('calibrationCertificate', 'certificateOfConformity', 'declarationOfConformity')) {

        const result = { document, kind: document.type, relations: [] };
        report.qiDigital.push(result);

        try {
            result.doc = QI_DIGITAL[document.type].parse(document.text);
        }
        catch (e) {
            result.ok = false;
            result.error = message(e);
            issue('error', `The ${QI_DIGITAL[document.type].what} '${document.name}' is refused as it is read: ${message(e)}`, document);
            continue;
        }

        if (network === undefined) {
            result.ok = undefined;
            result.error = 'There is no version of a roaming network to check it against.';
            continue;
        }

        try {
            result.doc.verify(network, at);
            result.ok = true;
            result.checkedAgainst = { epoch: report.head.epoch, revision: report.head.version.commit.revision };
        }
        catch (e) {
            result.ok = false;
            result.error = message(e);
            issue('error', `${result.doc.documentText[0].toUpperCase()}${result.doc.documentText.slice(1)} does not verify against the head: ${message(e)}`, document);
        }

        if (result.kind === 'calibrationCertificate')
            result.holder = holderOfItem(network, result.doc.item);

    }

    const of = (kind) => report.qiDigital.filter(item => item.kind === kind && item.doc !== undefined);

    // A declaration names the certificates of its notified bodies: each must be one it can be checked against.
    for (const declaration of of('declarationOfConformity'))
        for (const body of declaration.doc.notifiedBodies) {
            if (body.certificateId === undefined)
                continue;
            const certificate = of('certificateOfConformity').find(item => item.doc.id === body.certificateId);
            if (certificate === undefined) {
                declaration.relations.push({ label: `Names the certificate ${body.certificateId} of ${body.conformityAssessmentBodyId} (module ${body.module ?? '?'})`, ok: undefined, detail: 'not among the documents' });
                continue;
            }
            try {
                declaration.doc.verifyCertificate(certificate.doc);
                declaration.relations.push({ label: `The certificate ${body.certificateId} of ${body.conformityAssessmentBodyId} is the one it names: module ${body.module ?? '?'}, its model and legislation`, ok: true, ref: certificate.document });
            }
            catch (e) {
                declaration.relations.push({ label: `The certificate ${body.certificateId} it names`, ok: false, detail: message(e), ref: certificate.document });
            }
        }

    // A certificate covers what was calibrated: of its model and versions, or of a manufacturer whose quality system it approves.
    for (const certificate of of('certificateOfConformity'))
        for (const calibration of of('calibrationCertificate')) {
            try {
                certificate.doc.cover(calibration.doc.item);
                certificate.relations.push({ label: `Covers ${calibration.doc.item.text}, which ${calibration.doc.id} calibrated`, ok: true, ref: calibration.document });
                calibration.relations.push({ label: `${certificate.doc.id} (module ${certificate.doc.module}) covers its item`, ok: true, ref: certificate.document });
            }
            catch (e) {
                // Not a fault: another certificate may cover it. Shown, not counted.
                certificate.relations.push({ label: `Does not cover ${calibration.doc.item.text}`, ok: undefined, detail: message(e), ref: calibration.document });
            }
        }

}


/** The verdict of a report: what holds, in one line, and how good it is. */
function verdictOf(report) {

    const errors   = report.issues.filter(item => item.level === 'error').length;
    const warnings = report.issues.filter(item => item.level === 'warning').length;
    const commits  = report.epochs.reduce((sum, epoch) => sum + epoch.steps.filter(step => step.type === 'commit').length, 0);
    const cps      = report.epochs.reduce((sum, epoch) => sum + epoch.steps.filter(step => step.type === 'checkpoint').length, 0);

    if (report.head === undefined && report.proofs.length === 0 && report.evidence.length === 0)
        return { level: errors > 0 ? 'error' : 'info', commits, checkpoints: cps, errors, warnings };

    return { level: errors > 0 ? 'error' : warnings > 0 ? 'warn' : 'ok', commits, checkpoints: cps, errors, warnings };

}

export { sameETags };
