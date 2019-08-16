/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * test/tst.server.js: server API test suite
 */

var mod_assertplus = require('assert-plus');
var mod_artedi = require('artedi');
var mod_bunyan = require('bunyan');
var mod_jsprim = require('jsprim');
var mod_net = require('net');
var mod_path = require('path');
var mod_vasync = require('vasync');

var mod_fast = require('../lib/fast');
var mod_fastdemo = require('../lib/demo_server');
var mod_protocol = require('../lib/fast_protocol');
var mod_testcommon = require('./common');

var VError = require('verror');

var testLog;
var serverTestCases;

var SERVER_CRC_MODE = mod_fast.FAST_CHECKSUM_V1;
var CLIENT_CRC_MODE = mod_fast.FAST_CHECKSUM_V1;

function main()
{
	testLog = new mod_bunyan({
	    'name': mod_path.basename(__filename),
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	mod_testcommon.registerExitBlocker('test run');

	mod_vasync.forEachPipeline({
	    'inputs': serverTestCases,
	    'func': runTestCase
	}, function (err) {
		if (err) {
			throw (err);
		}

		mod_testcommon.unregisterExitBlocker('test run');
	});

	SERVER_CRC_MODE = mod_fast.FAST_CHECKSUM_V1_V2;

	mod_vasync.forEachPipeline({
	    'inputs': serverTestCases,
	    'func': runTestCase
	}, function (err) {
		if (err) {
			throw (err);
		}

		mod_testcommon.unregisterExitBlocker('test run');
	});

	CLIENT_CRC_MODE = mod_fast.FAST_CHECKSUM_V2;

	mod_vasync.forEachPipeline({
	    'inputs': serverTestCases,
	    'func': runTestCase
	}, function (err) {
		if (err) {
			throw (err);
		}

		mod_testcommon.unregisterExitBlocker('test run');
	});
}

function ServerTestContext()
{
	this.ts_log = null;	/* bunyan logger */
	this.ts_closed = false;	/* whether we've already done cleanup */
	this.ts_socket = null;	/* server net socket */
	this.ts_server = null;	/* fast server object */
	this.ts_clients = [];	/* array of clients, each having properties */
				/* "tsc_socket" and "tsc_client" */
	this.ts_collector = null;	/* artedi metric collector */
}

ServerTestContext.prototype.connectClient = function (callback)
{
	var ip, port;
	var csock, cclient;
	var self = this;

	ip = mod_testcommon.serverIp;
	port = mod_testcommon.serverPort;
	csock = mod_net.createConnection(port, ip);
	cclient = new mod_fast.FastClient({
	    'log': this.ts_log.child({ 'component': 'FastClient' }),
	    'transport': csock,
	    'nRecentRequests': 100,
	    'crc_mode': CLIENT_CRC_MODE
	});

	csock.on('connect', function () {
		self.ts_log.info('connected client', self.ts_clients.length);

		self.ts_clients.push({
		    'tsc_socket': csock,
		    'tsc_client': cclient
		});

		callback();
	});
};

ServerTestContext.prototype.firstFastClient = function ()
{
	mod_assertplus.ok(this.ts_clients.length > 0);
	return (this.ts_clients[0].tsc_client);
};

ServerTestContext.prototype.cleanup = function ()
{
	if (this.ts_closed) {
		return;
	}

	this.ts_closed = true;

	this.ts_clients.forEach(function (c) {
		c.tsc_client.detach();
		c.tsc_socket.destroy();
	});

	this.ts_socket.close();
	this.ts_server.close();
};

function expectRpcResult(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.optionalObject(args.errorActual, 'args.errorActual');
	mod_assertplus.optionalBool(args.errorExpected, 'args.errorExpected');
	mod_assertplus.arrayOfObject(args.dataActual, 'args.dataActual');
	mod_assertplus.optionalArrayOfObject(
	    args.dataExpected, 'args.dataExpected');

	if (args.errorActual === null && args.errorExpected) {
		return (new VError('expected error, but found none'));
	}

	if (args.errorActual !== null && !args.errorExpected) {
		return (new VError(args.errorActual, 'unexpected error'));
	}

	if (args.dataExpected === null) {
		return (null);
	}

	/* Pretty cheesy. */
	try {
		mod_assertplus.deepEqual(
		    args.dataExpected, args.dataActual);
	} catch (ex) {
		mod_assertplus.equal(ex.name, 'AssertionError');
		return (ex);
	}

	return (null);
}

function unwrapClientRpcError(err)
{
	mod_assertplus.equal(err.name, 'FastRequestError');
	err = VError.cause(err);
	mod_assertplus.equal(err.name, 'FastServerError');
	err = VError.cause(err);
	mod_assertplus.ok(err !== null);
	return (err);
}

function runTestCase(testcase, callback)
{
	var tctx;

	console.error('test case: %s', testcase['name']);

	tctx = new ServerTestContext();
	tctx.ts_log = testLog.child({ 'testcase': testcase['name'] });
	tctx.ts_collector = mod_artedi.createCollector({
	    'labels': { 'component': 'FastServer' }
	});
	tctx.ts_socket = mod_net.createServer({ 'allowHalfOpen': true });
	tctx.ts_server = new mod_fast.FastServer({
	    'collector': tctx.ts_collector,
	    'log': tctx.ts_log.child({ 'component': 'FastServer' }),
	    'server': tctx.ts_socket,
	    'crc_mode': SERVER_CRC_MODE
	});

	mod_fastdemo.demoRpcs().forEach(function (rpc) {
		tctx.ts_server.registerRpcMethod(rpc);
	});

	mod_vasync.pipeline({ 'funcs': [
	    function initServer(_, next) {
		var port = mod_testcommon.serverPort;
		tctx.ts_socket.listen(port, function () {
			tctx.ts_log.debug({ 'port': port }, 'server listening');
			next();
		});
	    },

	    function initClient(_, next) {
		tctx.connectClient(next);
	    },

	    function runTest(_, next) {
		testcase['run'](tctx, next);
	    }
	] }, function (err) {
		tctx.cleanup();
		callback(err);
	});
}

function runConnFailureTest(tctx, injectFail, checkError, callback)
{
	var client1, client2, rqbarrier, rsbarrier;
	var rpcs, client2cb;
	var log = tctx.ts_log;

	/*
	 * The flow of control in this test case is pretty complicated.  We're
	 * trying to test what happens when there are multiple clients, client1
	 * and client2, that are connected with outstanding RPC requests and one
	 * of the connections, client1, experiences an error.  The expected
	 * behavior is that all of client1's requests fail immediately while
	 * client2's request is unaffected.  We test this by doing the
	 * following:
	 *
	 *     1) Set up a second client connection to the server.  (All tests
	 *        come in with one client already set up.)
	 *
	 *     2) Issue three requests from client1 and one request from
	 *        client2 and wait for all four requests to be received by the
	 *        server.  To wait for this, we use a vasync barrier called
	 *        "rqbarrier".
	 *
	 *     3) Inject an error into client1's connection.  This should
	 *        trigger the server to fail all of the requests outstanding on
	 *        that connection.  Wait for all three client1 requests to
	 *        complete on the client.  This uses another vasync barrier
	 *        called "rsbarrier".
	 *
	 *     4) On the server, complete the client2 request normally and wait
	 *        for it to complete on the client with the expected result.
	 *
	 * The keys for each barrier include the connid and request id.  In
	 * order to respond to RPC requests, we need to keep track of each
	 * request in "rpcs".
	 */
	client1 = tctx.firstFastClient();
	rpcs = {};
	rqbarrier = mod_vasync.barrier();
	rqbarrier.start('rpc 1/1');		/* wait for client1 requests */
	rqbarrier.start('rpc 1/2');
	rqbarrier.start('rpc 1/3');
	rqbarrier.start('rpc 2/1');		/* wait for client2 requests */
	rsbarrier = mod_vasync.barrier();
	rsbarrier.start('response 1/0');	/* wait for client1 responses */
	rsbarrier.start('response 1/1');
	rsbarrier.start('response 1/2');

	mod_vasync.pipeline({ 'funcs': [
	    function initSecondClient(_, next) {
		/*
		 * Make a second client connection so that we can verify that
		 * its requests are unaffected by connection-level failures.
		 */
		tctx.connectClient(next);
	    },

	    function makeRequests(_, next) {
		client2 = tctx.ts_clients[1].tsc_client;

		/*
		 * Register an RPC handler that will cause this pipeline to
		 * advance once all four RPC requests have been received by the
		 * server.
		 */
		tctx.ts_server.registerRpcMethod({
		    'rpcmethod': 'block',
		    'rpchandler': function fastRpcBlock(rpc) {
			var connid = rpc.connectionId();
			var reqid = rpc.requestId();
			rpcs[connid + '/' + reqid] = rpc;
			rqbarrier.done('rpc ' + connid + '/' + reqid);
		    }
		});

		rqbarrier.on('drain', next);

		/*
		 * Kick off the requests from the clients.
		 */
		[ 0, 1, 2 ].forEach(function (i) {
			client1.rpcBufferAndCallback({
			    'maxObjectsToBuffer': 0,
			    'rpcmethod': 'block',
			    'rpcargs': []
			}, function (err, data, ndata) {
				/*
				 * Note that this callback will not be invoked
				 * until several stages later in the pipeline.
				 */
				mod_assertplus.equal(err.name,
				    'FastRequestError');
				checkError(err.cause());
				rsbarrier.done('response 1/' + i);
			});
		});

		client2.rpcBufferAndCallback({
		    'maxObjectsToBuffer': 1,
		    'rpcmethod': 'block',
		    'rpcargs': []
		}, function (err, data, ndata) {
			/*
			 * Like above, this won't be invoked until a few stages
			 * later in this pipeline, by which point a later stage
			 * will have set client2cb.
			 */
			mod_assertplus.ok(!err);
			mod_assertplus.equal(data.length, ndata);
			mod_assertplus.deepEqual(data, [ { 'value': 52 } ]);
			client2cb();
		});
	    },

	    function injectError(_, next) {
		var clientErrorExpected;

		rsbarrier.start('client error');
		client1.on('error', function (err) {
			mod_assertplus.equal(err.name, 'FastProtocolError');
			rsbarrier.done('client error');
		});

		/*
		 * Wait for the server to fail outstanding requests on this
		 * client.
		 */
		rsbarrier.on('drain', next);

		log.info('injecting failure and waiting for completion');
		clientErrorExpected = injectFail();
		mod_assertplus.bool(clientErrorExpected,
		    'injectFail must return boolean');
		if (!clientErrorExpected) {
			rsbarrier.done('client error');
		}
	    },

	    function respondToClient2(_, next) {
		/*
		 * Set up a handler to be invoked when the client2 request
		 * completes on the client.
		 */
		client2cb = next;

		/*
		 * End all of the client requests.  The client1 request data
		 * will be black-holed, while the client2 request will work
		 * normally.
		 */
		log.info('responding to client2 and waiting for client');
		rpcs['1/1'].end({ 'value': 11 });
		rpcs['1/2'].end({ 'value': 12 });
		rpcs['1/3'].end({ 'value': 13 });
		rpcs['2/1'].end({ 'value': 52 });
	    }
	] }, callback);
}

/*
 * Run a test that performs some client work and then checks for the receipt of
 * an onConnsDestroyed callback after terminating the client connections.
 *
 * This test check verifies:
 *	- The callback has been received within a reasonable timeout window
 *	- The callback is received with the proper context: no active server
 *	  connections.
 *
 * It does not verify that the callback is only received once. This is done in
 * separate tests.
 */
function runOnConnsDestroyedCallbackTest(tctx, doClientWork, callback) {
	mod_assertplus.ok(tctx, 'tctx');
	mod_assertplus.func(doClientWork, 'doClientWork');
	mod_assertplus.func(callback, 'callback');

	var server = tctx.ts_server;
	var server_socket = tctx.ts_socket;
	var client;
	var timedout = false;

	/*
	 * Timeout on the entire test. Any success path with invoke
	 * clearTimeout on the handle returned by this call to
	 * setTimeout.
	 */
	var WAIT_MS = 3000;
	var timeout = setTimeout(function () {
		timedout = true;
		callback(new VError('did not receive' +
		    '\'onConnsDestroyed\' callback'));
	}, WAIT_MS);

	server_socket.once('connection', function () {
		server.onConnsDestroyed(function () {
			if (timedout) {
				return;
			}
			clearTimeout(timeout);

			mod_assertplus.ok(server.fs_conns, 'server.fs_conns');
			if (!mod_jsprim.isEmpty(server.fs_conns)) {
				callback(new VError('received ' +
				    '\'onConnsDestroyed\' callback when ' +
				    'server still had active connections.'));
				return;
			}
			callback();
		});
	});

	tctx.connectClient(function () {
		client = tctx.ts_clients[1].tsc_client;
		doClientWork(client, function (err) {
			tctx.ts_clients.forEach(function (c) {
				c.tsc_client.detach();
				c.tsc_socket.destroy();
			});
			if (!timedout && err) {
				clearTimeout(timeout);
				callback(err);
			}
		});
	});
}


serverTestCases = [ {
    'name': 'basic RPC: no data',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 0,
	    'rpcmethod': 'echo',
	    'rpcargs': []
	}, function (err, data, ndata) {
		mod_assertplus.equal(data.length, ndata);
		err = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': null,
		    'dataActual': data,
		    'dataExpected': []
		});

		callback(err);
	});
    }

}, {
    'name': 'basic RPC: 1 data item',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 1,
	    'rpcmethod': 'echo',
	    'rpcargs': [ 'lafayette' ]
	}, function (err, data, ndata) {
		mod_assertplus.equal(data.length, ndata);
		err = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': null,
		    'dataActual': data,
		    'dataExpected': [ { 'value': 'lafayette' } ]
		});

		callback(err);
	});
    }

}, {
    'name': 'basic RPC: several data items',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 4,
	    'rpcmethod': 'echo',
	    'rpcargs': [
	        { 'matches': [ 'tactical', 'brilliance' ] },
		null,
		false,
		17.81
	    ]
	}, function (err, data, ndata) {
		mod_assertplus.equal(data.length, ndata);
		err = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': null,
		    'dataActual': data,
		    'dataExpected': [
	                { 'value':
			    { 'matches': [ 'tactical', 'brilliance' ] } },
		        { 'value': null  },
		        { 'value': false },
		        { 'value': 17.81 }
		    ]
		});

		callback(err);
	});
    }

}, {
    'name': 'basic RPC: 0 data items, plus error',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 0,
	    'rpcmethod': 'fail',
	    'rpcargs': [ {
		'name': 'MyStupidError',
		'message': 'the server ate my response',
		'info': {
		    'expectedResponse': 'not eaten',
		    'actualResponse': 'eaten'
		},
		'context': {
		    'legacyContextProperty': 'oops'
		}
	    } ]
	}, function (err, data, ndata) {
		var rpcerr, info;

		mod_assertplus.equal(data.length, ndata);
		rpcerr = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': true,
		    'dataActual': data,
		    'dataExpected': []
		});

		if (rpcerr) {
			callback(rpcerr);
			return;
		}

		err = unwrapClientRpcError(err);
		mod_assertplus.equal(err.name, 'MyStupidError');
		mod_assertplus.equal(err.message, 'the server ate my response');
		mod_assertplus.equal(err.context.legacyContextProperty, 'oops');

		info = VError.info(err);
		mod_assertplus.equal(info.expectedResponse, 'not eaten');
		mod_assertplus.equal(info.actualResponse, 'eaten');
		callback();
	});
    }

}, {
    'name': 'basic RPC: several data items, plus error',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 3,
	    'rpcmethod': 'fail',
	    'rpcargs': [ {
		'data': [ 'one', 'two', 'three' ],
		'name': 'MyStupidError',
		'message': 'the server ate my response',
		'info': {
		    'expectedResponse': 'not eaten',
		    'actualResponse': 'eaten'
		},
		'context': {
		    'legacyContextProperty': 'oops'
		}
	    } ]
	}, function (err, data, ndata) {
		var rpcerr, info;

		mod_assertplus.equal(data.length, ndata);
		rpcerr = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': true,
		    'dataActual': data,
		    'dataExpected': null
		});

		if (rpcerr) {
			callback(rpcerr);
			return;
		}

		/*
		 * Any number of data items between 0 and 3 is possible here,
		 * depending on what the server sent out before the request
		 * failed.
		 */
		mod_assertplus.ok(data.length >= 0 && data.length <= 3);
		mod_assertplus.deepEqual(data, [
		    { 'value': 'one' },
		    { 'value': 'two' },
		    { 'value': 'three' }
		].slice(0, data.length));

		err = unwrapClientRpcError(err);
		mod_assertplus.equal(err.name, 'MyStupidError');
		mod_assertplus.equal(err.message, 'the server ate my response');
		mod_assertplus.equal(err.context.legacyContextProperty, 'oops');

		info = VError.info(err);
		mod_assertplus.equal(info.expectedResponse, 'not eaten');
		mod_assertplus.equal(info.actualResponse, 'eaten');
		callback();
	});
    }

}, {
    'name': 'RPC for non-existent method',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 0,
	    'rpcmethod': 'badmethod',
	    'rpcargs': []
	}, function (err, data, ndata) {
		var rpcerr, info;

		mod_assertplus.equal(data.length, ndata);
		rpcerr = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': true,
		    'dataActual': data,
		    'dataExpected': null
		});

		if (rpcerr) {
			callback(rpcerr);
			return;
		}

		err = unwrapClientRpcError(err);
		mod_assertplus.equal(err.name, 'FastError');
		mod_assertplus.equal(err.message,
		    'unsupported RPC method: "badmethod"');

		info = VError.info(err);
		mod_assertplus.equal(info.fastReason, 'bad_method');
		mod_assertplus.equal(info.rpcMethod, 'badmethod');
		callback();
	});
    }

}, {
    'name': 'multiple RPCs for the same client run in parallel',
    'run': function (tctx, callback) {
	var which = 0;
	var barrier;

	/*
	 * Set up a server where we wait for three RPC calls to show up and then
	 * start completing each of them in order.
	 */
	barrier = mod_vasync.barrier();
	barrier.start('rpc 0');
	barrier.start('rpc 1');
	barrier.start('rpc 2');

	tctx.ts_server.registerRpcMethod({
	    'rpcmethod': 'recordAndReturn',
	    'rpchandler': function fastRpcRecordAndReturn(rpc) {
		var whichrpc = which++;
		barrier.on('drain', function () {
			rpc.end({ 'value': whichrpc });
		});
		barrier.done('rpc ' + whichrpc);
	    }
	});

	mod_vasync.forEachParallel({
	    'inputs': [
	        { 'rpcmethod': 'recordAndReturn', 'rpcargs': [] },
	        { 'rpcmethod': 'recordAndReturn', 'rpcargs': [] },
	        { 'rpcmethod': 'recordAndReturn', 'rpcargs': [] }
	    ],
	    'func': function makeRpc(rpcargs, next) {
		rpcargs.maxObjectsToBuffer = 2;
		tctx.firstFastClient().rpcBufferAndCallback(rpcargs, next);
	    }
	}, function (err, results) {
		if (err) {
			throw (err);
		}

		mod_assertplus.deepEqual(results.operations[0].result,
		    [ { 'value': 0 } ]);
		mod_assertplus.deepEqual(results.operations[1].result,
		    [ { 'value': 1 } ]);
		mod_assertplus.deepEqual(results.operations[2].result,
		    [ { 'value': 2 } ]);

		callback();
	});
    }

}, {
    'name': 'connection error with requests outstanding: protocol error',
    'run': function (tctx, callback) {
	var client1 = tctx.firstFastClient();

	runConnFailureTest(tctx, function () {
		/*
		 * Inject a protocol error via the first client.
		 */
		mod_assertplus.ok(client1 instanceof mod_fast.FastClient);
		mod_assertplus.object(client1.fc_msgencoder,
		    'test error (needs to be updated for FastClient ' +
		    'implementation change?');
		client1.fc_msgencoder.write({
		    'msgid': 7,
		    'status': mod_protocol.FP_STATUS_END,
		    'data': { 'd': [] }
		});
		return (true);
	}, function (err) {
		mod_assertplus.equal(err.name, 'FastProtocolError');
	}, callback);
    }

}, {
    'name': 'connection error with requests outstanding: socket error',
    'run': function (tctx, callback) {
	runConnFailureTest(tctx, function () {
		/*
		 * Inject a socket error via the first client.
		 */
		mod_assertplus.object(tctx.ts_server.fs_conns,
		    'test error (needs to be updated for FastServer ' +
		    'implementation change?');
		mod_assertplus.ok(tctx.ts_server.fs_conns.hasOwnProperty(1));
		mod_assertplus.object(tctx.ts_server.fs_conns[1].fc_socket);
		tctx.ts_clients[0].tsc_socket.destroy();

		/*
		 * Note that since we're destroying the local socket, it won't
		 * emit an error, so we have to detach the transport in order to
		 * get the local client requests to complete.
		 */
		tctx.ts_clients[0].tsc_client.detach();
		tctx.ts_server.fs_conns[1].fc_socket.write('boom');
		return (false);
	}, function (err) {
		mod_assertplus.equal(err.name, 'FastTransportError');
	}, callback);
    }

}, {
    'name': 'connection error followed by server shutdown',
    'run': function (tctx, callback) {
	var c = tctx.ts_clients[0];
	var log = tctx.ts_log;
	var rpc;

	/* Save the RPC handle, and reply so we know we can continue. */
	function fastRpcBlock(r) {
		r.write({ 'start': true });
		rpc = r;
	}

	tctx.ts_server.registerRpcMethod({
		rpcmethod: 'block',
		rpchandler: fastRpcBlock
	});

	/* Kick off an RPC, and wait until it's started. */
	var req = c.tsc_client.rpc({
		'rpcmethod': 'block',
		'rpcargs': [ ]
	});

	/* Ignore (but log) the expected transport error. */
	req.on('error', function (err) {
		log.info(err, 'received expected error');
	});

	/* Kill the RPC once it's started. */
	req.once('data', function () {
		setImmediate(killRPC);
	});

	function killRPC() {
		/* Disconnect client so we'll get EPIPE below. */
		c.tsc_client.detach();
		c.tsc_socket.destroy();

		/* Attempt socket write so onConnectionError() gets called. */
		rpc.write({ 'kaboom': 'error' });
		rpc.end();

		/* Now run the server clean up, which shouldn't crash. */
		tctx.ts_socket.on('close', function () {
			tctx.ts_server.close();
			tctx.ts_closed = true;

			callback();
		});
		tctx.ts_socket.close();
	}
    }

}, {
    'name': 'basic RPC with immediate end-of-stream',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 0,
	    'rpcmethod': 'sleep',
	    'rpcargs': [ { 'ms': 100 } ]
	}, function (err, data, ndata) {
		mod_assertplus.equal(data.length, ndata);
		err = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': null,
		    'dataActual': data,
		    'dataExpected': []
		});

		callback(err);
	});

	tctx.ts_clients[0].tsc_socket.end();
    }

}, {
    'name': 'RPC with large amount of data',
    'run': function (tctx, callback) {
	tctx.firstFastClient().rpcBufferAndCallback({
	    'maxObjectsToBuffer': 50000,
	    'rpcmethod': 'yes',
	    'rpcargs': [ {
	        'count': 50000,
		'value': 'undefined will not be used as a variable name'
	    } ]
	}, function (err, data, ndata) {
		/*
		 * It's only with great restraint that this variable was not
		 * itself named "undefined".
		 */
		var expected = [];
		var i;

		for (i = 0; i < 50000; i++) {
			expected.push({
			    'value': 'undefined will not be used as a ' +
			        'variable name'
			});
		}

		mod_assertplus.equal(data.length, ndata);
		err = expectRpcResult({
		    'errorActual': err,
		    'errorExpected': null,
		    'dataActual': data,
		    'dataExpected': expected
		});

		callback(err);
	});

	tctx.ts_clients[0].tsc_socket.end();
    }

}, {
    'name': 'flow control from server to client',
    'run': function (tctx, callback) {
	var log, client, request, csock;
	var ndata = 0;

	/*
	 * This test does not work on Node v0.10, but we don't claim full
	 * support for that version.
	 */
	log = tctx.ts_log;
	if (mod_testcommon.predatesUsefulPause()) {
		log.warn('skipping test (not supported on v0.10)');
		setImmediate(callback);
		return;
	}

	/*
	 * This test case has an analog in the server test suite.  Changes here
	 * may need to be reflected there.  As described in more detail there,
	 * the scope of flow control is limited because of the way multiple
	 * requests are multiplexed over a single socket.
	 */
	client = tctx.firstFastClient();
	tctx.ts_server.registerRpcMethod({
	    'rpcmethod': 'faucet',
	    'rpchandler': function (rpc) {
		var source = new mod_testcommon.FlowControlSource({
		    'datum': {
		        'value': 'null cannot be used as a variable name'
		    },
		    'restMs': 1000,
		    'log': tctx.ts_log.child({
		        'component': 'FlowControlSource'
		    })
		});

		source.pipe(rpc);
		source.once('resting', function () {
			log.debug('came to rest; verifying and moving on');
			mod_assertplus.ok(mod_testcommon.isFlowControlled(
			    csock));
			mod_assertplus.equal('number',
			    typeof (csock._readableState.length));
			mod_assertplus.equal('number',
			    typeof (csock._readableState.highWaterMark));
			mod_assertplus.ok(csock._readableState.length >=
			    csock._readableState.highWaterMark);

			csock.resume();
			source.stop();
		});
	    }
	});

	/*
	 * We deliberately don't add a "data" listener until later.
	 */
	request = client.rpc({
	    'rpcmethod': 'faucet',
	    'rpcargs': [ {
		'count': 10000,
		'value': 'null cannot be used as a variable name'
	    } ]
	});

	request.on('data', function (d) { ndata++; });

	request.on('end', function () {
		log.debug('finished after %d data items', ndata);
		callback();
	});

	csock = tctx.ts_clients[0].tsc_socket;
	csock.pause();
    }

}, {
    'name': '\'onConnsDestroyed\' callback test',
    'run': function (tctx, callback) {
	var received = false;
	var server = tctx.ts_server;

	var WAIT_MS = 3000;
	var timeout = setTimeout(function () {
		mod_assertplus.ok(false, 'did not receive ' +
		    '\'onConnsDestroyed\' within timeout window');
	}, WAIT_MS);

	function verifyCallbackContext(cb) {
		mod_assertplus.ok(!received, 'received \'onConnsDestroyed\' ' +
		    'callback twice');
		mod_assertplus.ok(server.fs_conns, 'server.fs_conns');
		mod_assertplus.ok(mod_jsprim.isEmpty(server.fs_conns),
		    'received \'onConnsDestroyed\' callback when server had ' +
		    'active server connections');

		received = true;
		cb();
	}

	mod_vasync.waterfall([
		function (qcb) {
			/*
			 * Check that connection count dropping to 0
			 * triggers the callback
			 */
			server.onConnsDestroyed(function () {
				setImmediate(verifyCallbackContext, qcb);
			});
		},
		function (qcb) {
			received = false;
			/*
			 * Check that the callback is issued when the
			 * connection count was already 0 prior to
			 * calling onConnsDestroyed.
			 */
			server.onConnsDestroyed(function () {
				setImmediate(verifyCallbackContext.bind(null,
				    qcb));
			});
		}
	], function (err) {
		clearTimeout(timeout);
		callback();
	});

	tctx.ts_clients.forEach(function (c) {
		c.tsc_client.detach();
		c.tsc_socket.destroy();
	});
    }
}, {
    'name': '\'onConnsDestroyed\' callback after successful rpc',
    'run': function (tctx, callback) {
	function doRpc(client, cb) {
		client.rpcBufferAndCallback({
			'rpcmethod': 'yes',
			'rpcargs': [ {
				value: 'yes',
				count: 1
			} ],
			'maxObjectsToBuffer': 1
		}, function (err, data, ndata) {
			mod_assertplus.ok(!err, 'received unexpected error ' +
				'from dummy rpc');
			mod_assertplus.ok(ndata == 1, 'received more data ' +
				'than expected');
			cb();
		});
	}
	runOnConnsDestroyedCallbackTest(tctx, doRpc, callback);
    }
}, {
    'name': '\'onConnsDestroyed\' callback after protocol error',
    'run': function (tctx, callback) {
	function doBadRpc(client, cb) {
		client.rpcBufferAndCallback({
			'rpcmethod': 'nonexistentrpcmethod',
			'rpcargs': [],
			'maxObjectsToBuffer': 0
		}, function (err, data, ndata) {
			mod_assertplus.ok(err, 'did not receive error on ' +
				'non-existent RPC');
			mod_assertplus.ok(data.length === 0, 'received ' +
				'unexpected data from non-existent RPC');
			cb();
		});
	}
	runOnConnsDestroyedCallbackTest(tctx, doBadRpc, callback);
    }
}, {
    'name': '\'onConnsDestroyed\' multiple callbacks queued',
    'run': function (tctx, callback) {
	var server = tctx.ts_server;

	var callback_one_ts = null;
	var callback_two_ts = null;

	var WAIT_MS = 3000;
	var timeout = setTimeout(function () {
		mod_assertplus.ok(false, 'did not complete callbacks in time');
	}, WAIT_MS);

	function verifyCallbackContext(hrtime) {
		mod_assertplus.ok(hrtime === null, 'received ' +
		    '\'onConnsDestroyed\' callback more than once');

		mod_assertplus.ok(server.fs_conns, 'server.fs_conns');
		mod_assertplus.ok(mod_jsprim.isEmpty(server.fs_conns),
		    'received \'onConnsDestroyed\' callback from a server ' +
		    'with active connections');
	}

	server.onConnsDestroyed(function () {
		setImmediate(verifyCallbackContext.bind(null, callback_one_ts));
		callback_one_ts = process.hrtime();
	});

	server.onConnsDestroyed(function () {
		setImmediate(verifyCallbackContext.bind(null, callback_two_ts));
		callback_two_ts = process.hrtime();

		mod_assertplus.ok(callback_one_ts !== null, 'received ' +
			'second callback without receiving the first');

		var one_ts = mod_jsprim.hrtimeNanosec(callback_one_ts);
		var two_ts = mod_jsprim.hrtimeNanosec(callback_two_ts);
		mod_assertplus.ok(one_ts <= two_ts, 'callbacks received in ' +
		    'wrong order');

		clearTimeout(timeout);
		callback();
	});

	tctx.ts_clients.forEach(function (c) {
		c.tsc_client.detach();
		c.tsc_socket.destroy();
	});

    }
}, {
    'name': '\'onConnsDestroyed\' callback after many requests',
    'run': function (tctx, callback) {
	var which = 0;
	var server = tctx.ts_server;
	var server_socket = tctx.ts_socket;

	var callback_ts = null;
	var finish_ts = null;

	server.registerRpcMethod({
		'rpcmethod': 'alternate',
		'rpchandler': function (rpc) {
			var whichrpc = which++;
			if (whichrpc % 2 === 0) {
				rpc.end({'value': whichrpc});
			} else {
				rpc.fail(new VError('%d', whichrpc));
			}
		}
	});

	/*
	 * Subscribe to the empty connection set notification upon
	 * connecting the second client.
	 */
	server_socket.once('connection', function () {
		/*
		 * We expect that the callback is called after both
		 * clients have closed their connections to the server.
		 */
		server.onConnsDestroyed(function () {
			mod_assertplus.ok(callback_ts === null, 'received ' +
				'\'onConnsDestroyed\' callback twice');
			mod_assertplus.ok(tctx.ts_server.fs_conns,
			    'tctx.ts_server.fs_conns');
			mod_assertplus.ok(mod_jsprim.isEmpty(server.fs_conns),
				'received \'onConnsDestroyed\' callback with ' +
				'active server connections');
			callback_ts = process.hrtime();
		});
	});

	tctx.connectClient(function () {
		var choice = 0;
		var nrequests = 200;
		var ncomplete = 0;
		var barrier = mod_vasync.barrier();

		barrier.start('rpcs');

		var queue = mod_vasync.queuev({
			'concurrency': 100,
			'worker': function makeRequest(_, qcallback) {
				choice = 1 - choice;
				var c = tctx.ts_clients[choice].tsc_client;
				c.rpcBufferAndCallback({
					'rpcmethod': 'alternate',
					'rpcargs': [],
					'maxObjectsToBuffer': 1
				}, function () {
					if (++ncomplete == nrequests) {
						barrier.done('rpcs');
					}
				});
				qcallback();
			}
		});
		for (var i = 0; i < nrequests; i++) {
			queue.push(i);
		}

		/*
		 * Detach and close the clients that sent the requests
		 * that just finished sending requests. This should
		 * trigger the 'onConnsDestroyed' callback.
		 */
		barrier.on('drain', function () {
			var WAIT = 3000;
			finish_ts = process.hrtime();
			tctx.ts_clients.forEach(function (c) {
				c.tsc_client.detach();
				c.tsc_socket.destroy();
			});
			setTimeout(checkForOnConnsDestroyedCallback, WAIT);
		});

		/*
		 * Called after all the requests have been sent to
		 * verify that the onConnsDestroyed callback was received
		 * after the stream of requests completed.
		 */
		function checkForOnConnsDestroyedCallback() {
			mod_assertplus.ok(callback_ts !== null, 'did not ' +
			    'receive \'onConnsDestroyed\' callback');

			var destroyed = mod_jsprim.hrtimeNanosec(callback_ts);
			var finish = mod_jsprim.hrtimeNanosec(finish_ts);

			/*
			 * Sanity check that the 'onConnsDestroyed' callback
			 * was emitted after the client sockets were
			 * closed.
			 */
			mod_assertplus.ok(destroyed >= finish, 'received ' +
			    '\'onConnsDestroyed\' callback before all ' +
			    'requests were sent');

			callback();
		}
	});
    }
} ];

main();
