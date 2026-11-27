/*
 * How EV drivers authenticate at a charging pool: its authentication modes, and the channels its stations give the URL of
 * their secure dynamic QR code over.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticationModesOf, channelText, secureDynamicQRCodeOf } from '../src/authentication.js';

const pool = (authenticationModes) => ({ '@id': 'DE*GEF*P1', ...(authenticationModes !== undefined ? { authenticationModes } : {}) });

test('Authentication modes: each with what its type has, in the order the pool gives them', () => {

    const modes = authenticationModesOf(pool([
        { type: 'RFID', cardTypes: [ 'MifareClassic', 'MifareDESFire' ], brands: [ { '@id': 'gef', name: { en: 'GraphDefined' } } ] },
        { type: 'SMS', number: '+49 3641 000000', stationCode: 'S1' },
        { type: 'SecureDynamicQRCode', channels: [ 'BLE', 'Display', 'NFC' ] },
    ]));

    assert.deepEqual(modes.map(mode => mode.type), [ 'RFID', 'SMS', 'SecureDynamicQRCode' ]);
    assert.deepEqual(modes[0].cardTypes, [ 'MifareClassic', 'MifareDESFire' ]);
    assert.deepEqual(modes[0].brands,    [ { id: 'gef', name: { en: 'GraphDefined' } } ]);
    assert.deepEqual([ modes[1].number, modes[1].stationCode ], [ '+49 3641 000000', 'S1' ]);
    assert.deepEqual(modes[2].channels,  [ 'BLE', 'Display', 'NFC' ]);
    assert.deepEqual(modes[0].channels,  []);

});

test('Authentication modes: none for a pool naming none, and what is no mode is passed over', () => {

    assert.deepEqual(authenticationModesOf(pool()), []);
    assert.deepEqual(authenticationModesOf(undefined), []);
    assert.deepEqual(authenticationModesOf(pool('RFID')), []);
    assert.deepEqual(authenticationModesOf(pool([ 'RFID', { cardTypes: [ 'Calypso' ] }, { type: '' }, { type: 'REMOTE' } ])).map(mode => mode.type), [ 'REMOTE' ]);

});

test('Secure dynamic QR code: the channels of the pool, and none where it does not name the mode', () => {

    assert.deepEqual(secureDynamicQRCodeOf(pool([ { type: 'RFID' }, { type: 'SecureDynamicQRCode', channels: [ 'Display' ] } ])), { poolId: 'DE*GEF*P1', channels: [ 'Display' ] });
    assert.deepEqual(secureDynamicQRCodeOf(pool([ { type: 'SecureDynamicQRCode' } ])),                                         { poolId: 'DE*GEF*P1', channels: [] });
    assert.equal(secureDynamicQRCodeOf(pool([ { type: 'RFID' } ])), undefined);
    assert.equal(secureDynamicQRCodeOf(pool()), undefined);
    assert.equal(secureDynamicQRCodeOf(undefined), undefined);

    assert.match(channelText('Display'), /display/);
    assert.match(channelText('BLE'),     /Bluetooth Low Energy/);
    assert.match(channelText('Beacon'),  /'Beacon', a channel this page does not know/);

});
