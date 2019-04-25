/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * test/tst.protocol_decoder.js: fast protocol decoder tests
 */

var mod_assertplus = require('assert-plus');
var mod_cmdutil = require('cmdutil');
var mod_old_crc = require('oldcrc');
var mod_crc = require('crc');
var mod_extsprintf = require('extsprintf');
var mod_path = require('path');
var mod_vasync = require('vasync');
var VError = require('verror');

var mod_protocol = require('../lib/fast_protocol');
var printf = mod_extsprintf.printf;

var mod_testcommon = require('./common');

var test_cases;

function main()
{
	mod_testcommon.registerExitBlocker('test run');
	mod_vasync.forEachPipeline({
	    'inputs': test_cases,
	    'func': runTestCase
	}, function (err) {
		if (err) {
			throw (err);
		}

		mod_testcommon.unregisterExitBlocker('test run');
		printf('%s tests passed\n', mod_path.basename(__filename));
	});
}

function runTestCase(testcase, callback)
{
	var crc_mode = testcase['crc_mode'] || mod_protocol.FAST_CHECKSUM_V2;
	var decoder = new mod_protocol.FastMessageDecoder(crc_mode);
	var data = [];
	var error = null;

	printf('test case: %s: ', testcase['name']);

	decoder.on('data', function (c) { data.push(c); });
	decoder.on('error', function (err) {
		mod_assertplus.ok(error === null);
		error = err;
		testcase['check'](error, data);
		printf('ok\n');
		callback();
	});
	decoder.on('end', function () {
		mod_assertplus.ok(error === null);
		testcase['check'](error, data);
		printf('ok\n');
		callback();
	});

	decoder.end(testcase['input']());
}

var sample_object = { 'd': [ { 'hello': 'world' } ] };
var sample_data = JSON.stringify(sample_object);
var sample_old_crc = mod_old_crc.crc16(sample_data);
var sample_crc = mod_crc.crc16(sample_data);

var sample_error = { 'd': { 'name': 'AnError', 'message': 'boom!' } };

/* This object winds up being about 28MB encoded as JSON. */
var big_object = { 'd': [ mod_testcommon.makeBigObject(10, 6) ] };
var big_data = JSON.stringify(big_object);
var big_crc = mod_old_crc.crc16(big_data);

test_cases = [ {
    'name': 'basic DATA message (old CRC calculaton)',
    'input': function () {
	/*
	 * The first few of these test cases hardcode protocol values to make
	 * sure these constants don't break silently on us (e.g., checking null
	 * against undefined because FP_OFF_TYPE has been deleted).  Later,
	 * we'll just use the constants for clarity.
	 */
	var buf = new Buffer(mod_protocol.FP_HEADER_SZ + sample_data.length);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_VERSION);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_TYPE);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_STATUS);
	buf.writeUInt32BE(0xbadcafe, mod_protocol.FP_OFF_MSGID);
	buf.writeUInt32BE(sample_old_crc, mod_protocol.FP_OFF_CRC);
	buf.writeUInt32BE(sample_data.length, mod_protocol.FP_OFF_DATALEN);
	buf.write(sample_data, mod_protocol.FP_OFF_DATA);
	return (buf);
    },
    'crc_mode': mod_protocol.FAST_CHECKSUM_V1,
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 0xbadcafe);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.deepEqual(data[0].data, sample_object);
    }
}, {
    'name': 'basic DATA message (old CRC calculation, dual CRC mode)',
    'input': function () {
	/*
	 * The first few of these test cases hardcode protocol values to make
	 * sure these constants don't break silently on us (e.g., checking null
	 * against undefined because FP_OFF_TYPE has been deleted).  Later,
	 * we'll just use the constants for clarity.
	 */
	var buf = new Buffer(mod_protocol.FP_HEADER_SZ + sample_data.length);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_VERSION);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_TYPE);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_STATUS);
	buf.writeUInt32BE(0xbadcafe, mod_protocol.FP_OFF_MSGID);
	buf.writeUInt32BE(sample_old_crc, mod_protocol.FP_OFF_CRC);
	buf.writeUInt32BE(sample_data.length, mod_protocol.FP_OFF_DATALEN);
	buf.write(sample_data, mod_protocol.FP_OFF_DATA);
	return (buf);
    },
    'crc_mode': mod_protocol.FAST_CHECKSUM_V1_V2,
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 0xbadcafe);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.deepEqual(data[0].data, sample_object);
    }
}, {
    'name': 'basic DATA message (decoder in dual CRC mode)',
    'input': function () {
	/*
	 * The first few of these test cases hardcode protocol values to make
	 * sure these constants don't break silently on us (e.g., checking null
	 * against undefined because FP_OFF_TYPE has been deleted).  Later,
	 * we'll just use the constants for clarity.
	 */
	var buf = new Buffer(mod_protocol.FP_HEADER_SZ + sample_data.length);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_VERSION);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_TYPE);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_STATUS);
	buf.writeUInt32BE(0xbadcafe, mod_protocol.FP_OFF_MSGID);
	buf.writeUInt32BE(sample_crc, mod_protocol.FP_OFF_CRC);
	buf.writeUInt32BE(sample_data.length, mod_protocol.FP_OFF_DATALEN);
	buf.write(sample_data, mod_protocol.FP_OFF_DATA);
	return (buf);
    },
    'crc_mode': mod_protocol.FAST_CHECKSUM_V1_V2,
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 0xbadcafe);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.deepEqual(data[0].data, sample_object);
    }
}, {
    'name': 'basic DATA message',
    'input': function () {
	/*
	 * The first few of these test cases hardcode protocol values to make
	 * sure these constants don't break silently on us (e.g., checking null
	 * against undefined because FP_OFF_TYPE has been deleted).  Later,
	 * we'll just use the constants for clarity.
	 */
	var buf = new Buffer(mod_protocol.FP_HEADER_SZ + sample_data.length);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_VERSION);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_TYPE);
	buf.writeUInt8(0x1, mod_protocol.FP_OFF_STATUS);
	buf.writeUInt32BE(0xbadcafe, mod_protocol.FP_OFF_MSGID);
	buf.writeUInt32BE(sample_crc, mod_protocol.FP_OFF_CRC);
	buf.writeUInt32BE(sample_data.length, mod_protocol.FP_OFF_DATALEN);
	buf.write(sample_data, mod_protocol.FP_OFF_DATA);
	return (buf);
    },
    'crc_mode': mod_protocol.FAST_CHECKSUM_V2,
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 0xbadcafe);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.deepEqual(data[0].data, sample_object);
    }
}, {
    'name': 'large END message',
    'input': function () {
	return (makeMessageForData(
	    14, mod_protocol.FP_STATUS_END, big_object));
    },
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 14);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_END);
	mod_assertplus.deepEqual(data[0].data, big_object);
    }
}, {
    'name': 'basic ERROR message',
    'input': function () {
	return (makeMessageForData(47, 0x3, sample_error));
    },
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 47);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_ERROR);
	mod_assertplus.deepEqual(data[0].data, sample_error);
    }
}, {
    'name': 'DATA message with maximum msgid',
    'input': function () {
	var buf = makeSampleMessage(mod_protocol.FAST_CHECKSUM_V2);
	buf.writeUInt32BE(mod_protocol.FP_MSGID_MAX, mod_protocol.FP_OFF_MSGID);
	return (buf);
    },
    'crc_mode': mod_protocol.FAST_CHECKSUM_V2,
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 1);
	mod_assertplus.equal(data[0].msgid, 2147483647);
	mod_assertplus.equal(data[0].status, mod_protocol.FP_STATUS_DATA);
	mod_assertplus.deepEqual(data[0].data, sample_object);
    }
}, {
    'name': 'empty stream',
    'input': function () {
	return (undefined);
    },
    'check': function (error, data) {
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 0);
    }
}, {
    'name': '10,000 DATA messages',
    'input': function () {
	var nmessages, buf, msgsize, msgoffset, i;

	nmessages = 10000;
	msgsize = mod_protocol.FP_HEADER_SZ + sample_data.length;
	buf = new Buffer(nmessages * msgsize);
	for (i = 0; i < nmessages; i++) {
		msgoffset = i * msgsize;
		mod_testcommon.writeMessageForEncodedData(buf, i + 1,
		    mod_protocol.FP_STATUS_DATA, sample_data, msgoffset);
	}

	return (buf);
    },
    'check': function (error, data) {
	var i;
	mod_assertplus.ok(error === null);
	mod_assertplus.equal(data.length, 10000);
	for (i = 0; i < data.length; i++) {
		mod_assertplus.equal(data[i].msgid, i + 1);
		mod_assertplus.equal(data[i].status,
		    mod_protocol.FP_STATUS_DATA);
		mod_assertplus.deepEqual(data[i].data, sample_object);
	}
    }
}, {
    'name': '10,000 messages with an error contained',
    'input': function () {
	var nmessages, buf, msgsize, msgoffset, i;

	nmessages = 10000;
	msgsize = mod_protocol.FP_HEADER_SZ + sample_data.length;
	buf = new Buffer(nmessages * msgsize);
	for (i = 0; i < nmessages; i++) {
		msgoffset = i * msgsize;
		mod_testcommon.writeMessageForEncodedData(buf, i + 1,
		    mod_protocol.FP_STATUS_DATA, sample_data, msgoffset);
		if (i == 1000) {
			buf.writeUInt8(0x0,
			    msgoffset + mod_protocol.FP_OFF_VERSION);
		}
	}

	return (buf);
    },
    'check': function (error, data) {
	var i;
	mod_assertplus.ok(error !== null);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported version 0/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'unsupported_version');
	mod_assertplus.equal(VError.info(error).foundVersion, 0);

	mod_assertplus.equal(data.length, 1000);
	for (i = 0; i < data.length; i++) {
		mod_assertplus.equal(data[i].msgid, i + 1);
		mod_assertplus.equal(data[i].status,
		    mod_protocol.FP_STATUS_DATA);
		mod_assertplus.deepEqual(data[i].data, sample_object);
	}
    }
}, {
    'name': 'bad version (0)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt8(0, mod_protocol.FP_OFF_VERSION);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported version 0/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'unsupported_version');
	mod_assertplus.equal(VError.info(error).foundVersion, 0);
    }
}, {
    'name': 'bad version (37)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt8(37, mod_protocol.FP_OFF_VERSION);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported version 37/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'unsupported_version');
	mod_assertplus.equal(VError.info(error).foundVersion, 37);
    }
}, {
    'name': 'bad type (0)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt8(0, mod_protocol.FP_OFF_TYPE);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported type 0x0/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'unsupported_type');
	mod_assertplus.equal(VError.info(error).foundType, 0);
    }
}, {
    'name': 'bad type (2)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt8(2, mod_protocol.FP_OFF_TYPE);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported type 0x2/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'unsupported_type');
	mod_assertplus.equal(VError.info(error).foundType, 2);
    }
}, {
    'name': 'bad status (0)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt8(0, mod_protocol.FP_OFF_STATUS);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported status 0x0/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'unsupported_status');
	mod_assertplus.equal(VError.info(error).foundStatus, 0);
    }
}, {
    'name': 'bad status (4)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt8(0x4, mod_protocol.FP_OFF_STATUS);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/unsupported status 0x4/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'unsupported_status');
	mod_assertplus.equal(VError.info(error).foundStatus, 4);
    }
}, {
    'name': 'bad msgid (too large)',
    'input': function () {
	var buf = makeSampleMessage();
	buf.writeUInt32BE(mod_protocol.FP_MSGID_MAX + 1,
	    mod_protocol.FP_OFF_MSGID);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/invalid msgid 2147483648/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'invalid_msgid');
	mod_assertplus.equal(VError.info(error).foundMsgid, 2147483648);
    }
}, {
    'name': 'bad CRC 1',
    'input': function () {
	var buf = makeSampleMessage(mod_protocol.FAST_CHECKSUM_V2);
	mod_assertplus.ok(
	    buf.readUInt32BE(mod_protocol.FP_OFF_CRC) != 0xdeadbeef);
	buf.writeUInt32BE(0xdeadbeef, mod_protocol.FP_OFF_CRC);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/expected CRC 3735928559, found/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_crc');
	mod_assertplus.equal(VError.info(error).crcCalculated, sample_crc);
	mod_assertplus.equal(VError.info(error).crcExpected, 0xdeadbeef);
    }
}, {
    'name': 'bad CRC 2',
    'input': function () {
	var buf = makeSampleMessage(mod_protocol.FAST_CHECKSUM_V1);
	mod_assertplus.ok(
	    buf.readUInt32BE(mod_protocol.FP_OFF_CRC) != 0xdeadbeef);
	buf.writeUInt32BE(0xdeadbeef, mod_protocol.FP_OFF_CRC);
	return (buf);
    },
    'crc_mode': mod_protocol.FAST_CHECKSUM_V1,
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/expected CRC 3735928559, found/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_crc');
	mod_assertplus.equal(VError.info(error).crcCalculated, sample_old_crc);
	mod_assertplus.equal(VError.info(error).crcExpected, 0xdeadbeef);
    }
}, {
    'name': 'bad: DATA message with non-array data.d',
    'input': function () {
	var data, buf;
	data = { 'd': { 'foo': 'bar' } };
	buf = makeMessageForData(3, mod_protocol.FP_STATUS_DATA, data);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/data.d for DATA.*must be an array/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_data_d');
    }
}, {
    'name': 'bad: END message with non-array data.d',
    'input': function () {
	var data, buf;
	data = { 'd': { 'foo': 'bar' } };
	buf = makeMessageForData(3, mod_protocol.FP_STATUS_END, data);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/data.d for .*END messages must be an array/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_data_d');
    }
}, {
    'name': 'bad: DATA message with null data',
    'input': function () {
	var data, buf;
	data = null;
	buf = makeMessageForData(3, mod_protocol.FP_STATUS_DATA, data);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/message data must be a non-null object/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_data');
    }
}, {
    'name': 'bad: DATA message with string data',
    'input': function () {
	var data, buf;
	data = 'foobar';
	buf = makeMessageForData(3, mod_protocol.FP_STATUS_DATA, data);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/message data must be a non-null object/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_data');
    }
}, {
    'name': 'bad: ERROR message with missing data',
    'input': function () {
	return (makeMessageForData(47, mod_protocol.FP_STATUS_ERROR, {}));
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/data\.d for ERROR messages must have name/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_error');
    }
}, {
    'name': 'bad: ERROR message with null d',
    'input': function () {
	return (makeMessageForData(47, mod_protocol.FP_STATUS_ERROR,
	    { 'd': null }));
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/data\.d for ERROR messages must have name/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_error');
    }
}, {
    'name': 'bad: ERROR message with bad name',
    'input': function () {
	return (makeMessageForData(47, mod_protocol.FP_STATUS_ERROR,
	    { 'd': { 'name': 47, 'message': 'threeve' } }));
    },
    'check': function (error, data) {
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/data\.d for ERROR messages must have name/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'bad_error');
    }
}, {
    'name': 'bad: end of stream with 1-byte header',
    'input': function () {
	var buf = new Buffer(1);
	buf.writeUInt8(mod_protocol.FP_VERSION_1, mod_protocol.FP_OFF_VERSION);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/incomplete message at end-of-stream/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'incomplete_message');
    }
}, {
    'name': 'bad: end of stream with full header and no data',
    'input': function () {
	var buf = makeSampleMessage();
	buf = buf.slice(0, mod_protocol.FP_HEADER_SZ);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/incomplete message at end-of-stream/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'incomplete_message');
    }
}, {
    'name': 'bad: end of stream with full header and partial data',
    'input': function () {
	var buf = makeSampleMessage();
	buf = buf.slice(0, mod_protocol.FP_HEADER_SZ + 1);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	mod_assertplus.ok(/incomplete message at end-of-stream/.test(
	    error.message));
	mod_assertplus.equal(VError.info(error).fastReason,
	    'incomplete_message');
    }
}, {
    'name': 'bad: invalid JSON data payload',
    'input': function () {
	var datalen, dataenc, buf;
	dataenc = '{ "hello"';
	datalen = Buffer.byteLength(dataenc);
	buf = new Buffer(mod_protocol.FP_HEADER_SZ + datalen);
	mod_testcommon.writeMessageForEncodedData(buf, 3,
	    mod_protocol.FP_STATUS_DATA, dataenc, 0);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	/* JSSTYLED */
	mod_assertplus.ok(/invalid JSON in "data"/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'invalid_json');
    }
}, {
    'name': 'bad: 0-byte payload',
    'input': function () {
	var buf;
	buf = new Buffer(mod_protocol.FP_HEADER_SZ);
	mod_testcommon.writeMessageForEncodedData(buf, 3,
	    mod_protocol.FP_STATUS_DATA, '', 0);
	return (buf);
    },
    'check': function (error, data) {
	mod_assertplus.ok(error instanceof Error);
	mod_assertplus.equal(data.length, 0);
	mod_assertplus.equal(error.name, 'FastProtocolError');
	/* JSSTYLED */
	mod_assertplus.ok(/invalid JSON in "data"/.test(error.message));
	mod_assertplus.equal(VError.info(error).fastReason, 'invalid_json');
    }
} ];

function makeSampleMessage(crc_mode)
{
	return (makeMessageForData(mod_protocol.FP_MSGID_MAX,
	    mod_protocol.FP_STATUS_DATA, sample_object, crc_mode));
}

function makeMessageForData(msgid, status, data, crc_mode)
{
	var datalen, dataenc, buf;

	mod_assertplus.number(msgid);
	mod_assertplus.number(status);
	dataenc = JSON.stringify(data);
	datalen = Buffer.byteLength(dataenc);
	buf = new Buffer(mod_protocol.FP_HEADER_SZ + datalen);
	mod_testcommon.writeMessageForEncodedData(
	    buf, msgid, status, dataenc, 0, crc_mode);
	return (buf);
}

main();
