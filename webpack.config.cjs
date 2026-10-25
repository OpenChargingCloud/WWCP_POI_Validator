'use strict';

const path            = require('path');
const webpack         = require('webpack');
const CopyPlugin      = require('copy-webpack-plugin');
const TerserPlugin    = require('terser-webpack-plugin');

const appVersion      = require('./package.json').version;
const poiVersion      = require('@open-charging-cloud/wwcp-poi/package.json').version;

module.exports = {

    mode:    'production',
    entry:   './src/main.js',
    target:  ['web', 'es2022'],
    devtool: false,

    output: {
        path:     path.resolve(__dirname, 'dist'),
        filename: 'validator.js',
        clean:    true
    },

    resolve: {
        // WWCP_POI.TS is linked from ../WWCP_POI.TS: its own dependencies are resolved from there.
        symlinks: true
    },

    plugins: [
        new webpack.DefinePlugin({
            __APP_VERSION__:  JSON.stringify(appVersion),
            __POI_VERSION__:  JSON.stringify(poiVersion)
        }),
        new CopyPlugin({
            patterns: [
                { from: 'src/index.html',                          to: 'index.html' },
                { from: 'src/styles.css',                          to: 'styles.css' },
                { from: 'node_modules/leaflet/dist/leaflet.css',   to: 'leaflet.css' },
                { from: 'demo',                                    to: 'demo', globOptions: { ignore: [ '**/README.md' ] } }
            ]
        })
    ],

    optimization: {
        minimizer: [
            new TerserPlugin({
                // Keep the /*! … */ license banners of the bundled libraries inside validator.js.
                extractComments: false,
                terserOptions: { format: { comments: /^\**!/ } }
            })
        ]
    },

    performance: {
        // The bundle carries the COSE algorithms (ECDSA, EdDSA, ML-DSA) and Leaflet; the size is intentional.
        hints: false
    }

};
