/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * test/common/client.js: common facilities for testing the client
 */

var mod_assertplus = require('assert-plus');
var mod_net = require('net');

var mod_client = require('../../lib/fast_client');
var mod_protocol = require('../../lib/fast_protocol');
var mod_testcommon = require('../common');

exports.ClientTestContext = ClientTestContext;

/*
 * The ClientTestContext class provides common functions for setting up a
 * FastClient and connecting it to a mock server.  This class logs all activity
 * and keeps track of events emitted.
 *
 * Note that this class is just a convenience.  It doesn't do any real
 * implementation hiding.  Callers are free to mess with internal members as
 * needed to exercise various functionality.
 */
function ClientTestContext(args)
{
	mod_assertplus.object(args.server);
	mod_assertplus.object(args.log);
	mod_assertplus.optionalObject(args.collector);
	mod_assertplus.optionalNumber(args.client_crc_mode);
	mod_assertplus.optionalNumber(args.server_decoder_crc_mode);

	this.ctc_collector = args.collector; /* artedi collector */
	this.ctc_log = args.log;		/* bunyan logger */
	this.ctc_closed = false;		/* already cleaned up */

	/*
	 * Settings to test the CRC modes added to support transitioning off the
	 * buggy node-crc@0.3.0 dependency.
	 */
	this.client_crc_mode = args.client_crc_mode ||
	    mod_protocol.FAST_CHECKSUM_V2;
	this.server_decoder_crc_mode = args.server_decoder_crc_mode ||
	    mod_protocol.FAST_CHECKSUM_V2;
	this.server_encoder_crc_mode = args.server_encoder_crc_mode ||
	    mod_protocol.FAST_CHECKSUM_V2;

	/* server handles */
	this.ctc_server = args.server;	/* server listening socket */
	this.ctc_server_sock = null;	/* server-side connection to client */
	this.ctc_server_message = null; /* first message received by server */
	this.ctc_server_decoder = null; /* decoder piped from ctc_server_sock */
	this.ctc_server_encoder = null; /* encoder piped to ctc_server_sock */

	/* client handles */
	this.ctc_client_sock = null;	/* client TCP socket */
	this.ctc_fastclient = null;	/* FastClient handle */

	/* client events emitted */
	this.ctc_error_client = null;	/* emitted on this.ctc_fastclient */
	this.ctc_error_sock = null;	/* emitted on this.ctc_client_sock */
}

/*
 * Creates a Fast client and connects it to the server.
 */
ClientTestContext.prototype.establishConnection = function ()
{
	var self = this;

	mod_assertplus.ok(!this.ctc_closed);
	this.ctc_client_sock = mod_net.createConnection(
	    mod_testcommon.serverPort, mod_testcommon.serverIp);
	this.ctc_fastclient = new mod_client.FastClient({
	    'collector': this.ctc_collector,
	    'log': this.ctc_log.child({ 'component': 'FastClient' }),
	    'nRecentRequests': 100,
	    'transport': this.ctc_client_sock,
	    'crc_mode': this.client_crc_mode
	});

	this.ctc_fastclient.on('error', function (err) {
		self.ctc_log.debug(err, 'client error');
		mod_assertplus.ok(self.ctc_error_client === null,
		    'client emitted more than one error');
		self.ctc_error_client = err;
	});

	this.ctc_server.once('connection', function (sock) {
		mod_assertplus.ok(self.ctc_server_sock === null);
		self.ctc_log.debug('server accepted connection');
		self.ctc_server_sock = sock;
		self.ctc_server_encoder.pipe(sock);
		sock.pipe(self.ctc_server_decoder);
	});

	this.ctc_server_encoder =
	    new mod_protocol.FastMessageEncoder(this.server_encoder_crc_mode);
	this.ctc_server_decoder =
	    new mod_protocol.FastMessageDecoder(this.server_decoder_crc_mode);
};

/*
 * Instructs that the server should handle the next RPC request that it sees.
 */
ClientTestContext.prototype.handleNextRequest = function (options)
{
	var self = this;
	mod_assertplus.bool(options.data);
	mod_assertplus.bool(options.error);

	mod_assertplus.ok(!this.ctc_closed);
	this.ctc_server_decoder.once('data', function (message) {
		self.ctc_log.debug({
		    'msgid': message.msgid
		}, 'server got request');

		self.ctc_server_message = message;
		self.serverReply(message, options);
	});
};

/*
 * Reply to the given RPC request.
 */
ClientTestContext.prototype.serverReply = function (message, options)
{
	mod_assertplus.object(options);
	mod_assertplus.bool(options.data);
	mod_assertplus.bool(options.error);

	if (options.data) {
		this.ctc_server_encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_DATA,
		    'data': mod_testcommon.dummyResponseData
		});
	}

	if (options.error) {
		this.ctc_server_encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_ERROR,
		    'data': mod_testcommon.dummyResponseError
		});
	} else {
		this.ctc_server_encoder.write({
		    'msgid': message.msgid,
		    'status': mod_protocol.FP_STATUS_END,
		    'data': mod_testcommon.dummyResponseData
		});
	}
};

/*
 * Direct the client to execute an RPC request.	 Returns a ClientTestRequest,
 * which keeps track of events emitted on the request.
 */
ClientTestContext.prototype.makeRequest = function (callback)
{
	return (this.makeRequestWithOptions({}, callback));
};

ClientTestContext.prototype.makeRequestWithOptions =
    function (options, callback)
{
	var req, log;
	var ctr = new ClientTestRequest(this);

	mod_assertplus.ok(!this.ctc_closed);
	ctr.ctr_data = [];

	req = ctr.ctr_request = this.ctc_fastclient.rpc({
	    'ignoreNullValues': options.ignoreNullValues,
	    'rpcmethod': mod_testcommon.dummyRpcMethodName,
	    'rpcargs': mod_testcommon.dummyRpcArgs
	});

	ctr.ctr_log = this.ctc_log.child({ 'requestId': req.requestId() });
	log = ctr.ctr_log;
	log.debug('issued RPC');
	req.on('data', function (d) {
		log.debug(d, 'request data');
		ctr.ctr_data.push(d);
	});

	req.on('end', function () {
		log.debug('request end');
		mod_assertplus.ok(!ctr.ctr_done);
		ctr.ctr_done = true;
		/*
		 * This relies a bit on implicit semantics, but we invoke the
		 * callback on the next tick so that if the client object emits
		 * an error after this event, the caller will be able to see
		 * that.
		 */
		setImmediate(callback);
	});

	req.on('error', function (err) {
		log.debug(err, 'request error');
		mod_assertplus.ok(!ctr.ctr_done);
		ctr.ctr_done = true;
		ctr.ctr_error = err;
		setImmediate(callback);
	});

	return (ctr);
};

/*
 * Clean up the client and server connections.	This does not close the
 * listening socket.
 */
ClientTestContext.prototype.cleanup = function ()
{
	mod_assertplus.ok(!this.ctc_closed);
	this.ctc_closed = true;
	this.ctc_client_sock.destroy();

	if (this.ctc_server_sock !== null) {
		this.ctc_server_sock.destroy();
	}
};


/*
 * This helper class keeps track of the state of a single client request.
 */
function ClientTestRequest(ctc)
{
	this.ctr_context = ctc;		/* parent ClientTestContext */
	this.ctr_request = null;	/* FastClientRequest object */
	this.ctr_error = null;		/* "error" emitted */
	this.ctr_data = [];		/* "data" events emitted */
	this.ctr_done = false;		/* request has completed */
	this.ctr_log = null;		/* bunyan logger */
}
