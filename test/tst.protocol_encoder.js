/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * test/tst.protocol_encoder.js: fast protocol encoder tests
 */

var mod_assertplus = require('assert-plus');
var mod_cmdutil = require('cmdutil');
var mod_extsprintf = require('extsprintf');
var mod_path = require('path');

var mod_protocol = require('../lib/fast_protocol');
var printf = mod_extsprintf.printf;

var mod_testcommon = require('./common');

var bigdata, bigdataval, test_cases;
var circular = {};
circular['a'] = 47;
circular['b'] = circular;

function main()
{
	/* This object winds up being about 28MB encoded as JSON. */
	printf('generating large object ... ');
	bigdata = [ mod_testcommon.makeBigObject(10, 6) ];
	bigdataval = JSON.stringify(bigdata);
	printf('%d bytes (stringified)\n', bigdataval.length);

	test_cases.forEach(runTestCase);
	printf('%s tests passed\n', mod_path.basename(__filename));
}

test_cases = [ {
    'name': 'basic data message',
    'input': {
	'msgid': 1,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [ 'hello', 'world' ],
	'version': mod_protocol.FP_VERSION_CURRENT
    },
    'check': function (output, parsed) {
	var expected = '["hello","world"]';
	var expectedlen = Buffer.byteLength(expected);
	mod_assertplus.equal(parsed.pm_datalen, expectedlen);
	mod_assertplus.equal(parsed.pm_data.toString('utf8'), expected);
	mod_assertplus.equal(parsed.pm_msgid, 1);
	mod_assertplus.equal(parsed.pm_crc, 7500);
	mod_assertplus.equal(parsed.pm_version,
	    mod_protocol.FP_VERSION_CURRENT);
    }
}, {
    'name': 'basic data message, protocol version 1',
    'input': {
	'msgid': 1,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [ 'hello', 'world' ],
	'version': mod_protocol.FP_VERSION_1
    },
    'check': function (output, parsed) {
	var expected = '["hello","world"]';
	var expectedlen = Buffer.byteLength(expected);
	mod_assertplus.equal(parsed.pm_datalen, expectedlen);
	mod_assertplus.equal(parsed.pm_data.toString('utf8'), expected);
	mod_assertplus.equal(parsed.pm_msgid, 1);
	mod_assertplus.equal(parsed.pm_crc, 10980);
	mod_assertplus.equal(parsed.pm_version,
	    mod_protocol.FP_VERSION_1);
    }
}, {
    'name': 'large data message',
    'input': {
	'msgid': 7,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': function () { return (bigdata); },
	'version': mod_protocol.FP_VERSION_CURRENT
    },
    'check': function (output, parsed) {
	var expected = bigdataval;
	var expectedlen = Buffer.byteLength(expected);
	mod_assertplus.equal(parsed.pm_datalen, expectedlen);
	mod_assertplus.equal(parsed.pm_data.toString('utf8'), expected);
	mod_assertplus.equal(parsed.pm_msgid, 7);
	mod_assertplus.equal(parsed.pm_status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.equal(parsed.pm_version,
	    mod_protocol.FP_VERSION_CURRENT);
    }
}, {
    'name': 'large data message, protocol version 1',
    'input': {
	'msgid': 7,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': function () { return (bigdata); },
	'version': mod_protocol.FP_VERSION_1
    },
    'check': function (output, parsed) {
	var expected = bigdataval;
	var expectedlen = Buffer.byteLength(expected);
	mod_assertplus.equal(parsed.pm_datalen, expectedlen);
	mod_assertplus.equal(parsed.pm_data.toString('utf8'), expected);
	mod_assertplus.equal(parsed.pm_msgid, 7);
	mod_assertplus.equal(parsed.pm_status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.equal(parsed.pm_version,
	    mod_protocol.FP_VERSION_1);
    }
}, {
    'name': 'minimum msgid',
    'input': {
	'msgid': 0,
	'status': mod_protocol.FP_STATUS_ERROR,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    },
    'check': function (output, parsed) {
	mod_assertplus.equal(parsed.pm_msgid, 0);
	mod_assertplus.equal(parsed.pm_status, mod_protocol.FP_STATUS_ERROR);
    }
}, {
    'name': 'maximum msgid',
    'input': {
	'msgid': 2147483647,
	'status': mod_protocol.FP_STATUS_END,
	'data': [ 'hello' ],
	'version': mod_protocol.FP_VERSION_CURRENT
    },
    'check': function (output, parsed) {
	mod_assertplus.equal(parsed.pm_msgid, 2147483647);
	mod_assertplus.equal(parsed.pm_status, mod_protocol.FP_STATUS_END);
	mod_assertplus.equal(parsed.pm_version,
	    mod_protocol.FP_VERSION_CURRENT);
    }
}, {
    'name': 'bad msgid: missing',
    'error': /msg.msgid is not an integer between 0 and FP_MSGID_MAX/,
    'input': {
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad msgid: negative',
    'error': /msg.msgid is not an integer between 0 and FP_MSGID_MAX/,
    'input': {
	'msgid': -3,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad msgid: too large',
    'error': /msg.msgid is not an integer between 0 and FP_MSGID_MAX/,
    'input': {
	'msgid': 2147483648,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad msgid: non-integer',
    'error': /msg.msgid is not an integer between 0 and FP_MSGID_MAX/,
    'input': {
	'msgid': 3.7,
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad msgid: non-numeric',
    'error': /msg.msgid is not an integer between 0 and FP_MSGID_MAX/,
    'input': {
	'msgid': {},
	'status': mod_protocol.FP_STATUS_DATA,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad status: missing',
    'error': /msg.status \(number\) is required/,
    'input': {
	'msgid': 17,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad status: non-numeric',
    'error': /msg.status \(number\) is required/,
    'input': {
	'msgid': 17,
	'status': {},
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad status: unsupported value (4)',
    'error': /unsupported fast message status/,
    'input': {
	'msgid': 17,
	'status': 4,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad status: unsupported value (0)',
    'error': /unsupported fast message status/,
    'input': {
	'msgid': 17,
	'status': 0,
	'data': [],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad data: missing',
    'error': /msg.data \(object\) is required/,
    'input': {
	'msgid': 17,
	'status': mod_protocol.FP_STATUS_ERROR,
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad data: null',
    'error': /msg.data \(object\) is required/,
    'input': {
	'msgid': 17,
	'status': mod_protocol.FP_STATUS_ERROR,
	'data': null,
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad data: numeric',
    'error': /msg.data \(object\) is required/,
    'input': {
	'msgid': 17,
	'status': mod_protocol.FP_STATUS_ERROR,
	'data': 47,
	'version': mod_protocol.FP_VERSION_CURRENT
    }
}, {
    'name': 'bad data: not stringifiable',
    'error': /Converting circular structure to JSON/,
    'input': {
	'msgid': 17,
	'status': mod_protocol.FP_STATUS_ERROR,
	'data': [ circular ],
	'version': mod_protocol.FP_VERSION_CURRENT
    }
} ];

function runTestCase(testcase)
{
	var error, outbuf, parsed;

	printf('test case: %s: ', testcase.name);

	if (typeof (testcase['input']['data']) == 'function') {
		testcase['input']['data'] = testcase['input']['data']();
	}

	try {
		outbuf = mod_protocol.fastMessageEncode(testcase.input);
	} catch (ex) {
		error = ex;
	}

	if (error !== undefined) {
		if (!testcase['error']) {
			printf('FAIL\n');
			printf('expected success, found error: %s\n',
			    error.stack);
			throw (error);
		}

		if (!testcase['error'].test(error.message)) {
			printf('FAIL\n');
			printf('expected error to match: %s\n',
			    testcase['error'].source);
			printf('found error: %s\n', error.stack);
			throw (error);
		}
	} else {
		if (testcase['error']) {
			printf('FAIL\n');
			printf('expected error to match: %s\n',
			    testcase['error'].source);
			printf('found success\n');
			throw (new Error('test case failed'));
		}

		/*
		 * Check conditions that should be true for all success cases.
		 */
		mod_assertplus.ok(Buffer.isBuffer(outbuf));
		mod_assertplus.ok(outbuf.length > mod_protocol.FP_HEADER_SZ);
		mod_assertplus.equal(0x1,
		    outbuf.readUInt8(mod_protocol.FP_OFF_TYPE));

		parsed = {};
		parsed.pm_datalen =
		    outbuf.readUInt32BE(mod_protocol.FP_OFF_DATALEN);
		parsed.pm_data = outbuf.slice(mod_protocol.FP_OFF_DATA);
		parsed.pm_status = outbuf.readUInt8(mod_protocol.FP_OFF_STATUS);
		parsed.pm_msgid =
		    outbuf.readUInt32BE(mod_protocol.FP_OFF_MSGID);
		parsed.pm_crc = outbuf.readUInt32BE(mod_protocol.FP_OFF_CRC);
		parsed.pm_version =
		    outbuf.readUInt8(mod_protocol.FP_OFF_VERSION);

		mod_assertplus.ok(parsed.pm_status > 0 &&
		    parsed.pm_status <= 0x3);
		testcase['check'](outbuf, parsed);
	}

	printf('ok\n');
}

main();
