# Fast Changelog

## Not yet released.

* #16 fastserve cannot be run concurrently even with different arguments

## v2.4.0

* #14 want node-fast FastServer 'onConnsDestroyed' method

## v2.3.2

* #15 server leaks memory on socket errors
* #12 want support for node v6.12.0

## v2.3.1

* #11 add RPC method name to metrics

## v2.3.0

* #9 node-fast could track basic request metrics

## v2.2.4

* #7 fsr_context isn't always unpiped from fsr_encoder, which causes memory leaks

## v2.2.3

* #5 Server shutdown crashes when a connection had a socket error

## v2.2.2

* #4 client should preserve "ase\_errors" for Errors

## v2.2.1

* #3 client should not log at "error" level

## v2.2.0

* #2 update dependencies to support Node v4

## v2.1.0

* #1 need limited support for servers that send null values

## v2.0.0 (2016-08-29)

This is a complete rewrite of the Fast client and server implementation.  Almost
everything about the API has changed, including constructors, methods, and
arguments.  The primary difference is that the new Fast client is generally only
responsible for Fast-protocol-level concerns.  It does not do service discovery
(via DNS), connection establishment, health monitoring, retries, or anything
like that.  Callers are expected to use something like node-cueball for that.
The server manages a little bit more of the TCP state than the client does
(particularly as clients connect), but callers are still expected to manage the
server socket itself.  To summarize: callers are expected to manage their own
`net.Socket` (for clients) or `net.Server` (for servers), watching those objects
for whatever events they're interested in and using those classes' methods for
working with them.  You no longer treat the Fast client as a wrapper for a
`net.Socket` or the Fast server as a wrapper for a `net.Server`.

As a result of this change in design, the constructor arguments are pretty
different.  Many methods are gone (e.g., client.connect(), client.close(),
server.listen(), server.address(), and so on).  The interface is generally much
simpler.

To make methods more extensible and consistent with Joyent's Best Practices for
Error Handling (see README), the major APIs (constructors, `client.rpc()`, and
`server.rpc()`) have been changed to accept named arguments in a single `args`
argument.

Other concrete API differences include:

* Clients that make RPC calls get back a proper Readable stream, rather than an
  EventEmitter that emits `message`, `end`, and `error` events.  (The previous
  implementation used the spirit of Node.js's object-mode streams, but predated
  their maturity, and so implemented something similar but ad-hoc.) As a result
  of this change, you cannot send `null` over the RPC channel, since object-mode
  streams use `null` to denote end-of-stream.  Of course, you can wrap `null` in
  an object.
* `Client.rpc()` now takes named arguments as mentioned above.
* `Server.rpc()` is now called `Server.registerRpcMethod()` and takes named
  arguments as mentioned above.
* The server no longer provides an `after` event after RPC requests complete.

Other notable differences include:

* This implementation fixes a large number of protocol bugs, including cases
  where the protocol version was ignored in incoming messages and unsupported
  kinds of messages were treated as new RPC requests.
* This implementation does not support aborting RPC requests because the
  previous mechanism for this was somewhat dangerous.  (See README.)
* The client DTrace probes have been revised.  Server DTrace probes have been
  added.  (See README.)
* Kang entry points have been added for observability.  (See README.)

The original implementation can be found in the [v0.x
branch](https://github.com/joyent/node-fast/tree/fast-v0.x).
