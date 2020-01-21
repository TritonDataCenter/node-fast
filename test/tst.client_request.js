/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * test/tst.client_request.js: client API per-request test suite
 *
 * This file contains a test runner (runTestCase) that executes test cases
 * following a very prescribed form, where a client connects to the server, the
 * server handles the request (often in surprising ways), and the client reports
 * some number of errors.  This allows us to exercise a lot of different cases,
 * including normal, valid RPC calls, RPC calls that return lots of data, and
 * various edge cases like invalid messages and unexpected end-of-stream events.
 * There are some test cases that require more control over client-server
 * interaction.  These are defined in tst.client_generic.js.
 */

var mod_artedi = require('artedi');
var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_microtime = require('microtime');
var mod_net = require('net');
var mod_path = require('path');
var mod_vasync = require('vasync');
var VError = require('verror');

var mod_client = require('../lib/fast_client');
var mod_protocol = require('../lib/fast_protocol');
var mod_testclient = require('./common/client');
var mod_testcommon = require('./common');

var testLog;
var startUts;
var serverSocket;
var serverPort = mod_testcommon.serverPort;
var serverIp = mod_testcommon.serverIp;

function main()
{
	testLog = new mod_bunyan({
	    'name': mod_path.basename(__filename),
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	startUts = mod_microtime.now();

	mod_testcommon.registerExitBlocker('test run');
	mod_testcommon.mockServerSetup(function (s) {
		testLog.info('server listening');
		serverSocket = s;

		mod_vasync.forEachPipeline({
		    'inputs': mockResponders,
		    'func': runTestCase
		}, function (err) {
			if (err) {
				throw (err);
			}

			mod_testcommon.unregisterExitBlocker('test run');
			mod_testcommon.mockServerTeardown(serverSocket);
			console.log('%s tests passed',
			    mod_path.basename(__filename));
		});
	});
}

function runTestCase(testcase, callback) {
	var ctc, ctr;
	var collector;

	collector = mod_artedi.createCollector({labels: {
		service: 'tst.client_request'
	}});

	console.log('test case: %s', testcase.name);
	ctc = new mod_testclient.ClientTestContext({
	    'collector': collector,
	    'server': serverSocket,
	    'log': testLog.child({ 'testcase': testcase['name'] })
	});

	ctc.establishConnection();
	ctc.ctc_server_decoder.once('data', function (message) {
		ctc.ctc_server_message = message;
		testcase['serverReply'](ctc.ctc_server_sock, message,
		    ctc.ctc_server_encoder, ctc.ctc_server_decoder);
	});

	ctc.ctc_server_decoder.on('error', function (err) {
		testcase['serverReply'](ctc.ctc_server_sock, err,
		    ctc.ctc_server_encoder, ctc.ctc_server_decoder);
	});

	ctr = ctc.makeRequest(function () {
		if (testcase.hasOwnProperty('artediPromCheck')) {
			/*
			 * Function provided to check the Prometheus formatted
			 * metrics.
			 */
			collector.collect(mod_artedi.FMT_PROM,
			    function _outputMetrics(err, metrics) {
				mod_assertplus.ok(!err);
				testcase['artediPromCheck'](metrics);
			});
		}
		testcase['clientCheck'](ctr.ctr_data, {
		    'socket': ctc.ctc_error_sock,
		    'client': ctc.ctc_error_client,
		    'request': ctr.ctr_error
		});

		ctc.cleanup();
		callback();
	});
}

/*
 * "mockResponders" describes a bunch of client test cases by describing what
 * the server should do and what users of the client API should see when that
 * happens.
 *
 *     name          a human-readable label for this test case
 *
 *     serverReply   a function invoked when the client makes this request.
 *                   This function implements the server's response.  The
 *                   function is invoked as:
 *
 *                       serverReply(socket, message, encoder)
 *
 *                   where
 *
 *               socket     the net.Socket connected to the client, which is
 *                          useful for injecting malformed responses or
 *                          generating socket errors
 *
 *               message    the first well-formed message read from the socket,
 *                          which is useful for common test cases of responding
 *                          to a basic RPC request
 *
 *               encoder    a FastMessageEncoder connected to the socket, which
 *                          is convenient for sending well-formed responses.
 *
 *               decoder    a FastMessageDecoder connected to the socket, which
 *                          is convenient for receiving well-formed messages
 *
 *     clientCheck   a function invoked after the test case has completed in
 *                   order to verify client behavior.  It's invoked as:
 *
 *                       clientCheck(data, error)
 *
 *                   where
 *
 *               data    an array of "data" events emitted by the client
 *
 *               errors  an object with properties for each possible error
 *                       emitted during the test, including "socket", "client",
 *                       and "request".
 *
 *     artediPromCheck  an optional function invoked after the test case has
 *                      completed in order to verify the Prometheus-formatted
 *                      artedi metrics for this request. It is invoked as:
 *
 *                          artediPromCheck(metrics)
 *
 *                      where
 *
 *                metrics  is a multi-line string containing the metrics for
 *                         this request.
 */

var mockResponders = [ {
    'name': 'ok, no data',
    'serverReply': function (socket, message, encoder) {
	assertNormalRequest(message);
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': mod_testcommon.dummyResponseEndEmpty,
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.equal(data.length, 0);
    }

}, {
    'name': 'ok, with 4 data messages, with 0-4 data objects per message',
    'serverReply': function (socket, message, encoder) {
	var nmessages, i, j, d;

	assertNormalRequest(message);
	nmessages = 5;
	for (i = 0; i < nmessages; i++) {
		d = [];
		for (j = 0; j < i; j++) {
			d.push('string ' + i + '_' + j);
		}
		encoder.write({
		    'msgid': message.msgid,
		    'status': i == nmessages - 1 ?
			mod_protocol.FP_STATUS_END :
			mod_protocol.FP_STATUS_DATA,
		    'data': { 'd': d },
		    'version': mod_protocol.FP_VERSION_CURRENT
		});
	}

	encoder.end();
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.deepEqual(data, [
	    'string 1_0', 'string 2_0', 'string 2_1', 'string 3_0',
	    'string 3_1', 'string 3_2', 'string 4_0', 'string 4_1',
	    'string 4_2', 'string 4_3'
	]);
    }

}, {
    'name': 'error, no data',
    'serverReply': function (socket, message, encoder) {
	assertNormalRequest(message);
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': mod_testcommon.dummyResponseError,
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);
	assertServerError(errors.request, mod_testcommon.dummyError);
    }

}, {
    'name': 'error, after data',
    'serverReply': function (socket, message, encoder) {
	var nmessages, i;
	assertNormalRequest(message);

	nmessages = 5;
	for (i = 0; i < nmessages; i++) {
		encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': mod_testcommon.dummyResponseData,
		    'version': mod_protocol.FP_VERSION_CURRENT
		});
	}

	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': mod_testcommon.dummyResponseError,
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	var i;
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 5);

	for (i = 0; i < data.length; i++) {
		mod_assertplus.deepEqual(data[i], mod_testcommon.dummyValue);
	}

	assertServerError(errors.request, mod_testcommon.dummyError);
    }

}, {
    'name': 'error with extra properties',
    'serverReply': function (socket, message, encoder) {
	/*
	 * The "context" and "ase_errors" properties are supposed to be
	 * preserved for historical reasons, but other miscellaneous properties
	 * do not get transmitted.
	 */
	assertNormalRequest(message);
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': {
		'd': {
		    'name': 'DummyError',
		    'message': 'a dummy message',
		    'someOtherProp': 'bogus',
		    'context': 'abc123',
		    'ase_errors': [ 'foobar' ]
		}
	    },
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	var error;

	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	error = errors.request;
	mod_assertplus.equal(error.name, 'FastRequestError');
	error = VError.cause(error);
	mod_assertplus.equal(error.name, 'FastServerError');
	error = VError.cause(error);
	mod_assertplus.equal(error.name, 'DummyError');
	mod_assertplus.deepEqual(error.context, 'abc123');
	mod_assertplus.deepEqual(error.ase_errors, [ 'foobar' ]);
	mod_assertplus.ok(!error.hasOwnProperty('someOtherProp'));
    }

}, {
    'name': 'unexpected end of stream: no response at all',
    'serverReply': function (socket, message, encoder) {
	socket.end();
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'unexpected end of transport stream');
	mod_testcommon.assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'unexpected end of stream: partial message response',
    'serverReply': function (socket, message, encoder) {
	var buf = new Buffer(1);
	buf.writeUInt8(mod_protocol.FP_VERSION_CURRENT,
	    mod_protocol.FP_OFF_VERSION);
	socket.end(buf);
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'fast protocol: incomplete message at end-of-stream');
	mod_testcommon.assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'unexpected end of stream: complete DATA message, no END',
    'serverReply': function (socket, message, encoder) {
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': mod_testcommon.dummyResponseData,
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.deepEqual(data[0], mod_testcommon.dummyValue);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'unexpected end of transport stream');
	mod_testcommon.assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'server responds with wrong msgid',
    'serverReply': function (socket, message, encoder) {
	mod_assertplus.ok(message.msgid != 47);
	encoder.end({
	    'msgid': 47,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': mod_testcommon.dummyResponseData,
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.equal(errors.client.message,
	    'fast protocol: received message with unknown msgid 47');
	mod_testcommon.assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'server responds with invalid message',
    'serverReply': function (socket, message, encoder) {
	/*
	 * This test case exercises client handling of all decoder errors.  The
	 * various decoder failure modes are tested separately in
	 * ./test/tst.protocol_decoder.js.
	 */
	var buf = new Buffer(mod_protocol.FP_HEADER_SZ + 1);
	mod_testcommon.writeMessageForEncodedData(
	    buf, 3, mod_protocol.FP_STATUS_END, '{', 0);
	socket.end(buf);
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.ok(/fast protocol: invalid JSON/.test(
	    errors.client.message));
	mod_testcommon.assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'server responds with invalid error',
    'serverReply': function (socket, message, encoder) {
	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': { 'd': {} },
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client !== null);
	mod_assertplus.ok(errors.request !== null);
	mod_assertplus.equal(data.length, 0);

	mod_assertplus.equal(errors.client.name, 'FastProtocolError');
	mod_assertplus.ok(/data.d for ERROR messages must have name/.test(
	    errors.client.message));
	mod_testcommon.assertRequestError(errors.request, errors.client);
    }

}, {
    'name': 'ok, with 10,000 data messages',
    'serverReply': function (socket, message, encoder) {
	var nmessages, i;

	assertNormalRequest(message);
	nmessages = 10000;
	for (i = 0; i < nmessages; i++) {
		encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': { 'd': [ 'string_' + i ] },
		    'version': mod_protocol.FP_VERSION_CURRENT
		});
	}

	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': { 'd': [ 'lastmessage' ] },
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	var i;
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.equal(data.length, 10001);

	for (i = 0; i < data.length - 1; i++) {
		mod_assertplus.equal(data[i], 'string_' + i);
	}

	mod_assertplus.equal(data[data.length - 1], 'lastmessage');
    }

}, {
    'name': 'ok, with 10,000 items in an END message',
    'serverReply': function (socket, message, encoder) {
	var nitems, d, i;

	assertNormalRequest(message);
	nitems = 10000;
	d = [];
	for (i = 0; i < nitems; i++) {
		d.push('string_' + i);
	}

	encoder.end({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': { 'd': d },
	    'version': mod_protocol.FP_VERSION_CURRENT
	});
    },
    'clientCheck': function (data, errors) {
	var i;
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.equal(data.length, 10000);

	for (i = 0; i < data.length; i++) {
		mod_assertplus.equal(data[i], 'string_' + i);
	}
    }

}, {
    'name': 'artedi metrics ok for simple request',
    'serverReply': function (socket, message, encoder) {
	var d = ['hello world'];

	assertNormalRequest(message);
	encoder.write({
	    'msgid': message.msgid,
	    'status': mod_protocol.FP_STATUS_END,
	    'data': { 'd': d },
	    'version': mod_protocol.FP_VERSION_CURRENT
	});

	encoder.end();
    },
    'artediPromCheck': function (metrics) {
	var metricsLines;
	mod_assertplus.string(metrics);
	mod_assertplus.ok(metrics.length > 0);

	metricsLines = metrics.trim().split(/\n/);
	mod_assertplus.ok(metricsLines.indexOf(
	    'fast_client_requests_completed{rpcMethod="testmethod",' +
		'service="tst.client_request"} 1') !== -1);
    },
    'clientCheck': function (data, errors) {
	mod_assertplus.ok(errors.socket === null);
	mod_assertplus.ok(errors.client === null);
	mod_assertplus.ok(errors.request === null);
	mod_assertplus.deepEqual(data, ['hello world']);
    }

} ];

/*
 * Asserts that the given Fast message represents a well-formed RPC request.
 */
function assertNormalRequest(message)
{
	mod_assertplus.equal(message.status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.object(message.data);
	mod_assertplus.object(message.data.m);
	mod_assertplus.string(message.data.m.name);
	mod_assertplus.ok(message.data.m.uts >= startUts);
	mod_assertplus.ok(message.data.m.uts <= mod_microtime.now());
	mod_assertplus.array(message.data.d);
}

/*
 * Asserts that the given found_error matches what we would expect if the server
 * responded with the given server_error.
 */
function assertServerError(found_error, server_error)
{
	/*
	 * Our current behavior is extremely pedantic, but at least it's clear
	 * what really happened in all cases.
	 */
	var cause, info;

	mod_assertplus.equal(found_error.name, 'FastRequestError');
	mod_assertplus.equal(found_error.message,
	    'request failed: server error: ' + server_error.message);

	cause = found_error.cause();
	mod_assertplus.equal(cause.name, 'FastServerError');
	mod_assertplus.equal(cause.message,
	    'server error: ' + server_error.message);

	cause = cause.cause();
	mod_assertplus.equal(cause.name, server_error.name);
	mod_assertplus.equal(cause.message, server_error.message);

	info = VError.info(found_error);
	mod_assertplus.number(info['rpcMsgid'], 1);
	mod_assertplus.equal(info['rpcMethod'],
	    mod_testcommon.dummyRpcMethodName);
	mod_assertplus.equal(info['dummyProp'], 'dummyVal');
}

main();
