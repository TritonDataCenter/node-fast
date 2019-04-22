/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * test/tst.crc_mode.js: tests for CRC compatibility mode validations
 *
 * Tests for CRC compatibility mode validations. For more details about this see
 * the fast_protocol module documentation.
 */

var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_net = require('net');
var mod_path = require('path');
var mod_vasync = require('vasync');

var mod_fast = require('../lib/fast');
var mod_protocol = require('../lib/fast_protocol');
var mod_testcommon = require('./common');


function main() {
	var serverSocket, csock;
	var serverPort = mod_testcommon.serverPort;
	var serverIp = mod_testcommon.serverIp;

	var log = new mod_bunyan({
	    'name': mod_path.basename(__filename),
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	var barrier = mod_vasync.barrier();
	barrier.start('crc test run');

	barrier.on('drain', function () {
		log.info('all test cases complete');
	});


	mod_testcommon.mockServerSetup(function (s) {
		log.info('server listening');
		serverSocket = s;

		mod_vasync.pipeline({ 'funcs': [
			function create_connection(_, next) {
				csock = mod_net.createConnection(serverPort,
				    serverIp);
				next();
			},
			function create_fast_client_ok(_, next) {
				createFastClientOk(log, csock, next);
			},
			function create_fast_client_fail(_, next) {
				createFastClientFail(log, csock, next);
			},
			function create_fast_server_ok(_, next) {
				createFastServerOk(log, serverSocket, next);
			},
			function create_fast_server_fail(_, next) {
				createFastServerFail(log, serverSocket, next);
			},
			function fast_message_encode_ok(_, next) {
				fastMessageEncodeOk(log, next);
			},
			function fast_message_encode_fail(_, next) {
				fastMessageEncodeFail(log, next);
			}

		]}, function (err) {
			if (err) {
				throw (err);
			}

			csock.destroy();
			mod_testcommon.mockServerTeardown(serverSocket);

			barrier.done('crc test run');
		});
	});
}

/*
 * Test to ensure FastClients can be created with valid CRC mode values.
 */
function createFastClientOk(l, transport, cb) {
	try {
		var client1 = new mod_fast.FastClient({
		    'log': l,
		    'transport': transport,
		    'nRecentRequests': 100,
		    'crc_mode': mod_fast.FAST_CHECKSUM_V1
		});
		var client2 = new mod_fast.FastClient({
		    'log': l,
		    'transport': transport,
		    'nRecentRequests': 100,
		    'crc_mode': mod_fast.FAST_CHECKSUM_V2
		});
		l.info('created fast clients');
		client1.detach();
		client2.detach();
		mod_assertplus.ok(true);
	} catch (ex) {
		mod_assertplus.fail('failed to create FastClient with valid ' +
		    'CRC mode');
		l.info('did not create fast client');
	}

	cb();
}

/*
 * Test to ensure an attempt to create a FastClient with invalid CRC mode
 * values fails.
 */
function createFastClientFail(l, transport, cb) {
	try {
		var client1 = new mod_fast.FastClient({
		    'log': l,
		    'transport': transport,
		    'nRecentRequests': 100,
		    'crc_mode': mod_fast.FAST_CHECKSUM_V1_V2
		});
		l.info('created fast client');
		client1.detach();
	} catch (ex1) {
		try {
			var client2 = new mod_fast.FastClient({
			    'log': l,
			    'transport': transport,
			    'nRecentRequests': 100,
			    'crc_mode': 42 // An invalid CRC mode value
			});
			l.info('created fast client');
			client2.detach();
		} catch (ex2) {
			mod_assertplus.ok(true);
			l.info('did not create fast client');
			cb();
			return;
		}
	}

	mod_assertplus.fail('failed to reject invalid FastClient CRC mode');
	cb();
}

/*
 * Test to ensure FastServers can be created with valid CRC mode values.
 */
function createFastServerOk(l, server_sock, cb) {
	try {
		var server1 = new mod_fast.FastServer({
		    'log': l,
		    'server': server_sock,
		    'crc_mode': mod_fast.FAST_CHECKSUM_V1
		});
		server1.close();
		var server2 = new mod_fast.FastServer({
		    'log': l,
		    'server': server_sock,
		    'crc_mode': mod_fast.FAST_CHECKSUM_V2
		});
		server2.close();
		var server3 = new mod_fast.FastServer({
		    'log': l,
		    'server': server_sock,
		    'crc_mode': mod_fast.FAST_CHECKSUM_V1_V2
		});
		server3.close();
		mod_assertplus.ok(true);
	} catch (ex1) {
		mod_assertplus.fail('failed to create FastServer with valid ' +
		    'CRC mode');
		l.info('did not create fast client');
	}

	cb();
}

/*
 * Test to ensure an attempt to create a FastServer with invalid CRC mode
 * values fails.
 */
function createFastServerFail(l, server_sock, cb) {
	try {
		var server1 = new mod_fast.FastServer({
		    'log': l,
		    'server': server_sock,
		    'crc_mode': 140
		});
		server1.close();
	} catch (ex1) {
		mod_assertplus.ok(true);
		l.info('did not create fast client');
		cb();
		return;
	}

	mod_assertplus.fail('failed to reject invalid FastServer CRC mode');
	cb();
}

function fastMessageEncodeOk(l, cb) {
	var msg1 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ]
	};
	var msg2 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ],
	    'crc_mode': mod_fast.FAST_CHECKSUM_V1
	};
	var msg3 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ],
	    'crc_mode': mod_fast.FAST_CHECKSUM_V2
	};
	try {
		mod_protocol.fastMessageEncode(msg1);
		mod_protocol.fastMessageEncode(msg2);
		mod_protocol.fastMessageEncode(msg3);
		mod_protocol.fastMessageEncode(msg1, mod_fast.FAST_CHECKSUM_V1);
		mod_protocol.fastMessageEncode(msg2, mod_fast.FAST_CHECKSUM_V1);
		mod_protocol.fastMessageEncode(msg3, mod_fast.FAST_CHECKSUM_V1);
		mod_protocol.fastMessageEncode(msg1, mod_fast.FAST_CHECKSUM_V2);
		mod_protocol.fastMessageEncode(msg2, mod_fast.FAST_CHECKSUM_V2);
		mod_protocol.fastMessageEncode(msg3, mod_fast.FAST_CHECKSUM_V2);
		mod_assertplus.ok(true);
	} catch (ex) {
		mod_assertplus.fail('fastMessageEncode failed with valid ' +
		    'CRC mode: ' + ex.message);
		l.info('fastMessageEncode failed');
	}

	cb();
}

function fastMessageEncodeFail(l, cb) {
	var msg1 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ]
	};
	var msg2 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ],
	    'crc_mode': mod_fast.FAST_CHECKSUM_V1_V2
	};
	var msg3 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ],
	    'crc_mode': 50
	};
	var msg4 = {
	    'msgid': 1,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': [ 'hello', 'world' ],
	    'crc_mode': mod_fast.FAST_CHECKSUM_V2
	};

	try {
		mod_protocol.fastMessageEncode(msg1,
		    mod_fast.FAST_CHECKSUM_V1_V2);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode FAST_CHECKSUM_V1_V2');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg1, 50);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode 50 ');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg2,
		    mod_fast.FAST_CHECKSUM_V1_V2);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode FAST_CHECKSUM_V1_V2');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg2,
		    mod_fast.FAST_CHECKSUM_V2);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode FAST_CHECKSUM_V1_V2');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg2);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode FAST_CHECKSUM_V1_V2');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg3, 50);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode 50');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg3);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode 50');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg3, mod_fast.FAST_CHECKSUM_V2);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'CRC mode 50');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	try {
		mod_protocol.fastMessageEncode(msg4, 45);
		mod_assertplus.fail('fastMessageEncode allowed invalid ' +
		    'default CRC mode 45');
		cb();
		return;
	} catch (ex) {
		mod_assertplus.ok(true);
	}

	cb();
}

main();
