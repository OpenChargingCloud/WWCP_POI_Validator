/*
 * Where an EV driver pays ad hoc: the web payment page that applies to a charging station, a charging pool and their
 * operator, and where an app asks an EV Taler merchant for offers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { offersSessionsURL, webPaymentPageOf } from '../src/payments.js';


const operator = (webPaymentURL) => ({ '@id': 'DE*GEF',    ...(webPaymentURL ? { webPaymentURL } : {}) });
const pool     = (webPaymentURL) => ({ '@id': 'DE*GEF*P1', ...(webPaymentURL ? { webPaymentURL } : {}) });
const station  = (webPaymentURL) => ({ '@id': 'DE*GEF*S1', ...(webPaymentURL ? { webPaymentURL } : {}) });


test('The web payment page: of a station its own first, then that of its pool, then the operator\'s', () => {

    const all = { operator: operator('https://pay.gef.example/'), chargingPool: pool('https://pay.gef.example/pools/P1'), chargingStation: station('https://pay.gef.example/stations/S1') };

    assert.deepEqual(webPaymentPageOf(all),                                    { url: 'https://pay.gef.example/stations/S1', type: 'ChargingStation',         id: 'DE*GEF*S1' });
    assert.deepEqual(webPaymentPageOf({ ...all, chargingStation: station() }), { url: 'https://pay.gef.example/pools/P1',    type: 'ChargingPool',            id: 'DE*GEF*P1' });
    assert.deepEqual(webPaymentPageOf({ ...all, chargingStation: station(), chargingPool: pool() }),
                                                                               { url: 'https://pay.gef.example/',            type: 'ChargingStationOperator', id: 'DE*GEF' });

    // Of a pool and of an operator: nothing below them counts.
    assert.deepEqual(webPaymentPageOf({ operator: all.operator, chargingPool: all.chargingPool }).type, 'ChargingPool');
    assert.deepEqual(webPaymentPageOf({ operator: all.operator }).type, 'ChargingStationOperator');

});

test('The web payment page: none where none of them names one, and no text is none', () => {

    assert.equal(webPaymentPageOf({ operator: operator(), chargingPool: pool(), chargingStation: station() }), undefined);
    assert.equal(webPaymentPageOf({ operator: { '@id': 'DE*GEF', webPaymentURL: 42 } }), undefined);
    assert.equal(webPaymentPageOf({}), undefined);

});

test('Offers: an app posts to EVSEs/{EVSE_Id}/evTaler/sessions under the offers URL of the merchant', () => {

    assert.equal(offersSessionsURL('https://poi.gef.example/RNs/QA/', 'DE*GEF*E1*1'), 'https://poi.gef.example/RNs/QA/EVSEs/DE*GEF*E1*1/evTaler/sessions');

});
