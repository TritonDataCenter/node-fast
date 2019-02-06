/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * test/tst.client_generic.js: client API generic test suite
 *
 * This file contains a test runner (runTestCase) that executes fairly free-form
 * test cases against the client API.  Most client API test cases can be fit
 * into the much simpler model in tst.client_request.js, and we should generally
 * put test cases in there when possible.  The test cases that need to go here
 * include those where the end of the test is harder to identify.
 */

var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_jsprim = require('jsprim');
var mod_net = require('net');
var mod_path = require('path');
var mod_vasync = require('vasync');
var VError = require('verror');

var mod_client = require('../lib/fast_client');
var mod_protocol = require('../lib/fast_protocol');
var mod_testcommon = require('./common');
var mod_testclient = require('./common/client');

var serverSocket;
var testLog;

function main()
{
	testLog = new mod_bunyan({
	    'name': mod_path.basename(__filename),
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	mod_testcommon.registerExitBlocker('test run');
	mod_testcommon.mockServerSetup(function (s) {
		testLog.info('server listening');
		serverSocket = s;

		mod_vasync.forEachPipeline({
		    'inputs': test_cases,
		    'func': runTestCase
		}, function (err) {
			if (err) {
				throw (err);
			}

			mod_testcommon.mockServerTeardown(serverSocket);
			mod_testcommon.unregisterExitBlocker('test run');
			console.log('%s tests passed',
			    mod_path.basename(__filename));
		});
	});
}

function runTestCase(testcase, callback)
{
	var ctc;

	console.log('test case: %s', testcase.name);
	ctc = new mod_testclient.ClientTestContext({
	    'server': serverSocket,
	    'log': testLog.child({ 'testcase': testcase.name })
	});

	ctc.establishConnection();
	testcase.run(ctc, function () {
		mod_assertplus.ok(ctc.ctc_closed,
		    'test case did not call ClientTestContext.cleanup()');
		callback();
	});
}


/*
 * This function executes the body of test cases that do this:
 *
 *     o send a request
 *     o have the server respond to the request normally
 *     o have the server send an extra response message
 *     o expect the client to produce an error
 *
 * "firstIsError" indicates whether the first request should produce an error or
 * a normal response.  "secondStatus" is the STATUS value to use for the
 * server's extra message.
 */
function runDuplicateResponseTest(ctc, firstIsError, secondStatus, callback)
{
	var ctr;

	mod_vasync.waterfall([
	    function makeRequest(next) {
		ctc.handleNextRequest({
		    'data': !firstIsError,
		    'error': firstIsError
		});

		ctr = ctc.makeRequest(next);
	    },

	    function afterFirstRequest(next) {
		mod_assertplus.ok(ctc.ctc_error_client === null);

		if (firstIsError) {
			mod_assertplus.ok(ctr.ctr_error !== null);
			mod_assertplus.ok(ctr.ctr_data.length === 0);
		} else {
			mod_assertplus.ok(ctr.ctr_error === null);
			mod_assertplus.ok(ctr.ctr_data.length > 0);
		}

		ctc.ctc_log.debug('server sending extra response');
		ctc.ctc_server_encoder.end({
		    'msgid': ctc.ctc_server_message.msgid,
		    'status': secondStatus,
		    'data': secondStatus === mod_protocol.FP_STATUS_ERROR ?
			mod_testcommon.dummyResponseError :
			mod_testcommon.dummyResponseData,
		    'crc_mode': mod_protocol.CRC_MODE_NEW
		});

		/*
		 * This handler is used only to advance us to the next stage of
		 * the waterfall.  The ClientTestContext will record the error
		 * itself.
		 */
		ctc.ctc_fastclient.on('error', function () { next(); });
	    },

	    function checkClientError(next) {
		var error = ctc.ctc_error_client;

		mod_assertplus.ok(error !== null);
		mod_assertplus.equal(error.name, 'FastProtocolError');
		mod_assertplus.equal(VError.info(error).fastReason,
		    'unknown_msgid');
		mod_assertplus.equal(VError.info(error).fastMsgid,
		    ctc.ctc_server_message.msgid);
		mod_assertplus.equal(error.message,
		    'fast protocol: received message with unknown msgid ' +
		    ctc.ctc_server_message.msgid);
		next();
	    }
	], callback);
}

/*
 * This function executes tests that work by issuing several requests
 * concurrently, inducing some client-wide failure, and issues another request.
 * This verifies that we correctly fail outstanding requests in the face of
 * failure and also fail subsequent requests issued on the same client.
 */
function runClientFailureTest(ctc, doFail, callback)
{
	var npending, nextra;
	var earlyrqs, laterqs;

	npending = 100;
	nextra = 5;

	mod_vasync.waterfall([
	    function issueEarlyRequests(next) {
		ctc.ctc_log.debug({
		    'npending': npending
		}, 'issuing requests to be pending during failure');
		earlyrqs = issueRequests(ctc, npending, next);
		setTimeout(doFail, 50);

		/*
		 * Configure the server to send a DATA message for the first
		 * request so that we have one example where the request was
		 * partially completed.
		 */
		ctc.ctc_server_decoder.once('data', function (message) {
			ctc.ctc_server_encoder.write({
			    'msgid': message.msgid,
			    'status': mod_protocol.FP_STATUS_DATA,
			    'data': mod_testcommon.dummyResponseData,
			    'crc_mode': mod_protocol.CRC_MODE_NEW
			});
		});
	    },

	    function issueLateRequests(next) {
		ctc.ctc_log.debug({
		    'npending': nextra
		}, 'issuing requests after failure');
		laterqs = issueRequests(ctc, nextra, next);
	    }
	], function (err) {
		if (err) {
			/* None of the waterfall functions emits an error. */
			throw (err);
		}

		earlyrqs.forEach(function (erq, i) {
			var cause;
			if (i === 0) {
				mod_assertplus.equal(erq.ctr_data.length, 1);
				mod_assertplus.deepEqual(erq.ctr_data[0],
				    mod_testcommon.dummyValue);
			} else {
				mod_assertplus.equal(erq.ctr_data.length, 0);
			}

			mod_assertplus.ok(erq.ctr_error !== null);
			mod_assertplus.ok(erq.ctr_done);
			mod_assertplus.ok(erq.ctr_error.name,
			    'FastRequestError');
			cause = erq.ctr_error.cause();
			mod_assertplus.equal(erq.ctr_error.message,
			    'request failed: ' + cause.message);
			mod_assertplus.equal(erq.ctr_request.requestId(),
			    VError.info(erq.ctr_error).rpcMsgid);
			/* The caller will check the cause details later. */
		});

		laterqs.forEach(function (lrq) {
			var cause;

			mod_assertplus.equal(lrq.ctr_data.length, 0);
			mod_assertplus.ok(lrq.ctr_error !== null);
			mod_assertplus.ok(lrq.ctr_done);
			mod_assertplus.ok(lrq.ctr_error.name,
			    'FastRequestError');
			cause = lrq.ctr_error.cause();
			mod_assertplus.equal(lrq.ctr_error.message,
			    'request failed: ' + cause.message);
			mod_assertplus.equal(lrq.ctr_request.requestId(),
			    VError.info(lrq.ctr_error).rpcMsgid);
			mod_assertplus.equal(cause.name, 'FastTransportError');
			mod_assertplus.equal(cause.message,
			    'transport detached');
		});

		callback(earlyrqs);
	});
}

/*
 * Issue "nrequests" and invoke "callback" once all are completed.
 */
function issueRequests(ctc, nrequests, callback)
{
	var labels, rqs, i;
	var barrier;

	barrier = mod_vasync.barrier();
	barrier.start('init');

	labels = [];
	for (i = 0; i < nrequests; i++) {
		labels.push('req ' + i);
	}

	rqs = labels.map(function (label, j) {
		barrier.start(label);
		return (ctc.makeRequest(function () { barrier.done(label); }));
	});

	barrier.on('drain', function () { callback(); });
	setImmediate(function () { barrier.done('init'); });
	return (rqs);
}

var test_cases = [ {
    'name': 'server reports extra END   event (after END   event)',
    'run': function (ctc, callback) {
	runDuplicateResponseTest(ctc, false, mod_protocol.FP_STATUS_END,
	    function () {
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'server reports extra DATA  event (after END   event)',
    'run': function (ctc, callback) {
	runDuplicateResponseTest(ctc, false, mod_protocol.FP_STATUS_DATA,
	    function () {
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'server reports extra ERROR event (after END   event)',
    'run': function (ctc, callback) {
	runDuplicateResponseTest(ctc, false, mod_protocol.FP_STATUS_ERROR,
	    function () {
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'server reports extra END   event (after ERROR event)',
    'run': function (ctc, callback) {
	runDuplicateResponseTest(ctc, true, mod_protocol.FP_STATUS_END,
	    function () {
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'server reports extra DATA  event (after ERROR event)',
    'run': function (ctc, callback) {
	runDuplicateResponseTest(ctc, true, mod_protocol.FP_STATUS_DATA,
	    function () {
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'server reports extra ERROR event (after ERROR event)',
    'run': function (ctc, callback) {
	runDuplicateResponseTest(ctc, true, mod_protocol.FP_STATUS_ERROR,
	    function () {
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'server sends unsolicited message',
    'run': function (ctc, callback) {
	ctc.ctc_server_encoder.end({
	    'msgid': 0x7,
	    'status': mod_protocol.FP_STATUS_ERROR,
	    'data': mod_testcommon.dummyResponseError,
	    'crc_mode': mod_protocol.CRC_MODE_NEW
	});

	ctc.ctc_fastclient.on('error', function (err) {
		var error = ctc.ctc_error_client;
		mod_assertplus.ok(error !== null);
		mod_assertplus.ok(err == error);
		mod_assertplus.equal(error.name, 'FastProtocolError');
		mod_assertplus.equal(VError.info(error).fastReason,
		    'unknown_msgid');
		mod_assertplus.equal(VError.info(error).fastMsgid, 0x7);
		mod_assertplus.equal(error.message,
		    'fast protocol: received message with unknown msgid 7');
		ctc.cleanup();
		callback();
	});
    }

}, {
    'name': 'server sends message with null value, not allowed',
    'run': function (ctc, callback) {
	var ctr;

	ctc.ctc_server_decoder.once('data', function (message) {
		ctc.ctc_server_encoder.end({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_END,
		    'data': { 'd': [ true, null, 7 ] },
		    'crc_mode': mod_protocol.CRC_MODE_NEW
		});
	});

	ctr = ctc.makeRequest(function () {
		mod_assertplus.ok(ctr.ctr_error !== null);
		mod_assertplus.deepEqual(ctr.ctr_data, [ true ]);
		mod_assertplus.equal(ctr.ctr_error.cause().name,
		    'FastProtocolError');
		mod_assertplus.equal(ctr.ctr_error.cause().message,
		    'server sent "null" value');
		ctc.cleanup();
		callback();
	});
    }

}, {
    'name': 'server sends message with null value, ignored',
    'run': function (ctc, callback) {
	var ctr;

	ctc.ctc_server_decoder.once('data', function (message) {
		ctc.ctc_server_encoder.end({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_END,
		    'data': { 'd': [ true, null, 7 ] }
		});
	});

	ctr = ctc.makeRequestWithOptions({
	    'ignoreNullValues': true
	}, function () {
		mod_assertplus.ok(ctr.ctr_error === null);
		mod_assertplus.deepEqual(ctr.ctr_data, [ true, 7 ]);
		ctc.cleanup();
		callback();
	});
    }

 }, {
    'name': 'pending and new requests: transport detach',
    'run': function (ctc, callback) {
	runClientFailureTest(ctc,
	    function () {
		ctc.ctc_log.debug('injecting failure: detach');
		ctc.ctc_fastclient.detach();
	    },
	    function (requests) {
		requests.forEach(function (rq) {
			/*
			 * runClientFailureTest has already checked the
			 * top-level error.  We need to check its cause.
			 */
			var cause = rq.ctr_error.cause();
			mod_assertplus.equal(cause.name, 'FastTransportError');
			mod_assertplus.equal(cause.message,
			    'client detached from transport');
		});

		mod_assertplus.equal(requests.length, 100);
		ctc.cleanup();
		callback();
	    });
    }

 }, {
    'name': 'pending and new requests: protocol error',
    'run': function (ctc, callback) {
	runClientFailureTest(ctc,
	    function () {
		ctc.ctc_log.debug('injecting failure: bad message');
		/*
		 * This message is invalid because the response data is empty.
		 */
		ctc.ctc_server_encoder.write({
		    'msgid': 1,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': { 'd': null }
		});
	    },
	    function (requests) {
		requests.forEach(function (rq) {
			/*
			 * runClientFailureTest has already checked the
			 * top-level error.  We need to check its cause.
			 */
			var cause = rq.ctr_error.cause();
			mod_assertplus.equal(cause.name, 'FastProtocolError');
			mod_assertplus.ok(/data.d for .* must be an array/.test(
			    cause.message));
		});

		mod_assertplus.equal(requests.length, 100);
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'pending and new requests: unexpected end-of-stream',
    'run': function (ctc, callback) {
	runClientFailureTest(ctc,
	    function () {
		ctc.ctc_log.debug('injecting failure: end-of-stream');
		ctc.ctc_server_encoder.end();
	    },
	    function (requests) {
		requests.forEach(function (rq) {
			/*
			 * runClientFailureTest has already checked the
			 * top-level error.  We need to check its cause.
			 */
			var cause = rq.ctr_error.cause();
			mod_assertplus.equal(cause.name, 'FastProtocolError');
			mod_assertplus.equal(cause.message,
			    'unexpected end of transport stream');
		});

		mod_assertplus.equal(requests.length, 100);
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'pending and new requests: socket error',
    'run': function (ctc, callback) {
	runClientFailureTest(ctc,
	    function () {
		ctc.ctc_log.debug('injecting failure: socket error');
		ctc.ctc_server_sock.destroy();
		ctc.ctc_client_sock.write('boom!');
	    },
	    function (requests) {
		requests.forEach(function (rq) {
			/*
			 * runClientFailureTest has already checked the
			 * top-level error.  We need to check its cause.
			 */
			var cause = rq.ctr_error.cause();
			mod_assertplus.equal(cause.name, 'FastTransportError');
			mod_assertplus.ok(
			    /^unexpected error on transport:/.test(
			    cause.message));

			cause = cause.cause();
			mod_assertplus.ok(/ECONNRESET/.test(cause.message));
		});

		mod_assertplus.equal(requests.length, 100);
		ctc.cleanup();
		callback();
	    });
    }

}, {
    'name': 'pending requests: serviced out of order',
    'run': function (ctc, callback) {
	var client_requests, server_requests;
	var nrequests = 100;

	/*
	 * To test requests serviced out of order, we'll issue a bunch of
	 * requests, then add a server handler that accumulates all of the
	 * requests, shuffle the requests, and service them in shuffled order.
	 * To make sure we actually got the correct data back for each request,
	 * we'll tie the response data to the message id.
	 */
	client_requests = issueRequests(ctc, nrequests, function () {
		client_requests.forEach(function (crq, i) {
			mod_assertplus.ok(crq.ctr_error === null);
			mod_assertplus.equal(crq.ctr_data.length, 1);
			mod_assertplus.equal(crq.ctr_data[0],
			    crq.ctr_request.requestId());
		});

		mod_assertplus.equal(client_requests.length, nrequests);
		ctc.cleanup();
		callback();
	});

	server_requests = [];
	ctc.ctc_server_decoder.on('data', function (message) {
		var i, j, tmp;

		ctc.ctc_log.debug(message, 'server: buffering request');
		server_requests.push(message);

		if (server_requests.length < nrequests) {
			return;
		}

		ctc.ctc_log.debug('server: shuffling and processing requests');

		/*
		 * Shuffle the array using a Fisher-Yates shuffle.
		 */
		mod_assertplus.equal(server_requests.length, nrequests);
		for (i = server_requests.length - 1; i > 0; i--) {
			j = Math.floor(server_requests.length * Math.random());
			tmp = server_requests[i];
			server_requests[i] = server_requests[j];
			server_requests[j] = tmp;
		}

		server_requests.forEach(function (srq) {
			ctc.ctc_server_encoder.write({
			    'msgid': srq.msgid,
			    'status': mod_protocol.FP_STATUS_END,
			    'data': { 'd': [ srq.msgid ] }
			});
		});
	});
    }

}, {
    'name': 'request abandon, same tick',
    'run': function (ctc, callback) {
	var ctr;

	ctc.handleNextRequest({ 'error': false, 'data': false });
	ctr = ctc.makeRequest(function () {
		mod_assertplus.ok(ctr.ctr_error !== null);
		mod_assertplus.equal(ctr.ctr_data.length, 0);
		ctc.cleanup();
		callback();
	});
	ctr.ctr_request.abandon();
	/* Make sure it's okay to do it again. */
	ctr.ctr_request.abandon();
    }

}, {
    'name': 'request abandon after complete',
    'run': function (ctc, callback) {
	var ctr;

	ctc.handleNextRequest({ 'error': false, 'data': true });
	ctr = ctc.makeRequest(function () {
		ctr.ctr_request.abandon();
		mod_assertplus.ok(ctr.ctr_error === null);
		mod_assertplus.equal(ctr.ctr_data.length, 2);
		ctc.cleanup();
		callback();
	});
    }

}, {
    'name': 'request abandoned after some data',
    'run': function (ctc, callback) {
	var ctr;

	ctc.ctc_server_decoder.once('data', function (message) {
		ctc.ctc_server_encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': mod_testcommon.dummyResponseData
		});
	});

	ctr = ctc.makeRequest(function () {
		mod_assertplus.ok(ctr.ctr_error !== null);
		mod_assertplus.equal(ctr.ctr_data.length, 1);
		mod_assertplus.equal(ctr.ctr_error.cause().name,
		    'FastRequestAbandonedError');
		ctc.cleanup();
		callback();
	});

	ctr.ctr_request.once('data', function () {
		ctr.ctr_request.abandon();
	});
    }
}, {
    'name': 'request with timeout',
    'run': function (ctc, callback) {
	var start, req;

	start = process.hrtime();
	req = ctc.ctc_fastclient.rpc({
	    'rpcmethod': mod_testcommon.dummyRpcMethodName,
	    'rpcargs': mod_testcommon.dummyRpcArgs,
	    'timeout': 400
	});

	req.on('end', function () {
		throw (new Error('unexpected request completion'));
	});

	req.on('data', function () {
		throw (new Error('unexpected request data'));
	});

	req.on('error', function (err) {
		var cause, delta;

		cause = VError.cause(err);
		mod_assertplus.equal(err.name, 'FastRequestError');
		mod_assertplus.equal(err.message, 'request failed: ' +
		    cause.message);

		mod_assertplus.equal(cause.name, 'TimeoutError');
		mod_assertplus.equal(VError.info(cause).timeout, 400);
		delta = mod_jsprim.hrtimeMillisec(process.hrtime(start));
		mod_assertplus.ok(delta >= 400, 'timeout was too short');
		mod_assertplus.ok(delta < 4000, 'timeout was too long');
		ctc.cleanup();
		callback();
	});
    }

}, {
    'name': 'flow control from server to client',
    'run': function (ctc, callback) {
	var req, source;

	/*
	 * This test case has an analog in the server test suite.  Changes here
	 * may need to be reflected there.  As with the server analog, this test
	 * case relies on pause() working even in new mode, which isn't
	 * supported on Node 0.10.
	 */
	if (mod_testcommon.predatesUsefulPause()) {
		ctc.ctc_log.warn('skipping test (not supported on v0.10)');
		ctc.cleanup();
		setImmediate(callback);
		return;
	}

	mod_vasync.waterfall([
	    function makeRequest(next) {
		/*
		 * We cannot use ctc.makeRequest() because that will immediately
		 * start reading 'data' events.  We want to avoid doing that to
		 * make sure that we get flow-controlled.  In order to do that,
		 * we need to make the request ourselves and pause the request
		 * stream.
		 *
		 * We deliberately add no "error" handler yet since we do not
		 * expect an error and the test should crash if we see one.
		 */
		ctc.ctc_log.debug('issuing flow-controlled RPC');
		req = ctc.ctc_fastclient.rpc({
		    'rpcmethod': mod_testcommon.dummyRpcMethodName,
		    'rpcargs': mod_testcommon.dummyRpcArgs
		});

		ctc.ctc_client_sock.pause();

		/*
		 * Set up a server handler that writes data until it's blocked.
		 */
		ctc.ctc_server_decoder.once('data', function (message) {
			var outmessage = {
			    'msgid': message.msgid,
			    'status': mod_protocol.FP_STATUS_DATA,
			    'data': mod_testcommon.dummyResponseData
			};

			source = new mod_testcommon.FlowControlSource({
			    'datum': outmessage,
			    'restMs': 1000,
			    'log': ctc.ctc_log.child({
				'component': 'FlowControlSource'
			    })
			});

			source.pipe(ctc.ctc_server_encoder);
			source.once('resting', function () { next(); });
		});
	    },

	    function checkFlowControlled(next) {
		/*
		 * These checks are brittle because they depend on internal Node
		 * implementation details.  However, if those details change,
		 * the failure here is likely to be explicit, and we can decide
		 * how best to fix them.  We could skip these checks entirely,
		 * but we'd like to be sure that the flow-control mechanism was
		 * definitely engaged and that it was engaged because the client
		 * is backed up.  If this check fails, and the Node internals on
		 * which it relies have not changed, that means that we
		 * inadvertently decided the server was flow-controlled above
		 * even though the client's buffer is not full.
		 */
		ctc.ctc_log.debug('came to rest; verifying and moving on');
		mod_assertplus.ok(mod_testcommon.isFlowControlled(
		    ctc.ctc_client_sock));

		/*
		 * Stop the source and release the flow control.  Add an "error"
		 * handler to the request, because the FlowControlSource above
		 * will not actually generate a proper END message, so we expect
		 * an error to be generated when the end-of-stream is reached.
		 */
		req.on('error', function (err) {
			var cause = err.cause();
			mod_assertplus.equal(cause.name, 'FastProtocolError');
			mod_assertplus.equal(cause.message,
			    'unexpected end of transport stream');
			next();
		});
		req.on('end', function () {
			/* See above. */
			throw (new VError('unexpected request completion'));
		});

		source.stop();
		ctc.ctc_client_sock.resume();
	    }
	], function (err) {
		ctc.cleanup();
		callback();
	});
    }

}, {
    'name': '10,000 requests, with max concurrency 100',
    'run': function (ctc, callback) {
	var queue, nrequests, i, first;
	var nhaddata = 0;
	var nhaderrors = 0;
	var nhadboth = 0;
	var nmaxoutstanding = 0;
	var noutstanding = 0;
	var expected = [];

	nrequests = 10000;
	queue = mod_vasync.queuev({
	    'concurrency': 100,
	    'worker': function makeRequest(which, qcallback) {
		var dodata = expected[which].data;
		var doerror = expected[which].error;
		var ndata = 0;
		var ctr;

		if (dodata) {
			ndata++;
			nhaddata++;
		}
		if (!doerror) {
			ndata++;
		}

		ctr = ctc.makeRequest(function () {
			noutstanding--;

			ctc.ctc_log.debug('verifying request', which,
			    expected[which]);

			mod_assertplus.equal(ctr.ctr_data.length, ndata);

			if (doerror) {
				mod_assertplus.ok(ctr.ctr_error !== null);
				nhaderrors++;
				if (dodata) {
					nhadboth++;
				}
			} else {
				mod_assertplus.ok(ctr.ctr_error === null);
			}

			qcallback();
		});

		if (++noutstanding > nmaxoutstanding) {
			nmaxoutstanding = noutstanding;
		}
	    }
	});

	expected = [];
	for (i = 0; i < nrequests; i++) {
		queue.push(i);
		expected[i] = {
		    'data': i % 3 === 0,
		    'error': i % 4 === 0
		};
	}

	queue.on('end', function () {
		mod_assertplus.equal(nhaderrors, 2500);
		mod_assertplus.equal(nhaddata, 3334);
		mod_assertplus.equal(nhadboth, 834);
		mod_assertplus.equal(nmaxoutstanding, 100);
		ctc.cleanup();
		callback();
	});

	queue.close();

	/*
	 * Set up the server handler.
	 */
	first = null;
	ctc.ctc_server_decoder.on('data', function (message) {
		var which;

		if (first === null) {
			first = message.msgid;
		}

		which = message.msgid - first;
		ctc.ctc_log.debug({
		    'which': which,
		    'message': message,
		    'expected': expected[which]
		}, 'server responding');
		ctc.serverReply(message, expected[which]);
	});
    }
} ];

main();
