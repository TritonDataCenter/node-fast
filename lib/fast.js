/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/fast.js: public node-fast interface
 */

var mod_client = require('./fast_client');
var mod_server = require('./fast_server');
var mod_protocol = require('./fast_protocol');

exports.FastClient = mod_client.FastClient;
exports.FastServer = mod_server.FastServer;
exports.FAST_CHECKSUM_V1 = mod_protocol.FAST_CHECKSUM_V1;
exports.FAST_CHECKSUM_V1_V2 = mod_protocol.FAST_CHECKSUM_V1_V2;
exports.FAST_CHECKSUM_V2 = mod_protocol.FAST_CHECKSUM_V2;
