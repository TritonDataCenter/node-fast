# Contributing to node-fast

This repository uses GitHub pull requests for code review.

See the [Joyent Engineering
Guidelines](https://github.com/joyent/eng/blob/master/docs/index.md) for general
best practices expected in this repository.

Contributions should be "make prepush" clean.  The "prepush" target runs the
"check" target, which requires these separate tools:

* https://github.com/davepacheco/jsstyle
* https://github.com/davepacheco/javascriptlint

If you're changing something non-trivial or user-facing, you may want to submit
an issue first.  Because this protocol is widely deployed, we generally view
backwards compatibility (both on the wire and in the API) as a constraint on all
changes.


## Testing

Automated tests can be run using `make test`.  This test suite should be pretty
exhaustive for both basic functionality and edge cases.

You can use the `fastserve` and `fastcall` programs for ad-hoc testing.


## Backwards compatibility with older versions of Fast

As mentioned in the README, there was a previous implementation of this
protocol.  The client and server APIs are different in this module than the
previous implementation.  However, the client here is compatible with a server
built on the previous implementation, and the server here is compatible with a
client built on the previous implementation.

There are several reasons we might want to use the old implementation in this
module:

* done: basic functionality testing this client against the old server
* not implemented: basic functionality testing this server against the old
  client
* not implemented: for performance testing either the old client or server

This is made significantly more complicated by the fact that the old
implementation only works with Node 0.10, while this implementation is expected
to run on Node 0.12 and later.

**The easiest way to test compatibility is to set `FAST\_COMPAT\_NODEDIR` in
your environment and run `make test-compat`**:

    export FAST_COMPAT_NODEDIR=/path/to/node-v0.10-directory
    make test-compat

This will do the following:

* sanity-check the `node` in `$FAST_COMPAT_NODEDIR/bin/node`
* use the `npm` in that directory to install the _old_ fast module into
  `test/compat/node_modules/fast`
* run the compatibility tests in `test/compat`.

These could be incorporated into "make prepush", but developers would have to
have `FAST_COMPAT_NODEDIR` set to a directory containing 0.10.


## Performance testing

The `fastbench` command can be used to make RPC requests to a remote server
for a fixed number of requests, for a given period of time, or until the program
itself is killed.  The tool reports very coarse metrics about client-side
request performance:

    $ fastbench -c 10 sync 127.0.0.1 8123
    pid 17354: running workload "sync" until killed (type CTRL-C for results)
    established connection to 127.0.0.1:8123
    ^Cstopping due to SIGINT
    -----------------------------------
    total runtime:             4.233982s
    total requests completed:  6063 (6073 issued)
    total unexpected errors:   0
    error rate:                0.00%
    maximum concurrency:       10
    request throughput:        1431 requests per second
    estimated average latency: 6983 us

The server must support the "fastbench" RPC method, which basically echoes its
arguments and optionally sleeps.  The `fastserve` command implements this RPC,
as does the legacy server in ./test/compat that's described above.

This should be considered only a rough estimate of performance under very
particular conditions.  Proper performance analysis requires not just careful
collection of data, but also understanding exactly what the system is doing and
where the bottleneck is to make sure you're looking at correct numbers.
