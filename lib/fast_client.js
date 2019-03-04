/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * lib/fast_client.js: public node-fast client interface
 */

var mod_assertplus = require('assert-plus');
var mod_dtrace = require('dtrace-provider');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_microtime = require('microtime');
var mod_util = require('util');
var VError = require('verror');

var mod_protocol = require('./fast_protocol');
var mod_client_request = require('./fast_client_request');
var mod_subr = require('./subr');

exports.FastClient = FastClient;

/*
 * Generated via artedi.logLinearBuckets(10, -4, 1, 5). Chosen only because it
 * covers the range of observed requests.
 */
var DEFAULT_BUCKETS = [
	0.0002, 0.0004, 0.0006, 0.0008, 0.001,
	0.002, 0.004, 0.006, 0.008, 0.01,
	0.02, 0.04, 0.06, 0.08, 0.1,
	0.2, 0.4, 0.6, 0.8, 1,
	2, 4, 6, 8, 10,
	20, 40, 60, 80, 100
];

/*
 * There's one DTrace provider for all clients using this copy of this module.
 */
var fastClientProvider = null;

/*
 * We have one counter for the number of clients in the process.  Note that this
 * is a true JavaScript global, so that different copies of this module
 * (presumably at different versions) will still end up with unique client ids.
 */
/* jsl:declare fastNclients */
fastNclients = 0;


/*
 * A FastClient is an object used to make RPC requests to a remote Fast server.
 * This client does not manage the connection to the remote server.  That's the
 * responsibility of the caller.
 *
 * Named arguments:
 *
 *     collector	artedi-style metric collector
 *
 *     log		bunyan-style logger
 *
 *     nRecentRequests	count of recent requests to keep track of (for
 *     			debugging)
 *
 *     transport	usually a socket connected to the remote server, but
 *     			this could be any data-mode duplex stream.  This client
 *     			will write messages to the transport and parse responses
 *     			from the transport.  This client listens for 'error'
 *     			events and end-of-stream only so that it can report
 *     			request failures.  The caller is also expected to listen
 *     			for these errors and handle reconnection appropriately.
 *
 *     crc_mode		CRC mode. Used to transition off buggy node-crc version.
 *             		For details see joyent/node-fast#23.
 *
 * On 'error', the caller should assume that the current connection to the
 * server is in an undefined state and should not be used any more.  Any
 * in-flight RPC will be terminated gracefully (i.e., with an "error" or "end"
 * event).
 */
function FastClient(args)
{
	var self = this;
	var fixed_buckets = false;

	mod_assertplus.object(args, 'args');
	mod_assertplus.optionalObject(args.collector, 'args.collector');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.number(args.nRecentRequests, 'args.nRecentRequests');
	mod_assertplus.object(args.transport, 'args.transport');
	mod_assertplus.optionalNumber(args.crc_mode, 'args.crc_mode');

	this.fc_collector = args.collector;	/* metric collector */
	this.fc_log = args.log;
	this.fc_transport = args.transport;
	this.fc_nrecent = args.nRecentRequests;
	/* supported crc mode for joyent/node-fast#23 */
	this.fast_crc_mode = args.crc_mode || mod_protocol.FAST_CHECKSUM_V1;

	/* RPC and protocol state */
	this.fc_pending = {}; 		/* pending requests */
	this.fc_abandoned = {};		/* abandoned, outstanding requests */
	this.fc_nrpc_started = 0;	/* requests issued */
	this.fc_nrpc_done = 0;		/* requests completed */
	this.fc_recentrpc = [];		/* recently completed requests */
	this.fc_error = null;		/* first fatal error, if any */
	this.fc_nerrors = 0;		/* count of fatal errors */
	this.fc_rqidalloc = new mod_subr.IdAllocator({
	    'min': 1,
	    'max': mod_protocol.FP_MSGID_MAX,
	    'isAllocated': function isReqIdAllocated(id) {
		return (self.fc_pending.hasOwnProperty(id) ||
		    self.fc_abandoned.hasOwnProperty(id));
	    }
	});

	/* transport and message helper objects */
	this.fc_transport_onerr = null;	/* error listener */
	this.fc_msgencoder = new mod_protocol.FastMessageEncoder();
	this.fc_msgdecoder =
	    new mod_protocol.FastMessageDecoder(this.fast_crc_mode);

	/* transport state */
	this.fc_detached = false;	 /* caller detached us */
	this.fc_transport_ended = false; /* transport detached us */

	if (this.fc_collector) {
		if (this.fc_collector.FIXED_BUCKETS === true) {
			fixed_buckets = true;
		}
		this.fc_request_counter = this.fc_collector.counter({
			name: 'fast_client_requests_completed',
			help: 'count of fast client requests completed'
		});
		this.fc_latency_histogram = this.fc_collector.histogram({
			name: 'fast_client_request_time_seconds',
			help: 'end-to-end fast client request duration',
			buckets: (fixed_buckets === true) ?
			    DEFAULT_BUCKETS : undefined,
			labels: (fixed_buckets === true) ?
			    { buckets_version: '1' } : undefined
		});
	}

	if (fastClientProvider === null) {
		fastClientProvider = fastClientProviderInit();
	}

	mod_assertplus.object(fastClientProvider);
	this.fc_dtid = ++fastNclients;
	this.fc_dtp = fastClientProvider;

	mod_events.EventEmitter.call(this);
	this.attach();
}

mod_util.inherits(FastClient, mod_events.EventEmitter);

/*
 * [public] Initiate an RPC request.  Named parameters include:
 *
 *     rpcmethod	(string)	name of the RPC method to invoke
 *
 *     rpcargs		(object)	values of arguments passed to the RPC
 *
 *     timeout (optional number)	milliseconds after which to abandon the
 *     					request if no response has been received
 *
 *     log        (optional log)	bunyan-style logger
 *
 *     ignoreNullValues			allow null values to be received from
 *     (optional boolean)		the server and drop them.  This is used
 *     					for legacy servers that incorrectly sent
 *     					null values.  If this is not specified
 *     					and a null value is received, this is
 *     					treated as a protocol error.
 *
 * The semantics of "rpcmethod" and "rpcargs" are defined by the server.
 *
 * If "log" is not provided, then this request uses a child of the client-level
 * logger.
 *
 * The return value is an object-mode readable stream that emits zero or more
 * messages from the server.  As with other readable streams, "end" denotes
 * successful completion, and "error" denotes unsuccessful completion.  This
 * stream does not support flow control, so the server must be trusted, and the
 * caller must avoid making requests that return large amounts of data faster
 * than the caller can process it.  Additionally, the stream is already reading
 * when the caller gets it, so there's no need to call read(0) to kick off the
 * RPC.
 *
 * See rpcBufferAndCallback() for an interface that buffers incoming data and
 * invokes a callback upon completion.
 */
FastClient.prototype.rpc = function (args)
{
	var msgid, log, request, message;
	var timeoutms = null;
	var self = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.rpcmethod, 'method.rpcmethod');
	mod_assertplus.array(args.rpcargs, 'args.rpcargs');
	mod_assertplus.optionalNumber(args.timeout, 'args.timeout');
	mod_assertplus.optionalObject(args.log, 'args.log');
	mod_assertplus.optionalBool(args.ignoreNullValues,
	    'args.ignoreNullValues');

	if (typeof (args.timeout) == 'number') {
		mod_assertplus.ok(args.timeout > 0, 'args.timeout > 0');
		timeoutms = args.timeout;
	}

	msgid = this.allocMessageId();
	mod_assertplus.ok(!this.fc_pending.hasOwnProperty(msgid));
	log = args.log ? args.log : this.fc_log;
	request = new mod_client_request.FastClientRequest({
	    'client': this,
	    'msgid': msgid,
	    'rpcmethod': args.rpcmethod,
	    'rpcargs': args.rpcargs,
	    'ignoreNullValues': args.ignoreNullValues || false,
	    'log': log.child({
		'component': 'FastClientRequest',
		'msgid': msgid,
		'rpcmethod': args.rpcmethod
	    })
	});

	this.fc_pending[msgid] = request;
	this.fc_nrpc_started++;
	request.frq_hrtstarted = process.hrtime();

	if (this.fc_error !== null || this.fc_detached ||
	    this.fc_transport_ended) {
		this.fc_log.debug('skipping new request (transport detached)');
		request.frq_skip = true;
		this.requestFail(request, new VError({
		    'name': 'FastTransportError'
		}, 'transport detached'));
		return (request);
	}

	message = {
	    'msgid': msgid,
	    'status': mod_protocol.FP_STATUS_DATA,
	    'data': {
		'm': {
		    'uts': mod_microtime.now(),
		    'name': args.rpcmethod
		},
		'd': args.rpcargs
	    },
	    'crc_mode': this.fast_crc_mode
	};

	request.frq_log.debug({
	    'rpcargs': args.rpcargs,
	    'timeoutms': timeoutms
	}, 'rpc %s: entered', args.rpcmethod);

	this.fc_dtp.fire('rpc-start', function () {
	    return ([
		self.fc_dtid,
		request.frq_msgid,
		args.rpcmethod,
		{
		    'rpcargs': args.rpcargs,
		    'timeout': timeoutms
		}
	    ]);
	});

	this.fc_log.trace(message, 'outgoing message');
	this.fc_msgencoder.write(message);

	if (timeoutms !== null) {
		request.frq_timeout = setTimeout(function onRpcTimeout() {
			self.requestAbandon(request, new VError({
			    'name': 'TimeoutError',
			    'info': {
				'timeout': timeoutms
			    }
			}, 'timed out after %d milliseconds', timeoutms));
		}, timeoutms);
	}

	return (request);
};

/*
 * Make an RPC request just like rpc(), but buffer incoming data messages until
 * the request is complete and invoke "callback" as callback(err, data, ndata)
 * when the request is complete.  In the callback:
 *
 *     "err" is the error, if any
 *
 *     "data" is an array of data objects returned with the RPC
 *     (up to "maxObjectsToBuffer" objects)
 *
 *     "ndata" is a non-negative integer describing how many data objects were
 *     received.  If "ndata" is larger than "data.length", then messages were
 *     dropped because maxObjectsToBuffer was too small.
 *
 * Note that "data" will always be an array and may contain messages even if
 * "err" is present.  Similarly, "ndata" will always be a non-negative integer.
 *
 * This function takes all of the named arguments that rpc() takes, plus the
 * following required argument:
 *
 *     maxObjectsToBuffer	the maximum number of data messages to buffer.
 *     				This allows callers to use this interface to
 *     				make an RPC call that they expect may only
 *     				produce a small number of data messages and know
 *     				that a bounded amount of memory will be used,
 *     				even if the server returns more than the
 *     				expected number of messages.
 */
FastClient.prototype.rpcBufferAndCallback = function (args, callback)
{
	var maxbuffer, request, data, ndata, done;

	mod_assertplus.object(args, 'args');
	mod_assertplus.func(callback, 'callback');
	mod_assertplus.number(args.maxObjectsToBuffer,
	    'args.maxObjectsToBuffer');
	maxbuffer = args.maxObjectsToBuffer;
	mod_assertplus.ok(maxbuffer >= 0);

	data = [];
	ndata = 0;
	done = false;
	request = this.rpc(args);
	request.on('data', function (c) {
		mod_assertplus.ok(!done);
		ndata++;
		if (data.length < maxbuffer) {
			data.push(c);
		}
	});

	request.on('error', function (err) {
		mod_assertplus.ok(!done);
		done = true;
		mod_assertplus.ok(data.length <= ndata);
		mod_assertplus.ok(data.length <= maxbuffer);
		callback(err, data, ndata);
	});

	request.on('end', function () {
		mod_assertplus.ok(!done);
		done = true;
		mod_assertplus.ok(data.length <= ndata);
		mod_assertplus.ok(data.length <= maxbuffer);
		callback(null, data, ndata);
	});

	return (request);
};

/*
 * Disconnect entirely from the underlying transport.  Do not read from it or
 * write to it and remove any event handlers.
 */
FastClient.prototype.detach = function ()
{
	if (this.fc_detached) {
		return;
	}

	this.fc_detached = true;
	this.fc_transport.removeListener('error', this.fc_transport_onerr);
	this.fc_transport.unpipe(this.fc_msgdecoder);
	this.fc_msgencoder.unpipe(this.fc_transport);

	this.requestAbandonAll(new VError({
	    'name': 'FastTransportError'
	}, 'client detached from transport'));
};

/*
 * Public methods for exposing debugging data over kang.
 *
 * Over kang, we expose objects of types:
 *
 *     fastclient	  describes a single FastClient, including basic
 *			  activity stats, any fatal error, and so on.
 *
 *     fastrequest	  describes a request that's currently outstanding,
 *			  including which connection received it, how long it's
 *			  been running, and what state it's in
 *
 * We do not provide a kang entry point for stats because we expect that there
 * will be many FastClients in most kang components and they will aggregate up
 * statistics from individual "fastclient" objects as desired.
 */
FastClient.prototype.kangListTypes = function ()
{
	return ([ 'fastclient', 'fastrequest' ]);
};

FastClient.prototype.kangListObjects = function (type)
{
	if (type == 'fastclient') {
		return ([ this.fc_dtid ]);
	}

	mod_assertplus.equal(type, 'fastrequest');
	return (Object.keys(this.fc_pending).concat(
	    Object.keys(this.fc_abandoned)));
};

FastClient.prototype.kangGetObject = function (type, id)
{
	var rv, req;

	if (type == 'fastclient') {
		mod_assertplus.equal(id, this.fc_dtid);
		rv = {
		    'id': id,
		    'nRpcStarted': this.fc_nrpc_started,
		    'nRpcDone': this.fc_nrpc_done,
		    'nErrors': this.fc_nerrors,
		    'error': this.fc_error,
		    'detached': this.fc_detached,
		    'transportEnded': this.fc_transport_ended
		};
		return (rv);
	}

	mod_assertplus.equal(type, 'fastrequest');
	rv = {};
	rv['clientId'] = this.fc_dtid;
	rv['msgid'] = id;

	if (this.fc_pending.hasOwnProperty(id)) {
		req = this.fc_pending[id];
	} else {
		req = this.fc_abandoned[id];
	}

	rv['skipped'] = req.frq_skip;
	rv['rpcmethod'] = req.frq_rpcmethod;
	rv['nDataEmitted'] = req.frq_ndata;
	rv['nMessagesIgnored'] = req.frq_nignored;
	rv['error'] = req.frq_error;
	rv['abandoned'] = req.frq_abandoned;
	rv['doneGraceful'] = req.frq_done_graceful;
	rv['hasTimeout'] = req.frq_timeout !== null;
	return (rv);
};

/*
 * private methods
 */

FastClient.prototype.attach = function ()
{
	var self = this;

	this.fc_transport.pipe(this.fc_msgdecoder);
	this.fc_msgencoder.pipe(this.fc_transport, { 'end': false });

	/*
	 * It's non-idiomatic to use the "data" event because it defeats flow
	 * control.  However, this abstraction cannot support flow control
	 * anyway, but clients can already deal with this by limiting the size
	 * of responses.  Since we know our message decoder is an object-mode
	 * stream, we may as well just read objects with this handler.
	 */
	this.fc_msgdecoder.on('data',
	    function onDecoderMessage(message) { self.onMessage(message); });
	this.fc_msgdecoder.on('error',
	    function onDecoderError(err) { self.fatalError(err); });

	/*
	 * By the nature of this abstraction, we don't own the transport.  But
	 * we still want to know when it either emits "end" or "error" so that
	 * we can know that any outstanding requests will not be completed.
	 * Some modules use "close" for this, but transports are not required to
	 * emit that event.  They should emit one of these two.  We listen for
	 * "end" on the message decoder rather than the transport to deal with
	 * the fact that there may be queueing of data in between them.
	 */
	this.fc_msgdecoder.on('end', function onTransportEnd() {
		var err;

		self.fc_transport_ended = true;

		/*
		 * There's no problem with seeing end-of-stream as long as we
		 * have no requests pending and are not asked to make any more
		 * requests.  Remember, the caller is separately responsible for
		 * detecting this case for the purpose of reconnection, if
		 * desired.
		 */
		if (self.fc_nrpc_started > self.fc_nrpc_done) {
			err = new VError({
			    'name': 'FastProtocolError'
			}, 'unexpected end of transport stream');
			self.fatalError(err);
		}
	});

	this.fc_transport_onerr = function onTransportError(err) {
		self.fatalError(new VError({
		    'name': 'FastTransportError',
		    'cause': err
		}, 'unexpected error on transport'));
	};

	this.fc_transport.on('error', this.fc_transport_onerr);
};

/*
 * Return the next message id.
 */
FastClient.prototype.allocMessageId = function ()
{
	return (this.fc_rqidalloc.alloc());
};

/*
 * Record an error that's fatal to this client.  We emit the first one and
 * abandon all outstanding requests.  If we see more than one, we simply log and
 * count subsequent ones.
 */
FastClient.prototype.fatalError = function (err)
{
	this.fc_log.warn(err);
	this.fc_nerrors++;

	if (this.fc_error !== null) {
		return;
	}

	this.fc_error = err;
	this.emit('error', err);
	this.requestAbandonAll(err);
};

/*
 * Abandon all pending requests, as with requestAbandon(request, error).
 */
FastClient.prototype.requestAbandonAll = function (error)
{
	var msgid;

	for (msgid in this.fc_pending) {
		mod_assertplus.ok(
		    this.requestIsPending(this.fc_pending[msgid]));
		this.requestAbandon(this.fc_pending[msgid], error);
		mod_assertplus.ok(!this.fc_pending.hasOwnProperty(msgid));
	}
};

/*
 * Abandon the given request with an error indicating the request was abandoned.
 * If "error" is provided, then the given error will be provided as the cause of
 * the abandon error.  If the request has already completed in any way
 * (including having been previously abandoned), this will do nothing.
 */
FastClient.prototype.requestAbandon = function (request, error)
{
	var msgid;

	if (!this.requestIsPending(request)) {
		return;
	}

	mod_assertplus.object(error, 'error');

	msgid = request.frq_msgid;
	mod_assertplus.ok(this.fc_pending[msgid] == request);
	request.frq_abandoned = true;

	/*
	 * The history of cancellation in node-fast is somewhat complicated.
	 * Early versions did not support cancellation of in-flight requests.
	 * Cancellation was added, but old servers would interpret the
	 * cancellation message as a new request for the same RPC, which is
	 * extremely dangerous.  (Usually, the arguments would be invalid, but
	 * that's only the best-case outcome.)  We could try to avoid this by
	 * avoiding specifying the RPC method name in the cancellation request.
	 * Since the protocol was never well-documented, the correctness of this
	 * approach is mainly determined by what other servers do with it.
	 * Unfortunately, old servers are likely to handle it as an RPC method
	 * of some kind, which triggers an unrelated bug: if old servers
	 * received a request for a method that's not registered, they just
	 * hang on it, resulting in a resource leak.
	 *
	 * Things are a little better on more modern versions of the fast
	 * server, where if you send a cancellation request and the RPC is not
	 * yet complete when the server processes it, then the server may stop
	 * processing the RPC and send back an acknowledgment of sorts.
	 * However, that doesn't mean the request did not complete, since the
	 * implementation may not have responded to the cancellation.  And more
	 * seriously, if the RPC isn't running, the server won't send back
	 * anything, so we don't know whether we need to expect something or
	 * not.
	 *
	 * To summarize: if we were to send a cancellation request, we would not
	 * know whether to expect a response, and it's possible that we would
	 * inadvertently invoke the same RPC again (which could be very
	 * destructive) or leak resources in the remote server.  For now, we
	 * punt and declare that request abandonment is purely a client-side
	 * convenience that directs the client to stop doing anything with
	 * messages for this request.  We won't actually ask the server to stop
	 * doing anything.
	 */
	this.fc_abandoned[request.frq_msgid] = request;
	this.requestFail(request, error);
};

/*
 * Mark the given request as completed with the specified error.
 */
FastClient.prototype.requestFail = function (request, error)
{
	mod_assertplus.ok(request.frq_error === null);
	mod_assertplus.object(error);

	request.frq_error = new VError({
	    'name': 'FastRequestError',
	    'cause': error,
	    'info': {
		'rpcMsgid': request.frq_msgid,
		'rpcMethod': request.frq_rpcmethod
	    }
	}, 'request failed');

	this.requestComplete(request);

	/*
	 * We may be called in the context of a user action (e.g., if they
	 * issued a request while the transport was disconnected, or if they're
	 * abandoning a request).  Defer the 'error' event so they don't have to
	 * deal with it being emitted synchronously during the execution of that
	 * action.
	 */
	setImmediate(function () {
		request.emit('error', request.frq_error);
	});
};

/*
 * Mark the given request as completed.
 */
FastClient.prototype.requestComplete = function (request)
{
	var diff;
	var labels;
	var latency;
	var msgid;
	var self = this;

	if (request.frq_timeout !== null) {
		clearTimeout(request.frq_timeout);
		request.frq_timeout = null;
	}

	this.fc_dtp.fire('rpc-done', function () {
		var result, err;

		result = {};
		if (request.frq_error !== null) {
			err = VError.cause(request.frq_error);
			result['error'] = {
			    'name': err ? err.name : '?',
			    'message': err ? err.message : '?'
			};
		}

		return ([
		    self.fc_dtid,
		    request.frq_msgid,
		    result
		]);
	});

	if (request.frq_error !== null) {
		request.frq_log.debug(request.frq_error, 'rpc %s: failed',
		    request.frq_rpcmethod);
	} else {
		request.frq_log.debug('rpc %s: done', request.frq_rpcmethod);
	}

	msgid = request.frq_msgid;
	mod_assertplus.ok(!this.requestIsPending(request));
	mod_assertplus.ok(this.fc_pending[msgid] == request);
	delete (this.fc_pending[msgid]);
	this.fc_nrpc_done++;

	if (this.fc_collector) {
		/* Record metrics */

		/* Calculate milliseconds since the request began. */
		diff = process.hrtime(request.frq_hrtstarted);
		latency = mod_jsprim.hrtimeMillisec(diff);

		/* Track the requested RPC methoad. */
		labels = { 'rpcMethod': request.frq_rpcmethod };
		this.fc_request_counter.increment(labels);
		this.fc_latency_histogram.observe((latency / 1000), labels);
	}

	this.fc_recentrpc.push(request);
	if (this.fc_recentrpc.length > this.fc_nrecent) {
		this.fc_recentrpc.shift();
	}
};

FastClient.prototype.onMessage = function (message)
{
	var request, abandoned, cause;

	this.fc_log.trace(message, 'incoming message');

	mod_assertplus.number(message.msgid,
	    'decoder provided message with no msgid');
	if (this.fc_pending.hasOwnProperty(message.msgid)) {
		request = this.fc_pending[message.msgid];
		mod_assertplus.ok(!request.frq_abandoned);
		abandoned = false;
	} else if (this.fc_abandoned.hasOwnProperty(message.msgid)) {
		request = this.fc_abandoned[message.msgid];
		mod_assertplus.ok(request.frq_abandoned);
		abandoned = true;
	} else {
		this.fatalError(new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'unknown_msgid',
			'fastMsgid': message.msgid
		    }
		}, 'fast protocol: received message with unknown msgid %d',
		    message.msgid));
		return;
	}

	mod_assertplus.ok(!request.frq_done_graceful);
	request.frq_last = message;

	/*
	 * "end" messages are always meaningful because they allow us to clean
	 * up both normal and abandoned requests.
	 */
	if (message.status == mod_protocol.FP_STATUS_END) {
		if (abandoned) {
			request.frq_log.debug('cleaning up abandoned request');
			delete (this.fc_abandoned[request.frq_msgid]);
		} else {
			/*
			 * Although seldom used, it's technically allowed for
			 * END messages to contain data.
			 */
			if (this.requestEmitData(request, message)) {
				request.frq_done_graceful = true;
				this.requestComplete(request);
				request.end();
			}
		}

		return;
	}

	/*
	 * If the request was abandoned, then ignore all other messages.
	 */
	if (abandoned) {
		request.frq_log.trace(
		    'ignoring incoming message (request abandoned)');
		request.frq_nignored++;
		return;
	}

	/*
	 * The only reasons we can have an error are because we never sent the
	 * request out at all (which can never result in us getting here), we
	 * abandoned the request (which we handled above), or the server already
	 * sent us an error (in which case we also shouldn't be able to get
	 * here).
	 */
	mod_assertplus.ok(request.frq_error === null);

	if (message.status == mod_protocol.FP_STATUS_DATA) {
		request.frq_ndata++;
		this.requestEmitData(request, message);
		return;
	}

	mod_assertplus.equal(message.status, mod_protocol.FP_STATUS_ERROR,
	    'decoder emitted message with invalid status');
	cause = new VError({
	    'name': message.data.d.name,
	    'info': message.data.d.info
	}, '%s', message.data.d.message);
	if (message.data.d.stack) {
		cause.stack = message.data.d.stack;
	}

	/*
	 * "context" and "ase_errors" are reconstituted for historical reasons.
	 * There's a similar note in lib/fast_server.js.
	 */
	cause.context = message.data.d.context;
	cause.ase_errors = message.data.d.ase_errors;

	request.frq_done_graceful = true;
	this.requestFail(request, new VError({
	    'name': 'FastServerError',
	    'cause': cause
	}, 'server error'));
};

/*
 * Emits data contained in "message".  Returns true if there was no problem
 * processing this data.  If there was an issue, then the request will be
 * abandoned.
 */
FastClient.prototype.requestEmitData = function (request, message)
{
	var i, d;
	var self = this;

	mod_assertplus.ok(this.requestIsPending(request));

	for (i = 0; i < message.data.d.length; i++) {
		d = message.data.d[i];
		if (d === null) {
			if (request.frq_ignorenull) {
				request.frq_nignored_null++;
				continue;
			}

			this.requestAbandon(request, new VError({
			    'name': 'FastProtocolError',
			    'info': {
				'rpcMsgid': request.frq_msgid,
				'rpcMethod': request.frq_rpcmethod,
			        'rpcMessage': message
			    }
			}, 'server sent "null" value'));
			return (false);
		} else {
			this.fc_dtp.fire('rpc-data', function () {
			    return ([
				self.fc_dtid,
				request.frq_msgid,
				d
			    ]);
			});

			request.push(d);
		}
	}

	return (true);
};

FastClient.prototype.requestIsPending = function (request)
{
	mod_assertplus.object(request, 'request');
	mod_assertplus.ok(request instanceof
	    mod_client_request.FastClientRequest,
	    'request is not a FastClientRequest');
	return (!request.frq_done_graceful && request.frq_error === null);
};


/*
 * Initialize the DTrace provider for the Fast client.
 */
function fastClientProviderInit()
{
	var dtp;

	dtp = mod_dtrace.createDTraceProvider('fastclient');

	/*
	 * The rpc-start probe provides arguments:
	 *
	 *     arg0   int	Unique identifier for this client in this
	 *     			process.
	 *     arg1   int       Message identifier (request identifier).
	 *     			This is only unique among active requests for a
	 *     			single client.  See arg2 for a unique
	 *     			identifier.
	 *     arg2   string    RPC method name
	 *     arg3   string    JSON object with properties for "rpcargs" and
	 *     			"timeout" (optionally).  Additional properties
	 *     			may be added here in the future.
	 */
	dtp.addProbe('rpc-start', 'int', 'int', 'char *', 'json');

	/*
	 * The rpc-data probe provides arguments:
	 *
	 *     arg0   int       Same as for rpc-start.
	 *     arg1   int       Same as for rpc-start.
	 *     arg2   string    JSON object describing received data.
	 */
	dtp.addProbe('rpc-data', 'int', 'int', 'json');

	/*
	 * The rpc-done probe provides arguments:
	 *
	 *     arg0   int       Same as for rpc-start.
	 *     arg1   int       Same as for rpc-start.
	 *     arg2   string    JSON object with properties for "error".
	 *     			Additional properties may be added here in the
	 *     			future.
	 */
	dtp.addProbe('rpc-done', 'int', 'int', 'json');
	dtp.enable();

	return (dtp);
}
