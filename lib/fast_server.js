/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * lib/fast_server.js: public node-fast server interface
 *
 * The public interface for this module is the FastServer class, which takes a
 * server socket and manages connections to clients that connect to the server.
 * Callers register RPC method handlers with the server, and their handler
 * functions are invoked when RPC requests are received for the registered
 * method.  RPC handlers are functions that take a single argument, an RPC
 * context, through which the handler can access the RPC arguments and send data
 * back to the client.
 *
 *
 * Flow control
 *
 * The implementation of the server is structured primarily into object-mode
 * streams to support Node's built-in flow control.  This is only of limited
 * utility at this time, since the client does not support per-request flow
 * control.  However, if a client is itself reading slowly, then this mechanism
 * allows the server manage backpressure appropriately.
 *
 * The RPC context argument provided to RPC method handlers is itself an
 * object-mode stream.  Objects written to the stream are sent to the client.
 * When the stream is ended, an "end" message is written to the client, which
 * signifies the successful completion of the RPC call.  The stream pipeline
 * from the RPC context to the client socket fully supports flow control, so the
 * stream will used a bounded amount of memory as long as the RPC method
 * respects Node's flow-control semantics (e.g., stops writing to the stream
 * when write() returns false).  The pipeline looks like this:
 *
 *     RPC request context    (provided as argument to RPC method handlers)
 *         |
 *         | (pipe: objects)
 *         v
 *     FastRpcResponseEncoder (wraps objects in Fast "DATA" messages, and
 *         |                  terminates the stream with an "END" message)
 *         | (pipe: objects)
 *         v
 *     FastMessageEncoder     (serializes logical Fast messages into buffers)
 *         |
 *         | (pipe: bytes)
 *         v
 *     Client socket          (usually a net.Socket object for TCP)
 *
 * Of course, many of these pipelines may be piped to the same net.Socket
 * object.  This has an unexpected, unfortunate scaling limitation: the
 * completion of a pipe() operation causes Node to remove event listeners, and
 * EventEmitter.removeListener() is O(N), where N is the number of listeners for
 * the same event.  As a result, if a client maintains N concurrent requests,
 * then completion of each request will run into this O(N) step.  This results
 * in an O(N^2) factor in the overall time to complete N requests.  The Node API
 * does not seem fixable.  We could implement a tree of EventEmitters that
 * funnel into the socket, but it's not clear at this point that this
 * consideration is worthwhile.  In practice, Fast servers are more likely to
 * see many clients making a small number of requests each rather than a small
 * number of clients making a large number of requests each, and this deployment
 * model is recommended to avoid this scaling limiter.
 *
 * Flow control is less well-supported on the receiving side because it's less
 * clear what the source of backpressure should be.  The pipeline looks like
 * this:
 *
 *    +---------------------------------------------------------------------+
 *    | Per-connection pipeline                                             |
 *    | -----------------------                                             |
 *    |                                                                     |
 *    |    Client socket             (usually a net.Socket object for TCP)  |
 *    |        |                                                            |
 *    |        | (pipe: bytes)                                              |
 *    |        v                                                            |
 *    |    FastMessageDecoder        (unmarshals Fast messages from bytes   |
 *    |        |                     received on the socket)                |
 *    |        | (pipe: objects)                                            |
 *    |        v                                                            |
 *    |    FastRpcConnectionDecoder  (tags incoming Fast messages with a    |
 *    |        |                     connection identifier for session      |
 *    |        | (pipe: objects)     tracking)                              |
 *    |        |                                                            |
 *    +------- | -----------------------------------------------------------+
 *             |
 *             v
 *       FastMessageHandler          (one for the entire server that invokes
 *                                   server.onMessage() for each message)
 *
 * Since there are many connections and one FastMessageHandler for the server,
 * the whole picture looks like this:
 *
 *                    Connection  Connection  Connection
 *                     pipeline    pipeline    pipeline
 *                         |           |           |
 *                   ...   |   ...     |   ...     | ...
 *                         |           |           |
 *                         v           v           v
 *                       +---------------------------+
 *                       |    FastMessageHandler     |
 *                       +---------------------------+
 *                                     |
 *                                     v
 *                             server.onMessage()
 *
 * The FastMessageHandler currently provides no backpressure.  If desired, a
 * a simple throttle could flow-control the entire pipeline based on concurrent
 * outstanding RPC requests.  A more complex governor could look at the the
 * count of requests per connection and prioritize some notion of fairness among
 * them.  As a result of the lack of flow control here, it's possible for any
 * client to overwhelm the server by blasting messages to it; however, because
 * the intended deployment is not a byzantine environment, this issue is not
 * considered a priority for future work.
 */

var mod_assertplus = require('assert-plus');
var mod_dtrace = require('dtrace-provider');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_microtime = require('microtime');
var mod_stream = require('stream');
var mod_util = require('util');
var VError = require('verror');

var mod_protocol = require('./fast_protocol');
var mod_subr = require('./subr');

exports.FastServer = FastServer;

/*
 * This maximum is chosen pretty arbitrarily.
 */
var FS_MAX_CONNID = (1 << 30);

/*
 * There's one DTrace provider for all servers using this copy of this module.
 */
var fastServerProvider = null;

/*
 * We have one counter for the number of servers in this process.  This is a
 * true JavaScript global.  See the note in lib/fast_client.js.
 */
/* jsl:declare fastNservers */
fastNservers = 0;

/*
 * Instantiate a new server for handling RPC requests made from remote Fast
 * clients.  This server does not manage the underlying server socket.  That's
 * the responsibility of the caller.
 *
 * Named arguments:
 *
 *     log		bunyan-style logger
 *
 *     server		server object that emits 'connection' events
 *
 *     collector	artedi-style metric collector
 *
 * Use the server by invoking the registerRpcMethod() method to register
 * handlers for named RPC methods.
 */
function FastServer(args)
{
	var self = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.object(args.server, 'args.server');
	mod_assertplus.optionalObject(args.collector, 'args.collector');

	this.fs_log = args.log;		/* logger */
	this.fs_server = args.server;	/* server socket */
	this.fs_collector = args.collector;		/* metric collector */
	this.fs_handlers = {};		/* registered handlers, by name */
	this.fs_conns = {};		/* active connections */
	this.fs_msghandler = new FastMessageHandler({
	    'server': this
	});
	/*
	 * See the comments below on use of setMaxListeners().
	 */
	this.fs_msghandler.setMaxListeners(0);
	this.fs_connallocator = new mod_subr.IdAllocator({
	    'min': 1,
	    'max': FS_MAX_CONNID,
	    'isAllocated': function isConnIdAllocated(id) {
		return (self.fs_conns.hasOwnProperty(id));
	    }
	});
	this.fs_closed = false;		/* server is shutting down */

	this.fs_server.on('connection',
	    function onConnection(sock) { self.connCreate(sock); });

	this.fs_nignored_noconn = 0;	/* count of msgs ignored: no conn */
	this.fs_nignored_badconn = 0;	/* count of msgs ignored: bad conn */
	this.fs_nignored_aborts = 0;	/* count of msgs ignored: aborts */
	this.fs_nconnections_created = 0;	/* count of conns created */
	this.fs_nrequests_started = 0;		/* count of reqs started */
	this.fs_nrequests_completed = 0;	/* count of reqs completed */
	this.fs_nrequests_failed = 0;		/* count of reqs failed */

	if (this.fs_collector) {
		this.fs_request_counter = this.fs_collector.counter({
			name: 'fast_requests_completed',
			help: 'count of fast requests completed'
		});
		this.fs_latency_histogram = this.fs_collector.histogram({
			name: 'fast_request_time_ms',
			help: 'total time to process fast requests'
		});
	}

	if (fastServerProvider === null) {
		fastServerProvider = fastServerProviderInit();
	}

	mod_assertplus.object(fastServerProvider);
	this.fs_dtid = fastNservers++;
	this.fs_dtp = fastServerProvider;
}

/* public methods */

FastServer.prototype.registerRpcMethod = function (args)
{
	var rpcmethod, handler;

	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.rpcmethod, 'args.rpcmethod');
	mod_assertplus.func(args.rpchandler, 'args.rpchandler');

	rpcmethod = args.rpcmethod;
	handler = args.rpchandler;
	mod_assertplus.ok(!this.fs_handlers.hasOwnProperty(rpcmethod),
	    'duplicate handler registered for method "' + rpcmethod + '"');

	this.fs_log.info({ 'rpcmethod': rpcmethod }, 'registered RPC method');
	this.fs_handlers[rpcmethod] = new FastRpcHandler({
	    'rpcmethod': rpcmethod,
	    'rpchandler': handler
	});
};

FastServer.prototype.close = function ()
{
	var error, connid;

	mod_assertplus.ok(arguments.length === 0,
	    'close() accepts no arguments');

	if (this.fs_closed) {
		this.fs_log.warn('close() called while already shutting down');
		return;
	}

	this.fs_log.info('shutting down');
	this.fs_closed = true;
	error = new VError('server is shutting down');
	for (connid in this.fs_conns) {
		this.connTerminate(this.fs_conns[connid], error);
	}
};

/*
 * Public methods for exposing debugging data over kang.
 *
 * Over kang, we expose basic statistics about the server (suitable for
 * real-time monitoring of basic activity), as well as objects of types:
 *
 *     fastconnection     describes a client that's currently connected,
 *			  including local and remote address information
 *			  and basic activity stats
 *
 *     fastrequest	  describes a request that's currently outstanding,
 *			  including which connection received it, how long it's
 *			  been running, and what state it's in
 */

FastServer.prototype.kangStats = function ()
{
	var rv = {};
	rv['nConnectionsActive'] = Object.keys(this.fs_conns).length;
	rv['nIgnoredMessagesNoConn'] = this.fs_nignored_noconn;
	rv['nIgnoredMessagesBadConn'] = this.fs_nignored_badconn;
	rv['nIgnoredMessagesAborts'] = this.fs_nignored_aborts;
	rv['nConnectionsCreated'] = this.fs_nconnections_created;
	rv['nRequestsStarted'] = this.fs_nrequests_started;
	rv['nRequestsCompleted'] = this.fs_nrequests_completed;
	rv['nRequestsFailed'] = this.fs_nrequests_failed;
	return (rv);
};

FastServer.prototype.kangListTypes = function ()
{
	return ([ 'fastconnection', 'fastrequest' ]);
};

FastServer.prototype.kangListObjects = function (type)
{
	if (type == 'fastconnection') {
		return (Object.keys(this.fs_conns));
	}

	var rv = [];
	mod_assertplus.equal(type, 'fastrequest');
	mod_jsprim.forEachKey(this.fs_conns, function (cid, conn) {
		Object.keys(conn.fc_pending).map(function (msgid) {
			rv.push(cid + '/' + msgid);
		});
	});

	return (rv);
};

FastServer.prototype.kangGetObject = function (type, id)
{
	var conn, rv;
	var parts, req;

	if (type == 'fastconnection') {
		conn = this.fs_conns[id];
		rv = {
		    'connid': conn.fc_connid,
		    'addrinfo': conn.fc_addrinfo,
		    'nStarted': conn.fc_nstarted,
		    'nCompleted': conn.fc_ncompleted,
		    'nFailed': conn.fc_nfailed,
		    'draining': conn.fc_draining,
		    'errorSocket': conn.fc_socket_error,
		    'errorServer': conn.fc_server_error,
		    'timeAccepted': conn.fc_taccepted.toISOString()
		};
		return (rv);
	}

	mod_assertplus.equal(type, 'fastrequest');
	parts = id.split('/');
	mod_assertplus.equal(parts.length, 2);
	conn = this.fs_conns[parts[0]];
	req = conn.fc_pending[parts[1]];
	rv = {
	    'connid': parts[0],
	    'msgid': parts[1],
	    'rpcmethod': req.fsr_rpcmethod,
	    'rpcargs': req.fsr_rpcargs,
	    'state': req.fsr_state,
	    'error': req.fsr_error,
	    'blackholed': req.fsr_blackhole !== null,
	    'timeStarted': req.fsr_tstarted.toISOString()
	};
	return (rv);
};

/* private methods */

/*
 * Connection lifecycle
 *
 * Connections are created when the underlying Server (usually either a TCP or
 * UDS server) emits a 'connection' event.  In connCreate(), we set up data
 * structures to manage a FastRpcConnection atop the new socket.
 *
 * Connections remain operational until they are abandoned for one of three
 * reasons:
 *
 *     o We read end-of-stream from the socket.  This is a graceful termination
 *       that we might expect when the remote side is shutting down after
 *       completing all of its RPC requests.
 *
 *     o We see an 'error' event on the socket.  This is an ungraceful
 *       termination of the connection that we might expect in the face of a
 *       network error.
 *
 *     o We proactively terminate the connection because we've read an invalid
 *       Fast protocol message or something else that's confused us as to the
 *       state of the connection, or we're shutting down the server.
 *
 * This is managed through the following call chain:
 *
 *                        connection arrives
 *                                |
 *                                v
 *            connCreate() sets up the FastRpcConnection
 *                                |
 *                                v
 *                       normal operation
 *                          |     |    |
 *        +-----------------+     |    +---------------------+
 *        |                       |                          |
 *        | onConnectionEnd():    | onConnectionError():     | connTerminate():
 *        | end-of-stream read    | socket error             | protocol error
 *        |                       |                          | or server
 *        |                       | connDisconnectRequests() | shutdown
 *        |                       |                          |
 *        +---------------------> + <------------------------+
 *                                |
 *                                v
 *                         connDrain():
 *                         wait for pending requests to complete
 *                                |
 *                                v
 *                         connection removed
 */

FastServer.prototype.connCreate = function (sock)
{
	var self = this;
	var cid, fastconn;

	cid = this.allocConnectionId(sock);
	mod_assertplus.ok(cid);
	mod_assertplus.ok(!this.fs_conns.hasOwnProperty(cid));
	fastconn = new FastRpcConnection({
	    'connId': cid,
	    'socket': sock,
	    'log': this.fs_log
	});

	this.fs_nconnections_created++;
	this.fs_conns[cid] = fastconn;
	this.fs_dtp.fire('conn-create', function () {
	    return ([ self.fs_dtid, cid, fastconn.fc_addrinfo.label ]);
	});
	fastconn.fc_taccepted = new Date();
	fastconn.fc_ckddecoder.pipe(this.fs_msghandler, { 'end': false });
	fastconn.fc_log.info('connection received');

	sock.on('end', function onConnectionEnd() {
		self.onConnectionEnd(cid, fastconn);
	});

	sock.on('error', function onConnectionError(err) {
		self.onConnectionError(cid, fastconn, err);
	});

	/*
	 * We shouldn't get here if the server is closing because the caller
	 * should have shut down the server socket.  If we wind up seeing a
	 * queued connection, terminate it immediately.
	 */
	if (this.fs_closed) {
		this.fs_log.warn('unexpected connection after server shutdown');
		this.connTerminate(new VError('server is shutting down'));
	}
};

/*
 * Remove this connection because we've read end-of-stream.  We will wait for
 * pending requests to complete before actually removing the connection.
 */
FastServer.prototype.onConnectionEnd = function (cid, conn)
{
	mod_assertplus.ok(conn instanceof FastRpcConnection);
	mod_assertplus.ok(this.fs_conns.hasOwnProperty(cid));
	mod_assertplus.ok(this.fs_conns[cid] == conn);

	/*
	 * Due to Node issue 6083, it's possible to see an "end" event after
	 * having previously seen an "error" event.  Ignore such events.
	 */
	if (conn.fc_socket_error !== null) {
		conn.fc_log.debug('ignoring end-of-stream after error');
	} else {
		conn.fc_ended = true;
		conn.fc_log.debug('end of input');
		this.connDrain(conn);
	}
};

/*
 * Abandon this connection because we've seen a socket error.  This can happen
 * after the connection has already read end-of-stream or experienced a
 * protocol-level error.
 */
FastServer.prototype.onConnectionError = function (cid, conn, err)
{
	mod_assertplus.ok(conn instanceof FastRpcConnection);
	mod_assertplus.ok(err instanceof Error);
	mod_assertplus.ok(this.fs_conns.hasOwnProperty(cid));
	mod_assertplus.ok(this.fs_conns[cid] == conn);
	mod_assertplus.ok(conn.fc_socket_error === null);
	conn.fc_socket_error = err;
	conn.fc_log.warn(err, 'socket error');

	/*
	 * If we've already seen a server error, then we're already tearing down
	 * the connection.
	 */
	if (conn.fc_server_error === null) {
		this.connDisconnectRequests(conn);
		this.connDrain(conn);
	}
};

/*
 * Allocate an internal connection id.  Callers will use this as a string (as an
 * object property name), and callers assume that it cannot be falsey.
 */
FastServer.prototype.allocConnectionId = function ()
{
	return (this.fs_connallocator.alloc());
};

/*
 * Terminate this connection because of a protocol error or a server shutdown.
 * We do not allow existing requests to complete for this case.
 */
FastServer.prototype.connTerminate = function (conn, err)
{
	mod_assertplus.ok(conn instanceof FastRpcConnection);
	mod_assertplus.ok(err instanceof Error);

	if (conn.fc_server_error === null && conn.fc_socket_error === null) {
		conn.fc_log.warn(err, 'gracefully terminating connection');
		conn.fc_server_error = err;
		this.connDisconnectRequests(conn);
		this.connDrain(conn);
	} else {
		conn.fc_log.warn(err, 'already terminating connection');
	}
};

/*
 * Disconnect all requests associated with this connection from the connection
 * itself, generally as a result of a fatal error on the connection.
 */
FastServer.prototype.connDisconnectRequests = function (conn)
{
	var msgid;

	for (msgid in conn.fc_pending) {
		this.requestDisconnect(conn.fc_pending[msgid]);
	}

	conn.fc_socket.destroy();
};

/*
 * Wait for outstanding requests to complete and then remove this connection
 * from the server.
 */
FastServer.prototype.connDrain = function (conn)
{
	var self = this;

	mod_assertplus.ok(this.fs_conns[conn.fc_connid] == conn);

	if (!mod_jsprim.isEmpty(conn.fc_pending)) {
		mod_assertplus.ok(conn.fc_nstarted > conn.fc_ncompleted);
		conn.fc_log.debug({
		    'remaining': conn.fc_nstarted - conn.fc_ncompleted
		}, 'waiting for request drain');
		conn.fc_draining = true;
	} else {
		mod_assertplus.equal(conn.fc_nstarted, conn.fc_ncompleted);
		conn.fc_log.info('removing drained connection');
		delete (this.fs_conns[conn.fc_connid]);
		this.fs_dtp.fire('conn-destroy', function () {
		    return ([ self.fs_dtid, conn.fc_connid ]);
		});

		if (conn.fc_socket_error !== null) {
			/*
			 * If we did see a socket error, then we must explicitly
			 * tear down the pipeline.  Otherwise, these streams
			 * will maintain references to each other, resulting in
			 * a leak.
			 */
			conn.fc_socket.unpipe();
			conn.fc_ckddecoder.unpipe();
			conn.fc_rawdecoder.unpipe();
		} else if (conn.fc_server_error === null) {
			/*
			 * As long as we didn't see a socket error and didn't
			 * already terminate the socket, destroy the socket.  We
			 * could try to end it gracefully, but we don't actually
			 * want to wait for the client to shut it down cleanly.
			 * If we already saw an error, then there's nothing else
			 * to do.
			 */
			conn.fc_socket.destroy();
		}
	}
};


/*
 * Message handling
 *
 * The only message we actually expect from clients is a DATA message, which
 * represents an RPC call.  This function handles those messages and either
 * ignores or issues appropriate errors for other kinds of messages.
 */

FastServer.prototype.onMessage = function (message)
{
	var connid, conn;
	var msgid, req;
	var handler, handlerfunc;
	var self = this;

	connid = message.connId;
	mod_assertplus.ok(connid);

	if (!this.fs_conns.hasOwnProperty(connid)) {
		/*
		 * This should only be possible if there were messages queued up
		 * from a connection that has since been destroyed.
		 */
		this.fs_log.warn({
		    'fastMessage': message
		}, 'dropping message from unknown connection');
		this.fs_nignored_noconn++;
		return;
	}

	conn = this.fs_conns[connid];
	if (conn.fc_ended || conn.fc_socket_error !== null) {
		this.fs_log.warn({
		    'fastMessage': message
		}, 'dropping message from abandoned connection');
		this.fs_nignored_badconn++;
		return;
	}

	if (message.status === mod_protocol.FP_STATUS_END) {
		/*
		 * There's no reason clients should ever send us an "end" event.
		 */
		this.connTerminate(conn, new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'unexpected_status'
		    }
		}, 'unexpected END event from client'));
		return;
	}

	msgid = message.msgid;
	if (message.status === mod_protocol.FP_STATUS_ERROR) {
		/*
		 * Intermediate versions of node-fast would send ERROR messages
		 * to request RPC cancellation.  We don't support this.  See the
		 * notes inside lib/fast_client.js for details on why.  Such
		 * clients may expect a response from us in the form of an ERROR
		 * message, but we just let the RPC complete normally.  After
		 * all, because of the inherent race between receiving the abort
		 * and completing the RPC, the client has to handle this
		 * possibility anyway.
		 */
		this.fs_log.warn({
		    'msgid': msgid
		}, 'ignoring request to abort RPC (not supported)');
		this.fs_nignored_aborts++;
		return;
	}

	mod_assertplus.equal(message.status, mod_protocol.FP_STATUS_DATA);
	if (conn.fc_pending.hasOwnProperty(msgid)) {
		this.connTerminate(conn, new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'duplicate_msgid',
			'rpcMsgid': msgid
		    }
		}, 'client attempted to re-use msgid'));
		return;
	}

	/*
	 * The message decoder only validates the Fast message and that the
	 * payload in the message is a valid, non-null JSON object.  Here, we
	 * validate the details of the payload.
	 */
	conn.fc_nstarted++;
	this.fs_nrequests_started++;
	req = new FastRpcServerRequest({
	    'server': this,
	    'fastMessage': message,
	    'fastConn': conn,
	    'log': conn.fc_log.child({ 'msgid': message.msgid }, true)
	});
	conn.fc_pending[req.fsr_msgid] = req;
	req.fsr_hrtstarted = process.hrtime();
	req.fsr_tstarted = new Date();

	mod_assertplus.equal(typeof (message.data), 'object');
	mod_assertplus.ok(message.data !== null);
	if (!message.data.m || !message.data.m.name ||
	    typeof (message.data.m.name) != 'string' ||
	    !message.data.d || !Array.isArray(message.data.d)) {
		this.requestFail(req, new VError({
		    'name': 'FastError',
		    'info': {
			'fastReason': 'bad_data',
			'rpcMsgid': message.msgid,
			'rpcMessage': message
		    }
		}, 'RPC request is not well-formed'));
		return;
	}

	req.fsr_rpcmethod = message.data.m.name;
	req.fsr_rpcargs = message.data.d;
	if (!this.fs_handlers.hasOwnProperty(req.fsr_rpcmethod)) {
		this.requestFail(req, new VError({
		    'name': 'FastError',
		    'info': {
			'fastReason': 'bad_method',
			'rpcMethod': req.fsr_rpcmethod,
			'rpcMsgid': message.msgid
		    }
		}, 'unsupported RPC method: "%s"', req.fsr_rpcmethod));
		return;
	}


	handler = this.fs_handlers[req.fsr_rpcmethod];
	handler.fh_nstarted++;
	handlerfunc = handler.fh_handler;
	req.fsr_handler = handler;

	/*
	 * We skip the FR_S_QUEUED state because we do not currently limit
	 * request concurrency.
	 */
	req.fsr_state = FR_S_RUNNING;
	req.fsr_encoder.pipe(conn.fc_msgencoder, { 'end': false });
	req.fsr_docomplete = function () { self.requestComplete(req); };
	req.fsr_encoder.on('end', req.fsr_docomplete);
	req.fsr_log.debug('request started');
	this.fs_dtp.fire('rpc-start', function () {
		return ([ self.fs_dtid, conn.fc_connid, req.fsr_msgid,
		    req.fsr_rpcmethod ]);
	});
	handlerfunc(req.fsr_context);
};

/*
 * Request lifecycle
 *
 * Requests are created via server.onMessage() and then advance through the
 * following state machine:
 *
 *        +------------- FR_S_INIT -------------+
 *        |                                     |
 *        | validation okay                     |
 *        v                                     | validation failed
 *     FR_S_QUEUED                              | (invalid or missing method
 *        |                                     | name, missing arguments, etc.)
 *        | request handler invoked             |
 *        v                                     |
 *     FR_S_RUNNING                             |
 *        |                                     |
 *        | request handler ends stream or      |
 *        | invokes stream.fail(error)          |
 *        |                                     |
 *        +----------> FR_S_COMPLETE <----------+
 *
 * There are two paths for reaching FR_S_COMPLETE:
 *
 *     - normal termination (handler ends the stream): server.requestComplete()
 *
 *     - graceful error (handler invokes fail(error)): server.requestFail()
 *
 * In both cases, server.requestCleanup() is invoked to finish processing the
 * request.
 */

var FR_S_INIT     = 'INIT';
var FR_S_QUEUED   = 'QUEUED';
var FR_S_RUNNING  = 'RUNNING';
var FR_S_COMPLETE = 'COMPLETE';

/*
 * Fail the given RPC request with the specified error.  This entry point is
 * invoked by RPC implementors returning an error.
 */
FastServer.prototype.requestFail = function (request, error)
{
	mod_assertplus.ok(request instanceof FastRpcServerRequest);
	mod_assertplus.ok(error instanceof Error,
	    'failure must be represented as an Error instance');

	request.fsr_error = error;
	request.fsr_state = FR_S_COMPLETE;
	request.fsr_log.debug(error, 'request failed');

	request.fsr_conn.fc_msgencoder.write(requestMakeMessage(
	    request, mod_protocol.FP_STATUS_ERROR, error));


	/*
	 * In the case of normal termination, the implementor ends the
	 * context stream, which tears down the pipeline between that
	 * stream, the request's encoder, and the connection's encoder.
	 * In this case, though, that pipeline is still set up, and we
	 * must explicitly tear it off at the connection end of the
	 * pipeline so the rest can be garbage collected.
	 */
	request.fsr_encoder.unpipe(request.fsr_conn.fc_msgencoder);

	this.requestCleanup(request);
};

/*
 * Mark the given RPC request having completed successfully.  This is implicitly
 * invoked by RPC implementors when they end their output stream.
 */
FastServer.prototype.requestComplete = function (request)
{
	mod_assertplus.equal(request.fsr_state, FR_S_RUNNING);
	request.fsr_state = FR_S_COMPLETE;
	request.fsr_log.debug('request completed normally');
	this.requestCleanup(request);
};

/*
 * Disconnect this request from the underlying connection, usually because the
 * connection has failed.  We do not have a great way to signal cancellation to
 * the RPC method handler, so we allow the request to complete and ignore any
 * data sent.  This should not be a big deal, since Fast RPC requests are
 * intended to be very bounded in size anyway.
 */
FastServer.prototype.requestDisconnect = function (request)
{
	mod_assertplus.ok(request instanceof FastRpcServerRequest);

	if (request.fsr_state != FR_S_RUNNING) {
		mod_assertplus.equal(request.fsr_state, FR_S_COMPLETE);
		return;
	}

	mod_assertplus.ok(request.fsr_error === null);
	mod_assertplus.ok(request.fsr_blackhole === null);
	request.fsr_log.info('disconnecting request');
	request.fsr_context.unpipe(request.fsr_encoder);
	request.fsr_encoder.unpipe(request.fsr_conn.fc_msgencoder);
	request.fsr_encoder.removeListener('end', request.fsr_docomplete);

	request.fsr_blackhole = new NullSink();
	request.fsr_context.pipe(request.fsr_blackhole);
	request.fsr_blackhole.on('finish', request.fsr_docomplete);
};

/*
 * Common function for completing execution of the given RPC request.
 */
FastServer.prototype.requestCleanup = function (request)
{
	var conn;
	var self = this;
	var diff;
	var latency;
	var labels;

	mod_assertplus.equal(request.fsr_state, FR_S_COMPLETE);
	conn = request.fsr_conn;

	mod_assertplus.ok(conn.fc_pending.hasOwnProperty(request.fsr_msgid));
	mod_assertplus.ok(conn.fc_pending[request.fsr_msgid] == request);
	delete (conn.fc_pending[request.fsr_msgid]);

	conn.fc_ncompleted++;
	this.fs_nrequests_completed++;
	if (this.fs_collector) {
		/* Record metrics */

		/* Calculate milliseconds since the request began. */
		diff = process.hrtime(request.fsr_hrtstarted);
		latency = mod_jsprim.hrtimeMillisec(diff);

		/* Track the requested RPC methoad. */
		labels = { 'rpcMethod': request.fsr_rpcmethod };
		this.fs_request_counter.increment(labels);
		this.fs_latency_histogram.observe(latency, labels);
	}

	if (request.fsr_handler !== null) {
		request.fsr_handler.fh_ncompleted++;

		/*
		 * If we never assigned a handler, then we didn't fire the
		 * rpc-start probe.
		 */
		this.fs_dtp.fire('rpc-done', function () {
			return ([ self.fs_dtid,
			    conn.fc_connid, request.fsr_msgid ]);
		});
	}

	if (request.fsr_error !== null) {
		conn.fc_nfailed++;
		this.fs_nrequests_failed++;
		if (request.fsr_handler !== null) {
			request.fsr_handler.fh_nerrors++;
		}
	}

	if (conn.fc_draining) {
		this.connDrain(conn);
	}
};


/*
 * Helper classes
 *
 * The classes below generally contain no methods of their own except as needed
 * to implement various object-mode streams.
 */

/*
 * Each FastRpcHandler instance represents a registered RPC method.  Besides the
 * user's handler, we keep track of basic stats about this handler's usage.
 * Named arguments include:
 *
 *     rpcmethod	string name of the RPC method
 *
 *     rpchandler	JavaScript function invoked for each outstanding
 *     			request.
 *
 * When RPC requests are received for this method, the function is invoked as:
 *
 *     handler(context);
 *
 * where "context" is an object-mode writable stream to which the RPC method
 * implementor should write plain JavaScript objects that will be received on
 * the client.  The RPC is considered successfully completed when the stream is
 * ended.  If the RPC fails, the caller should _not_ end the stream, but instead
 * invoke context.fail(err) with an error that will be sent to the client.
 * After the RPC completes (either by ending the stream or by invoking fail()),
 * only read-only operations on "context" are allowed.
 */
function FastRpcHandler(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.rpcmethod, 'args.rpcmethod');
	mod_assertplus.func(args.rpchandler, 'args.rpchandler');

	this.fh_rpcmethod = args.rpcmethod;
	this.fh_handler = args.rpchandler;
	this.fh_nstarted = 0;		/* count of started RPC calls */
	this.fh_ncompleted = 0;		/* count of completed RPC calls */
	this.fh_nerrors = 0;		/* count of completed, failed calls */
}


/*
 * Each FastRpcConnection instance represents a connection to an RPC client.
 * See "Connection lifecycle" for details about how this object is used.
 * Named arguments:
 *
 *     connId	unique identifier for this connection
 *
 *     socket	underlying socket for communicating with client
 *
 *     log      bunyan-style logger
 */
function FastRpcConnection(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.ok(args.connId, 'args.connId');
	mod_assertplus.object(args.socket, 'args.socket');
	mod_assertplus.object(args.log, 'args.log');

	this.fc_connid = args.connId;	/* see above */
	this.fc_socket = args.socket;	/* see above */
	this.fc_addrinfo = mod_subr.summarizeSocketAddrs(this.fc_socket);
	this.fc_log = args.log.child({
	    'connId': this.fc_connid,
	    'client': this.fc_addrinfo.label
	});
	this.fc_pending = {};		/* pending requests */
	this.fc_nstarted = 0;		/* count of requests started */
	this.fc_ncompleted = 0;		/* count of requests completed */
	this.fc_nfailed = 0;		/* count of requests failed */
	this.fc_taccepted = null;	/* time when the conn was accepted */
	this.fc_ended = false;		/* end-of-stream has been read */
	this.fc_socket_error = null;	/* conn experienced socket error */
	this.fc_server_error = null;	/* proto error or shutdown */
	this.fc_draining = false;	/* waiting for connection to drain */

	/*
	 * Messages written to fc_msgencoder are encoded and sent to the socket.
	 */
	this.fc_msgencoder = new mod_protocol.FastMessageEncoder();
	this.fc_msgencoder.pipe(this.fc_socket);

	/*
	 * We'll end up piping each request's encoder to this connection-wide
	 * encoder.  As a result, it may have listeners proportional to the
	 * number of outstanding requests.  Disable Node's ill-considered
	 * warning about the maximum number of listeners.
	 */
	this.fc_msgencoder.setMaxListeners(0);

	/*
	 * Messages read from the socket are annotated with this connection id
	 * (using the FastRpcConnectionDecoder transform stream) and then
	 * emitted from fc_ckddecoder.
	 */
	this.fc_rawdecoder = new mod_protocol.FastMessageDecoder();
	this.fc_socket.pipe(this.fc_rawdecoder);
	this.fc_ckddecoder = new FastRpcConnectionDecoder({ 'fastConn': this });
	this.fc_rawdecoder.pipe(this.fc_ckddecoder);
}


/*
 * This object-mode Transform stream annotates Fast protocol messages with the
 * connection on which they were received.
 */
function FastRpcConnectionDecoder(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.fastConn, 'args.fastConn');

	this.fcd_conn = args.fastConn;
	mod_stream.Transform.call(this, {
	    'objectMode': true,
	    'highWaterMark': 1
	});
}

mod_util.inherits(FastRpcConnectionDecoder, mod_stream.Transform);

FastRpcConnectionDecoder.prototype._transform = function (msg, _, callback)
{
	mod_assertplus.object(msg);
	mod_assertplus.number(msg.msgid);
	mod_assertplus.ok(!msg.hasOwnProperty('connId'));
	msg.connId = this.fcd_conn.fc_connid;
	this.push(msg);
	setImmediate(callback);
};


/*
 * The FastMessageHandler is just a transform stream that takes incoming Fast
 * protocol messages and dispatches them to the FastServer for which this
 * handler was created.  Today, this class does not do any real flow control or
 * concurrency management.  However, by phrasing this as an object-mode Writable
 * stream, this is where we could implement flow control without having to
 * modify much else.
 */
function FastMessageHandler(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.server, 'args.server');

	this.fmh_server = args.server;

	mod_stream.Writable.call(this, {
	    'objectMode': true,
	    'highWaterMark': 0
	});
}

mod_util.inherits(FastMessageHandler, mod_stream.Writable);

FastMessageHandler.prototype._write = function (obj, _, callback)
{
	this.fmh_server.onMessage(obj);
	setImmediate(callback);
};


/*
 * A FastRpcServerRequest represents an RPC request received on the server from
 * a client.  See "Request lifecycle" above for details.  Named arguments:
 *
 *     fastMessage (object) incoming Fast protocol message that began this RPC
 *
 *     fastConn    (object) connection on which this request was received
 *
 *     server      (object) handle to the containing Fast server
 *
 *     log         (object) bunyan-style logger
 */
function FastRpcServerRequest(args)
{
	var request = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.fastMessage, 'args.fastMessage');
	mod_assertplus.object(args.server, 'args.server');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.object(args.fastConn, 'args.fastConn');

	/*
	 * This should already have been validated by the Fast parser.  However,
	 * the contents of the message's "data" field have not yet been
	 * validated.
	 */
	mod_assertplus.number(args.fastMessage.msgid, 'args.fastMessage.msgid');

	this.fsr_message = args.fastMessage;
	this.fsr_msgid = args.fastMessage.msgid;
	this.fsr_server = args.server;
	this.fsr_conn = args.fastConn;
	this.fsr_log = args.log;

	this.fsr_rpcmethod = null;	/* filled in after validation */
	this.fsr_rpcargs = null;	/* filled in after validation */
	this.fsr_handler = null;	/* filled in after validation */
	this.fsr_tstarted = null;	/* time the request started */
	this.fsr_hrtstarted = null;	/* granular time the request started */
	this.fsr_state = FR_S_INIT;	/* see state machine above */
	this.fsr_encoder = new FastRpcResponseEncoder({ 'request': this });
	this.fsr_docomplete = null;	/* callback for completion */
	this.fsr_error = null;		/* error, if any */
	this.fsr_blackhole = null;	/* see requestDisconnect() */

	/*
	 * The "context" is a handle by which implementors of RPC methods can
	 * inspect the request and send response data.  Per well-established
	 * design patterns, we provide a functional interface to this
	 * information so that we can add additional information in the future
	 * by just adding new methods to the context object.
	 *
	 * We could just use this object, rather than constructing a new object
	 * specifically for this purpose.  Indeed, this author is not generally
	 * a proponent of the following pattern for data hiding, as it disrupts
	 * debuggability.  Sadly, past experience has shown that some
	 * implementations cannot resist the temptation to peek and poke at
	 * private fields.  Given how crisp this interface boundary is, we deem
	 * it worthwhile to eliminate the possibility of malfeasance.
	 */
	this.fsr_context = new mod_stream.PassThrough({
	    'objectMode': true,
	    'highWaterMark': 1
	});
	this.fsr_context.connectionId = function ctxConnectionId() {
		return (request.fsr_conn.fc_connid);
	};
	this.fsr_context.requestId = function ctxRequestId() {
		return (request.fsr_msgid);
	};
	this.fsr_context.methodName = function ctxMethodName() {
		return (request.fsr_rpcmethod);
	};
	this.fsr_context.argv = function ctxArgv() {
		/*
		 * For clarity and debuggability, callers ought to avoid mucking
		 * with the arguments that they're given.  Normally, we'd copy
		 * them here to eliminate this as a possibility.  But the cost
		 * of a deep copy is a relatively high percentage of the on-CPU
		 * time for many RPC calls.  Plus, it's unlikely that
		 * modifications to these arguments would affect code other than
		 * the caller.
		 */
		return (request.fsr_rpcargs.slice());
	};
	this.fsr_context.fail = function ctxFail(err) {
		return (request.fsr_server.requestFail(request, err));
	};

	this.fsr_context.pipe(this.fsr_encoder);
}


function FastRpcResponseEncoder(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.request, 'args.request');

	mod_stream.Transform.call(this, {
	    'objectMode': true,
	    'highWaterMark': 1
	});
	this.fse_request = args.request;
	this.fse_ndropped = 0;
}

mod_util.inherits(FastRpcResponseEncoder, mod_stream.Transform);

FastRpcResponseEncoder.prototype._transform = function (obj, _, callback)
{
	if (this.fse_request.fsr_state != FR_S_RUNNING) {
		/*
		 * The RPC handler should not be writing data after calling
		 * fail() (and completing the request).  However, there's some
		 * asynchrony between when they write data and when it reaches
		 * our transform, so this isn't necessarily invalid.
		 */
		this.fse_ndropped++;
		setImmediate(callback);
		return;
	}

	mod_assertplus.ok(typeof (obj) == 'object' && obj !== null,
	    'can only send non-null objects');
	this.push(requestMakeMessage(this.fse_request,
	    mod_protocol.FP_STATUS_DATA, [ obj ]));
	setImmediate(callback);
};

FastRpcResponseEncoder.prototype._flush = function (callback)
{
	if (this.fse_request.fsr_state == FR_S_RUNNING) {
		this.push(requestMakeMessage(this.fse_request,
		    mod_protocol.FP_STATUS_END, null));
	}

	setImmediate(callback);
};

/*
 * Construct a Fast RPC message that's part of a response for the given request.
 */
function requestMakeMessage(request, status, data)
{
	var datum;

	mod_assertplus.ok(request instanceof FastRpcServerRequest);
	if (status == mod_protocol.FP_STATUS_ERROR) {
		mod_assertplus.ok(data instanceof Error);

		/*
		 * The marshaling of Errors is a little sketchy, owing partly to
		 * the history of Fast and partly to the sketchy definition of
		 * Errors in JavaScript.  The goal is to allow the client
		 * program to reconstitute an Error object that looks like the
		 * one we have here.
		 *
		 * We need to provide at least "name" and "message" to make it
		 * look like a JavaScript Error.  As a departure from the
		 * previous implementation, we do not provide the "stack" field.
		 * It's way too confusing for the client to wind up with an
		 * Error whose stacktrace is from a different program on a
		 * different system.  (The filenames and line numbers in the
		 * stack trace may not even exist on the client system, and
		 * they certainly may not refer to the same files and line
		 * numbers even if they do exist.)
		 *
		 * We provide "info" as VError.info() because this is the modern
		 * way to provide information properties on Errors.
		 *
		 * We provide "context" and "ase_errors" because the old Fast
		 * implementation did so.  "context" is how old Fast servers
		 * would specify error metadata (before VError.info() existed).
		 * "ase_errors" is a private implementation property of
		 * MultiError, and we never should have exposed it, but things
		 * potentially do depend on it.
		 */
		datum = {
		    'name': data.name,
		    'message': data.message,
		    'context': data.context || {},
		    'info': VError.info(data),
		    'ase_errors': data.ase_errors
		};
	} else if (status == mod_protocol.FP_STATUS_END) {
		mod_assertplus.ok(data === null);
		datum = [];
	} else {
		mod_assertplus.equal(status, mod_protocol.FP_STATUS_DATA);
		mod_assertplus.ok(Array.isArray(data));
		datum = data;
	}

	return ({
	    'msgid': request.fsr_msgid,
	    'status': status,
	    'data': {
		'm': {
		    'uts': mod_microtime.now(),
		    'name': request.fsr_rpcmethod
		},
		'd': datum
	    }
	});
}


/*
 * Object-mode data sink that drops all data.
 */
function NullSink()
{
	this.ns_nwritten = 0;
	mod_stream.Writable.call(this, {
	    'objectMode': true,
	    'highWaterMark': 1
	});
}

mod_util.inherits(NullSink, mod_stream.Writable);

NullSink.prototype._write = function (_1, _2, callback)
{
	this.ns_nwritten++;
	setImmediate(callback);
};


/*
 * Initialize the DTrace provider for the Fast server.
 */
function fastServerProviderInit()
{
	var dtp;

	dtp = mod_dtrace.createDTraceProvider('fastserver');

	/*
	 * conn-create: connection was created
	 *
	 *     arg0    int     unique identifier for this server in this process
	 *     arg1    int     unique identifier for this client in this server
	 *     arg2    string  human-readable label for this client (usually
	 *                     a summary of the TCP connection)
	 */
	dtp.addProbe('conn-create', 'int', 'int', 'char *');

	/*
	 * conn-destroy: connection was destroyed
	 *
	 *     arg0    int     see conn-create arg0.
	 *     arg1    int     see conn-create arg1.
	 */
	dtp.addProbe('conn-destroy', 'int', 'int');

	/*
	 * rpc-start: server starts handling RPC request
	 *
	 *     arg0    int     see conn-create arg0.
	 *     arg1    int     see conn-create arg1.
	 *     arg2    int     unique identifier for this request in this client
	 *     arg3    string  RPC method name
	 */
	dtp.addProbe('rpc-start', 'int', 'int', 'int', 'char *');

	/*
	 * rpc-done: server finishes handling RPC request
	 *
	 *     arg0    int     see conn-create arg0.
	 *     arg1    int     see conn-create arg1.
	 *     arg2    int     unique identifier for this request in this
	 *		       process
	 */
	dtp.addProbe('rpc-done', 'int', 'int', 'int');
	dtp.enable();
	return (dtp);
}
