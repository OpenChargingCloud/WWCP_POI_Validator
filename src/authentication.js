/*
 * How EV drivers authenticate at a charging pool, as its static data say it: the authentication modes of the pool
 * (`authenticationModes`, WWCP_POI docs/ChargingPool.md, "Authentication modes"), and among them the secure dynamic QR
 * code of its stations with the channels they give its URL over.
 *
 * That URL carries a time-based one-time password, as OCPP 2.1's WebPaymentsCtrlr makes it: whoever names the password
 * stands at the EVSE. Every EV Taler session names it (EVTaler.md, decision D8), so a pool that is paid with EV Taler
 * names this mode: an app reads here where it gets the code, and does not fail at a station with a static sticker.
 *
 * The URL itself is of one EVSE at one moment, and never part of these data: nothing here reads or checks a code.
 */

/** The type of the authentication mode of a secure dynamic QR code. */
export const SECURE_DYNAMIC_QR_CODE = 'SecureDynamicQRCode';

/** The channels a station gives the URL of its secure dynamic QR code over, and how a driver gets it there. */
export const SECURE_DYNAMIC_QR_CODE_CHANNELS = new Map([
    [ 'BLE',     'over Bluetooth Low Energy, read by an app nearby' ],
    [ 'Display', 'on its display, as a QR code to scan'             ],
    [ 'NFC',     'over NFC, read by a phone held to it'             ],
]);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf   = (value) => typeof value === 'string' && value !== '' ? value : undefined;
const textsOf  = (value) => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

/**
 * The authentication modes of the given charging pool, as it is effective, in the order it gives them: of each its type,
 * and what its type has, the card types and the brands of RFID, the number and the station code of an SMS or a phone
 * call, the channels of a secure dynamic QR code. None for a pool naming none, or for no pool.
 */
export function authenticationModesOf(chargingPool) {

    const modes = isObject(chargingPool) && Array.isArray(chargingPool['authenticationModes']) ? chargingPool['authenticationModes'] : [];

    return modes.filter(isObject).flatMap(mode => {

        const type = textOf(mode['type']);

        return type === undefined
                   ? []
                   : [ {
                         type,
                         cardTypes:    textsOf(mode['cardTypes']),
                         brands:       (Array.isArray(mode['brands']) ? mode['brands'] : []).filter(isObject).map(brand => ({ id: String(brand['@id']), name: brand['name'] })),
                         number:       textOf(mode['number']),
                         stationCode:  textOf(mode['stationCode']),
                         channels:     textsOf(mode['channels']),
                     } ];

    });

}

/**
 * The secure dynamic QR code of the stations of the given charging pool: the channels they give its URL over, as the pool
 * names them; undefined where the pool does not name the mode, so that its stations show at most a static code.
 */
export function secureDynamicQRCodeOf(chargingPool) {

    const mode = authenticationModesOf(chargingPool).find(({ type }) => type === SECURE_DYNAMIC_QR_CODE);

    return mode === undefined
               ? undefined
               : { poolId: String(chargingPool['@id']), channels: mode.channels };

}

/** How a driver gets the URL of the code over the given channel; the name of a channel this page does not know as it is. */
export const channelText = (channel) => SECURE_DYNAMIC_QR_CODE_CHANNELS.get(channel) ?? `over '${channel}', a channel this page does not know`;
