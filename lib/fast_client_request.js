/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * lib/fast_client_request.js: represents a single RPC request from a fast
 * client.  This object is the caller's handle on an individual request.
 */

var mod_assertplus = require('assert-plus');
var mod_stream = require('stream');
var mod_util = require('util');
var VError = require('verror');

var mod_protocol = require('./fast_protocol');

/* Exported interface */
exports.FastClientRequest = FastClientRequest;

/*
 * This object is constructed internally by the client interface when beginning
 * an RPC request.  Arguments include:
 *
 *     client		a reference back to the FastClient.  Much of the
 *     			functionality of this request is implemented in the
 *     			client.
 *
 *     msgid		unique identifier for this request, scoped to this
 *     			transport connection
 *
 *     rpcmethod	string name of the remote RPC method to invoke
 *
 *     rpcargs		array of arguments to pass to the remote RPC method
 *
 *     ignoreNullValues	see "ignoreNullValues" argument to Fast client's rpc()
 *     			method.
 *
 *     log		bunyan-style logger
 *
 * A FastClientRequest object is a client-side caller's handle for an
 * outstanding RPC request.  From the caller's perspective, fast requests
 * normally emit zero or more "data" messages followed by an "end" message.  An
 * "error" message at any point along the way indicates that the request will
 * receive no further messages.
 *
 * We model this as an object-mode stream.  'data' events are emitted (along
 * with the data payload) for each incoming Fast 'data' message.  When the
 * request completes gracefully, the stream ends (and emits 'end').  If any
 * error occurs along the way, 'error' is emitted, and no further 'data' or
 * 'end' events will be emitted.  Possible sources of error include:
 *
 *     o server-side error: the server explicitly and cleanly sends us an error
 *
 *     o transport or protocol error: we fail the request locally because of an
 *       error maintaining contact with the server
 *
 *     o local abandonment: the caller abandoned the request
 */
function FastClientRequest(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.client, 'args.client');
	mod_assertplus.number(args.msgid, 'args.msgid');
	mod_assertplus.string(args.rpcmethod, 'args.rpcmethod');
	mod_assertplus.array(args.rpcargs, 'args.rpcargs');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.bool(args.ignoreNullValues, 'args.ignoreNullValues');

	/* rpc parameters */
	this.frq_client = args.client;
	this.frq_msgid = args.msgid;
	this.frq_rpcmethod = args.rpcmethod;
	this.frq_rpcargs = args.rpcargs;
	this.frq_ignorenull = args.ignoreNullValues;

	/*
	 * RPC state: most RPC requests are immediately transmitted (at least to
	 * the underlying transport, even if that component ends up queueing
	 * them).  Once that happens, they complete in one of three ways:
	 *
	 *     o gracefully, when the server sends an "end" or "error" message
	 *
	 *     o when the local caller issues an abandonment
	 *
	 *     o when there's an error on the transport, after which we do not
	 *       expect to receive a graceful response
	 *
	 * The first two conditions are indicated by frq_done_graceful and
	 * frq_abandoned.  frq_error is set whenever an error is encountered for
	 * this request, which may be in any of these conditions.
	 *
	 * If the transport is disconnected when the user makes the initial
	 * request, then we never bother to transmit the request.  We will set
	 * frq_skip for this case, though only for debugging purposes.
	 */
	this.frq_done_graceful = false;	/* recvd "end" or "error" from server */
	this.frq_abandoned = false;	/* abandoned locally */
	this.frq_error = null;		/* error, if any */
	this.frq_hrtstarted = null;	/* granular time the request started */
	this.frq_timeout = null;	/* timeout handle, if any */

	/* helpers */
	this.frq_log = args.log;	/* logger */

	/* debugging state */
	this.frq_skip = false;		/* RPC was skipped (no transport) */
	this.frq_ndata = 0;		/* data messages emitted */
	this.frq_nignored = 0;		/* count of ignored messages */
	this.frq_nignored_null = 0;	/* count of ignored "null" values */
	this.frq_last = null;		/* last message received */

	/*
	 * The high watermark is not really used because we do not support flow
	 * control.
	 */
	mod_stream.PassThrough.call(this, {
	    'objectMode': true,
	    'highWaterMark': 16
	});
}

mod_util.inherits(FastClientRequest, mod_stream.PassThrough);

FastClientRequest.prototype.abandon = function ()
{
	/*
	 * This method is just a convenience alias for the guts that happen in
	 * the client's requestAbandon() method, where all the real work
	 * happens.
	 */
	return (this.frq_client.requestAbandon(this, new VError({
	    'name': 'FastRequestAbandonedError'
	}, 'request abandoned by user')));
};

FastClientRequest.prototype.requestId = function ()
{
	return (this.frq_msgid);
};
