/*
 * Where an EV driver pays ad hoc, as the static data say it: the web payment page of a charging station operator, a
 * charging pool and a charging station (`webPaymentURL`, WWCP_POI docs/ChargingStationOperator.md, "Web payment page"), and
 * where an app asks the EV Taler merchant of an operator for offers (`offersURL`, EVTaler.md section 6).
 *
 * Nothing here asks either of them anything: the page says where an app would go, not what it finds there.
 */

const textOf = (value) => typeof value === 'string' && value !== '' ? value : undefined;

const TYPES = [
    [ 'chargingStation', 'ChargingStation'         ],
    [ 'chargingPool',    'ChargingPool'            ],
    [ 'operator',        'ChargingStationOperator' ],
];


/**
 * The web payment page that applies, given the effective charging station, its effective charging pool and their operator,
 * each of them optional: for a charging station its own comes first, then that of its pool, then the operator's; undefined
 * where none of them names one.
 */
export function webPaymentPageOf(entities) {

    for (const [ property, type ] of TYPES.filter(([ property ]) => entities[property] !== undefined)) {
        const url = textOf(entities[property]['webPaymentURL']);
        if (url !== undefined)
            return { url, type, id: String(entities[property]['@id']) };
    }

    return undefined;

}

/** Where an app asks for a session at an EVSE, and gets its steps as offers: `POST {offersURL}EVSEs/{EVSE_Id}/evTaler/sessions`. */
export const offersSessionsURL = (offersURL, evseId) => `${offersURL}EVSEs/${evseId}/evTaler/sessions`;
