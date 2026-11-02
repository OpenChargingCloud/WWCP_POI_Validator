/*
 * Charging sessions as an app checks them (WWCP_POI.TS 0.2.0): a session as Chargy writes it, with the evidence of WWCP POI
 * for it - the proof of its charging station, historical evidence of its meter and the key it signs with, the prices bound
 * to the session and the receipts of their publication. Each is checked with the trust anchor of the settings and the
 * identity keys the user trusts there, a trust context: the trust anchor a session brings authorizes nothing by itself.
 *
 * The measurements themselves, signed by the meter, are Chargy's to check; this checks what WWCP POI says of them: whether
 * the key they are signed with is the one the network states for the meter of the EVSE, now and when it measured, and by
 * which prices the session is charged.
 */

import {
    HistoricalTrustContext, RoamingNetworkOperator, TrustAnchor, TrustContext, fromBase64, get, hash, isObject, toHex,
    verifyHistoricalMeterEvidence, verifyMeterKey, verifySessionPriceEvidence,
} from '@open-charging-cloud/wwcp-poi';


const message = (e) => e instanceof Error ? e.message : String(e);

/** The key format of the meters of the sessions: a public key in SubjectPublicKeyInfo, as Chargy gives it (`publicKey`). */
const KEY_FORMAT = 'spki-der';


/** The payload of an OCMF document, `OCMF|{payload}|{signature}`. */
function ocmfPayload(text) {
    const parts = text.split('|');
    if (parts[0] !== 'OCMF' || parts.length < 2)
        throw new Error('It is no OCMF document.');
    return JSON.parse(parts[1]);
}

/** A time as OCMF writes it, `2026-06-01T10:00:00,000+0000 S`, in milliseconds. */
export function ocmfTime(text) {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}),(\d{3})([+-]\d{2})(\d{2})/.exec(String(text));
    if (match === null)
        throw new Error(`'${text}' is no time as OCMF writes it.`);
    return Date.parse(`${match[1]}.${match[2]}${match[3]}:${match[4]}`);
}

/**
 * What the readings of a session say: the serial number of the meter, the readings with their times, and the SHA-256 of
 * the document of the start, which the agreement of the prices names.
 */
function readingsOf(json) {

    const begin = get(json, 'ocmfBegin');
    const end   = get(json, 'ocmfEnd');

    if (typeof begin !== 'string' || typeof end !== 'string')
        throw new Error('The session holds no OCMF readings: its meter and the times of its readings can not be read.');

    const first    = ocmfPayload(begin);
    const last     = ocmfPayload(end);
    const readings = [ ...(first.RD ?? []), ...(last.RD ?? []) ].map(item => ({ time: ocmfTime(item.TM), value: item.RV, unit: item.RU, kind: item.TX }));

    if (typeof first.MS !== 'string' || readings.length === 0)
        throw new Error('Its OCMF readings name no meter or no reading.');

    return {
        meterSerialNumber:    first.MS,
        meterManufacturer:    first.MM,
        readings,
        startDocumentSHA256:  toHex(hash('sha256', new TextEncoder().encode(begin))),
    };

}

/** Whether a key the network binds to the meter is the one of the session, by the SHA-256 of its SubjectPublicKeyInfo. */
function sessionKey(json, key) {
    const text = get(json, 'publicKey');
    if (typeof text !== 'string' || key.idScheme !== 'sha256-spki')
        return undefined;
    try {
        return toHex(hash('sha256', fromBase64(text))) === key.id;
    }
    catch {
        return false;
    }
}

/** Whether two trust anchors are one: the same network, the same identity keys of the same holders, the same quorum. */
function sameAnchor(left, right) {
    const holders = (anchor) => anchor.holders.map(keys => [ ...keys ].sort().join(',')).sort().join(';');
    return left.id === right.id && left.minConsensus === right.minConsensus && holders(left) === holders(right);
}


/**
 * Checks the charging sessions of the pool. `settings`: `anchor` (the trust anchor of the settings), `trustedIdentityKeyIds`
 * (its keys the user trusts; all of them when undefined), `at`, `witnesses` and `requiredWitnesses` (of the checkpoints),
 * `publicationPolicy` (whose receipts of a publication of prices count). Every finding goes to `issue`.
 */
export function analyzeSessions(documents, settings, issue) {

    const { anchor, at, witnesses, requiredWitnesses, publicationPolicy } = settings;

    return documents.map(document => {

        const json     = document.json;
        const evidence = get(json, 'poiEvidence');
        const result   = {
            document,
            evseId:            String(get(evidence, 'EVSEId') ?? get(json, 'chargeboxIdentifier') ?? ''),
            roamingNetworkId:  get(evidence, 'roamingNetworkId'),
            offeredAnchor:     get(get(evidence, 'bootstrap') ?? {}, 'trustAnchor'),
        };

        const refuse = (text, level = 'error') => {
            result.error = text;
            issue(level, `The charging session '${document.name}': ${text}`, document);
            return result;
        };

        try {
            result.readings = readingsOf(json);
        }
        catch (e) {
            return refuse(message(e));
        }

        // Whose trust anchor: the one of the settings, never the one the session brings.
        if (anchor === undefined) {
            result.authority = 'none';
            return refuse('it brings a trust anchor, which is trusted by nobody by itself: take it into the settings, or give the one you trust.', 'warning');
        }

        try {
            const offered = TrustAnchor.parse(String(result.offeredAnchor));
            if (!sameAnchor(offered, anchor)) {
                result.authority = 'other';
                return refuse(`it is of the roaming network '${offered.id}' with other identity keys than the trust anchor of the settings, of '${anchor.id}'.`, 'warning');
            }
        }
        catch (e) {
            result.authority = 'invalid';
            return refuse(`the trust anchor it brings can not be read: ${message(e)}`);
        }

        result.authority = 'pinned';

        // The key statement of its operator, against the identity keys trusted here: a trust context, or why there is none.
        let current;
        let historical;

        try {
            const operator = RoamingNetworkOperator.parse(get(get(evidence, 'bootstrap'), 'keyStatement'), anchor.id);
            if (operator.keyStatement === undefined)
                return refuse('its operator gives no key statement.');
            const options = { trustedIdentityKeyIds: settings.trustedIdentityKeyIds ?? anchor.keys, otherIdentityKeys: operator.identityKeys };
            result.evaluation = TrustContext.evaluate(anchor, operator.keyStatement, { ...options, at });
            current = result.evaluation.context;
            if (current === undefined)
                return refuse(`the identity keys trusted here give no trust context for the key statement of its operator: ${(result.evaluation.verificationError ?? 'signatures, signers, quorum or validity do not hold.').replace(/[^.!?]$/, '$&.')}`);
            historical = HistoricalTrustContext.create(anchor, operator.keyStatement, { ...options, now: at });
        }
        catch (e) {
            return refuse(`the key statement of its operator: ${message(e)}`);
        }

        const policy  = { witnesses, requiredWitnesses };
        const request = { evseId: result.evseId, meterSerialNumber: result.readings.meterSerialNumber, keyFormat: KEY_FORMAT };
        const part    = (name, check) => {
            try {
                return check();
            }
            catch (e) {
                issue('error', `The charging session '${document.name}': ${name}: ${message(e)}`, document);
                return { error: message(e) };
            }
        };

        // The meter and its key, as the proof of the station states them now.
        if (isObject(get(evidence, 'chargingStationProof')))
            result.meterKey = part('the meter of its EVSE', () => {
                const binding = verifyMeterKey(current, get(evidence, 'chargingStationProof'), request);
                return { binding, sessionKey: sessionKey(json, binding.key) };
            });

        // … and as the network stated them when the meter measured, with the checkpoints naming those versions.
        if (isObject(get(evidence, 'historicalEvidence')))
            result.historical = part('the historical evidence of its meter', () => {
                const verification = verifyHistoricalMeterEvidence(current, get(evidence, 'historicalEvidence'),
                                                                   { ...request, measurementTimes: result.readings.readings.map(item => item.time) }, policy);
                return { verification, sessionKey: verification.bindings.every(binding => sessionKey(json, binding.key) !== false) };
            });

        // The prices bound to the session at its start, and the receipts of their publication.
        if (isObject(get(evidence, 'priceEvidence')))
            result.prices = part('its prices', () => {
                const verification = verifySessionPriceEvidence(historical, get(evidence, 'priceEvidence'),
                                                                { evseId: result.evseId, meterSerialNumber: result.readings.meterSerialNumber,
                                                                  chargingStarted: result.readings.readings[0].time, startDocumentSHA256: result.readings.startDocumentSHA256 },
                                                                { ...policy, publicationPolicy });
                const refused = Object.entries(REFUSALS).filter(([ key ]) => verification[key] === 'invalid').map(([ key, text ]) => {
                    // Why, as WWCP_POI.TS says it: for receipts, what each one refused says of itself.
                    const why = key === 'publicationBeforeStart'
                                    ? (verification.publicationWitnesses?.receipts ?? []).filter(item => item.status === 'invalid').map(item => `${item.witnessId ? item.witnessId + ": " : ""}${item.detail}`)
                                    : verification.diagnostics;
                    return `${text}${why.length ? ` (${why.join('; ')})` : ''}`;
                });
                for (const text of refused)
                    issue('error', `The charging session '${document.name}': ${text}.`, document);
                return { verification, refused };
            });

        result.ok = [ result.meterKey, result.historical, result.prices ].every(item => item === undefined || (item.error === undefined && !item.refused?.length));

        return result;

    });

}

/** What an invalid result of `verifySessionPriceEvidence` says, by its key. */
const REFUSALS = {
    signatures:              'a price statement of it does not verify',
    agreement:               'the agreement binding its prices to its start does not verify',
    applicability:           'its prices can not be bound to it',
    publication:             'the publication of its prices in a checkpoint does not verify',
    publicationBeforeStart:  'a receipt of the publication of its prices is refused',
};
