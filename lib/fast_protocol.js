/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * lib/fast_protocol.js: fast protocol definitions
 */

var mod_assertplus = require('assert-plus');
var mod_crc = require('crc');
var mod_extsprintf = require('extsprintf');
var mod_old_crc = require('oldcrc');
var mod_stream = require('stream');
var mod_util = require('util');
var VError = require('verror');

/* Exported interface */
exports.fastMessageEncode = fastMessageEncode;
exports.FastMessageEncoder = FastMessageEncoder;
exports.FastMessageDecoder = FastMessageDecoder;
/* Protocol constants are exported below. */

/*
 * Protocol definition
 *
 * All fast protocol messages look like the following:
 *
 *    0x00   +---------+--------+---------+---------+
 *           | VERSION | TYPE   | STATUS  | MSGID1  |
 *    0x04   +---------+--------+---------+---------+
 *           | MSGID2  | MSGID3 | MSGID4  | CRC1    |
 *    0x08   +---------+--------+---------+---------+
 *           | CRC2    | CRC3   | CRC4    | DLEN1   |
 *    0x0c   +---------+--------+---------+---------+
 *           | DLEN2   | DLEN3  | DLEN4   | DATA0   |
 *    0x10   +---------+--------+---------+---------+
 *           | DATAN...                             |
 *           +---------+--------+---------+---------+
 *
 * VERSION   1-byte integer.  The only supported value is "1".
 *
 * TYPE      1-byte integer.  The only supported value is TYPE_JSON (0x1),
 *           indicating that the data payload is an encoded JSON object.
 *
 * STATUS    1-byte integer.  The only supported values are:
 *
 *     STATUS_DATA  0x1  indicates a "data" message
 *
 *     STATUS_END   0x2  indicates an "end" message
 *
 *     STATUS_ERROR 0x3  indicates an "error" message
 *
 * MSGID1...MSGID4    4-byte big-endian unsigned integer, a unique identifier
 *                    for this message
 *
 * CRC1...CRC4        4-byte big-endian unsigned integer representing the CRC16
 *                    value of the data payload
 *
 * DLEN0...DLEN4      4-byte big-endian unsigned integer representing the number
 *                    of bytes of data payload that follow
 *
 * DATA0...DATAN      Data payload.  This is a JSON-encoded object (for TYPE =
 *                    TYPE_JSON).  The encoding length in bytes is given by the
 *                    DLEN0...DLEN4 bytes.
 *
 * Due to historical bugs in node-crc, the CRC implementation used in version 1
 * of the protocol is essentially incompatible with any CRC implementation other
 * than the one provided by node-crc version 0.x. The changes to address this
 * incompatibility (originally recorded on Github as joyent/node-fast#23) were
 * done to create a migration path for clients and servers off of the buggy
 * version with minimal operational impact. Clients and servers may select a
 * mode of operation where only the buggy CRC calculation is used or where only
 * a correct version of the calculation is used. Additionally, servers may elect
 * to operate in a mode where messages whose CRC is calculated with either the
 * buggy or correct implementation are accepted. In this mode the server will
 * use the same CRC calculation method in response messages to a client that the
 * client used when encoding the message to transmit to the server. This allows
 * for clients to be updated in a gradual manner to support the correct CRC
 * calculation. The FAST_CHECKSUM_* constants in this file control the mode of
 * operation with respect to the CRC calculation of clients and servers. This
 * mechanism can be reused in the event of other such library incompatibilities.
 * This mechanism is not intended or required for normal version upgrades to the
 * CRC library dependency where there is no change in the result produced by one
 * of the CRC calculation methods used by node-fast (crc16 is currently the only
 * one used).
 */

/*
 * Message IDs: each Fast message has a message id, which is scoped to the Fast
 * connection.  We allocate these sequentially from a circular 31-bit space.
 */
var FP_MSGID_MAX        = Math.pow(2, 31) - 1;
exports.FP_MSGID_MAX    = FP_MSGID_MAX;

/*
 * Field offsets
 */
var FP_OFF_VERSION      = 0x0;
var FP_OFF_TYPE         = FP_OFF_VERSION + 0x1;	/* 0x1 */
var FP_OFF_STATUS       = FP_OFF_TYPE + 0x1;	/* 0x2 */
var FP_OFF_MSGID        = FP_OFF_STATUS + 0x1;   /* 0x3 */
var FP_OFF_CRC          = FP_OFF_MSGID + 0x4;	/* 0x7 */
var FP_OFF_DATALEN      = FP_OFF_CRC + 0x4;	/* 0xb */
var FP_OFF_DATA         = FP_OFF_DATALEN + 0x4;	/* 0xf */
exports.FP_OFF_VERSION  = FP_OFF_VERSION;
exports.FP_OFF_TYPE     = FP_OFF_TYPE;
exports.FP_OFF_STATUS   = FP_OFF_STATUS;
exports.FP_OFF_MSGID    = FP_OFF_MSGID;
exports.FP_OFF_CRC      = FP_OFF_CRC;
exports.FP_OFF_DATALEN  = FP_OFF_DATALEN;
exports.FP_OFF_DATA     = FP_OFF_DATA;


/* size (in bytes) of each message header */
var FP_HEADER_SZ        = FP_OFF_DATA;		/* 0xf */
exports.FP_HEADER_SZ    = FP_HEADER_SZ;

/* possible values for the "status" byte */
var FP_STATUS_DATA      = 0x1;
var FP_STATUS_END       = 0x2;
var FP_STATUS_ERROR     = 0x3;
exports.FP_STATUS_DATA  = FP_STATUS_DATA;
exports.FP_STATUS_END   = FP_STATUS_END;
exports.FP_STATUS_ERROR = FP_STATUS_ERROR;

/* possible values for the "type" byte */
var FP_TYPE_JSON        = 0x1;
exports.FP_TYPE_JSON    = FP_TYPE_JSON;

/* possible values for the "version" byte */
var FP_VERSION_1           = 0x1;
var FP_VERSION_CURRENT     = FP_VERSION_1;
exports.FP_VERSION_1       = FP_VERSION_1;
exports.FP_VERSION_CURRENT = FP_VERSION_CURRENT;

// These constants are facilitate an upgrade path from buggy node-crc@0.3.0
var FAST_CHECKSUM_V1         = 0x1;
var FAST_CHECKSUM_V1_V2      = 0x2;
var FAST_CHECKSUM_V2         = 0x3;
exports.FAST_CHECKSUM_V1     = FAST_CHECKSUM_V1;
exports.FAST_CHECKSUM_V1_V2  = FAST_CHECKSUM_V1_V2;
exports.FAST_CHECKSUM_V2     = FAST_CHECKSUM_V2;

/*
 * Encode a logical message for sending over the wire.  This requires the
 * following named properties:
 *
 *     msgid    (number) message identifier -- see lib/fast.js
 *
 *     data     (object) represents message contents.  At this level, this
 *                       can be any plain-old JavaScript object.
 *
 *     status   (number) message "status" (one of FP_STATUS_DATA, FP_STATUS_END,
 *                       or FP_STATUS_ERROR).
 *
 * Failure to match these requirements is a programmer error that may result in
 * a synchronously thrown exception that should not be caught.
 *
 * Additionally, the following property may be present:
 *
 *     crc_mode	(number) CRC compatibility mode. Used to transition off buggy
 *                       node-crc version. The valid values are FAST_CHECKSUM_V1
 *                       or FAST_CHECKSUM_V2. Any other value results in a
 *                       thrown exception. See the comments at the beginning of
 *                       this module for more details about this property.
 */
function fastMessageEncode(msg, default_crc_mode)
{
	var buffer, data_encoded, datalen, crc16;

	mod_assertplus.object(msg, 'msg');
	mod_assertplus.ok(typeof (msg.msgid) == 'number' &&
	    Math.floor(msg.msgid) == msg.msgid &&
	    msg.msgid >= 0 && msg.msgid <= FP_MSGID_MAX,
	    'msg.msgid is not an integer between 0 and FP_MSGID_MAX');
	mod_assertplus.object(msg.data, 'msg.data');
	mod_assertplus.number(msg.status, 'msg.status');
	mod_assertplus.optionalNumber(msg.crc_mode, 'msg.crc_mode');

	switch (msg.status) {
	case FP_STATUS_DATA:
	case FP_STATUS_END:
	case FP_STATUS_ERROR:
		break;
	default:
		throw (new VError('unsupported fast message status'));
	}

	data_encoded = JSON.stringify(msg.data);

	var crc_mode = msg.crc_mode || default_crc_mode || FAST_CHECKSUM_V1;
	if (crc_mode === FAST_CHECKSUM_V1) {
		crc16 = mod_old_crc.crc16(data_encoded);
	} else if (crc_mode === FAST_CHECKSUM_V2) {
		crc16 = mod_crc.crc16(data_encoded);
	} else {
		throw (new VError('fastMessageEncode: unsupported CRC mode: ' +
		    crc_mode));
	}

	datalen = Buffer.byteLength(data_encoded);
	buffer = new Buffer(FP_HEADER_SZ + datalen);
	buffer.writeUInt8(FP_VERSION_CURRENT, FP_OFF_VERSION);
	buffer.writeUInt8(FP_TYPE_JSON, FP_OFF_TYPE);
	buffer.writeUInt8(msg.status, FP_OFF_STATUS);
	buffer.writeUInt32BE(msg.msgid, FP_OFF_MSGID);
	buffer.writeUInt32BE(crc16, FP_OFF_CRC);
	buffer.writeUInt32BE(datalen, FP_OFF_DATALEN);
	buffer.write(data_encoded, FP_OFF_DATA, datalen, 'utf8');
	return (buffer);
}

/*
 * Validate the message CRC based on the CRC compatibility mode. Returns an
 * object that contains the decoded CRC mode if the validation is successful
 * or an error if the validation fails.
 *
 *     crcMode		CRC mode. Used to transition off buggy node-crc version.
 *             		See the comments at the top of this module for more
 *                      details.
 *     headerCrc        The CRC provided in the Fast message header.
 *     data             The string representation of the Fast message data.
 */
function valdiateCrc(crcMode, headerCrc, data) {
	var decodedCrcMode, error, v1CalculatedCrc, v2CalculatedCrc;

	switch (crcMode) {
	case FAST_CHECKSUM_V1:
		v1CalculatedCrc = mod_old_crc.crc16(data);
		if (v1CalculatedCrc !== headerCrc) {
			error = crcValidationError(crcMode, headerCrc,
			    v1CalculatedCrc, undefined);
		}
		break;
	case FAST_CHECKSUM_V1_V2:
		v1CalculatedCrc = mod_old_crc.crc16(data);
		v2CalculatedCrc = mod_crc.crc16(data);

		if (v1CalculatedCrc !== headerCrc &&
		    v2CalculatedCrc !== headerCrc) {
			error = crcValidationError(crcMode, headerCrc,
			    v1CalculatedCrc, v2CalculatedCrc);
		} else if (v2CalculatedCrc === headerCrc) {
			decodedCrcMode = FAST_CHECKSUM_V2;
		} else {
			decodedCrcMode = FAST_CHECKSUM_V1;
		}
		break;
	case FAST_CHECKSUM_V2:
		v2CalculatedCrc = mod_crc.crc16(data);
		if (v2CalculatedCrc !== headerCrc) {
			error = crcValidationError(crcMode, headerCrc,
			    undefined, v2CalculatedCrc);
		}
		decodedCrcMode = FAST_CHECKSUM_V2;
		break;
	default:
		mod_assertplus.fail('encountered invalid CRC mode ' + crcMode);
		break;
	}

	return ({ decodedCrcMode: decodedCrcMode, error: error});
}

/*
 * Return a Verror with details about a CRC validation failure based on the CRC
 * compatibility mode.
 *
 *     crcMode		CRC mode. Used to transition off buggy node-crc version.
 *             		See the comments at the top of this module for more
 *                      details.
 *     headerCrc        The CRC provided in the Fast message header.
 *     v1CalculatedCrc  The calculated CRC for the FAST_CHECKSUM_V1 CRC mode.
 *                      May be undefined if the CRC mode is set to
 *                      FAST_CHECKSUM_V2.
 *     v2CalculatedCrc  The calculated CRC for the FAST_CHECKSUM_V2 CRC mode.
 *                      May be undefined if the CRC mode is set to
 *                      FAST_CHECKSUM_V1.
 */
function crcValidationError(crcMode, headerCrc, v1CalculatedCrc,
    v2CalculatedCrc) {
	var errorObj = {
	    'name': 'FastProtocolError',
	    'info': {
		'fastReason': 'bad_crc',
		'crcExpected': headerCrc
	    }
	};
	var errorStr = mod_extsprintf.sprintf('fast protocol: expected CRC ' +
	    '%s, found ', headerCrc);
	var crcStr = '';

	switch (crcMode) {
	case FAST_CHECKSUM_V1:
		errorObj.info.crcCalculated = v1CalculatedCrc;
		crcStr = mod_extsprintf.sprintf('%s', v1CalculatedCrc);
		break;
	case FAST_CHECKSUM_V1_V2:
		errorObj.info.crcCalculatedV1 = v1CalculatedCrc;
		errorObj.info.crcCalculatedV2 = v2CalculatedCrc;
		crcStr = mod_extsprintf.sprintf('%s or %s', v1CalculatedCrc,
		    v2CalculatedCrc);
		break;
	case FAST_CHECKSUM_V2:
		errorObj.info.crcCalculated = v2CalculatedCrc;
		crcStr = mod_extsprintf.sprintf('%s', v2CalculatedCrc);
		break;
	default:
		break;
	}

	errorStr += crcStr;
	return (new VError(errorObj, errorStr));
}

/*
 * Decode a fast message from a buffer that's known to contain a single,
 * well-formed message.  All of the protocol fields are known to be valid (e.g.,
 * version, type, status, and msgid) at this point, but the data has not been
 * read, so the CRC has not been validated.
 */
function fastMessageDecode(header, buffer, crcMode)
{
	var datalen, datastr, json, decodedCrcMode;

	mod_assertplus.number(header.datalen, 'header.datalen');
	datalen = header.datalen;
	mod_assertplus.equal(buffer.length, FP_OFF_DATA + datalen);
	datastr = buffer.toString('utf8', FP_OFF_DATA);

	crcMode = crcMode || FAST_CHECKSUM_V1;

	var crcValidationResult = valdiateCrc(crcMode, header.crc, datastr);

	if (crcValidationResult && crcValidationResult.error) {
		return (crcValidationResult.error);
	} else {
		decodedCrcMode = crcValidationResult.decodedCrcMode;
	}

	try {
		json = JSON.parse(datastr);
	} catch (ex) {
		return (new VError({
		    'name': 'FastProtocolError',
		    'cause': ex,
		    'info': {
			'fastReason': 'invalid_json'
		    }
		}, 'fast protocol: invalid JSON in "data"'));
	}

	if (typeof (json) != 'object' || json === null) {
		return (new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'bad_data'
		    }
		}, 'fast protocol: message data must be a non-null object'));
	}

	if ((header.status == FP_STATUS_DATA ||
	    header.status == FP_STATUS_END) && !Array.isArray(json.d)) {
		return (new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'bad_data_d'
		    }
		}, 'fast protocol: data.d for DATA and END messages must be ' +
		    'an array'));
	}

	if (header.status == FP_STATUS_ERROR &&
	    (typeof (json.d) != 'object' || json.d === null ||
	    typeof (json.d.name) != 'string' ||
	    typeof (json.d.message) != 'string')) {
		return (new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'bad_error'
		    }
		}, 'fast protocol: data.d for ERROR messages must have name ' +
		    'and message'));
	}

	return ({
	    'status': header.status,
	    'msgid': header.msgid,
	    'data': json,
	    'crc_mode': decodedCrcMode
	});
}

/*
 * Transform stream that takes logical messages and emits a buffer representing
 * that message (for sending over the wire).
 *
 *     crc_mode		CRC mode. Used to transition off buggy node-crc version.
 *             		See the comments at the top of this module for more
 *                      details.
 */
function FastMessageEncoder(crc_mode)
{
	mod_stream.Transform.call(this, {
	    'highWaterMark': 16,
	    'objectMode': true
	});

	this.crc_mode = crc_mode;
}

mod_util.inherits(FastMessageEncoder, mod_stream.Transform);

FastMessageEncoder.prototype._transform = function (chunk, _, callback)
{
	this.push(fastMessageEncode(chunk, this.crc_mode));
	setImmediate(callback);
};


/*
 * Transform stream that takes bytes (via Buffer objects) and emits an object
 * representing the encoded Fast message.
 *
 *     crc_mode		CRC mode. Used to transition off buggy node-crc version.
 *             		See the comments at the top of this module for more
 *                      details.
 */
function FastMessageDecoder(crc_mode)
{
	mod_stream.Transform.call(this, {
	    'objectMode': true
	});

	/* current state */
	this.md_buffer = null;		/* unparsed data */
	this.md_havebytes = 0;		/* bytes of unparsed data */
	this.md_done = false;		/* we've read end-of-stream */
	this.md_error = null;		/* fatal error */
	this.md_pushing = false;	/* currently calling push() */

	/* current header */
	this.md_version = null;
	this.md_type = null;
	this.md_status = null;
	this.md_msgid = null;
	this.md_crc = null;
	this.md_datalen = null;

	/* debug information */
	this.md_nmessages = 0;
	this.md_nbytes = 0;

	this.crc_mode = crc_mode;
}

mod_util.inherits(FastMessageDecoder, mod_stream.Transform);

FastMessageDecoder.prototype._transform = function (chunk, _, callback)
{
	this.md_havebytes += chunk.length;

	if (this.md_buffer === null) {
		mod_assertplus.equal(this.md_havebytes, chunk.length);
		this.md_buffer = chunk;
	} else {
		this.md_buffer = Buffer.concat(
		    [ this.md_buffer, chunk ], this.md_havebytes);
	}

	this.md_nbytes += chunk.length;
	this.decode(callback);
};

FastMessageDecoder.prototype._flush = function (callback)
{
	this.md_done = true;
	this.decode(callback);
};

FastMessageDecoder.prototype.decode = function (callback)
{
	var buf, msg;

	if (this.md_pushing) {
		return;
	}

	mod_assertplus.ok(this.md_error === null);

	while (this.md_havebytes >= FP_HEADER_SZ) {
		buf = this.md_buffer;
		mod_assertplus.equal(buf.length, this.md_havebytes);
		mod_assertplus.ok(buf !== null);
		mod_assertplus.ok(this.md_error === null);
		mod_assertplus.ok(this.md_version === null);

		this.md_version = buf.readUInt8(FP_OFF_VERSION);
		if (this.md_version != FP_VERSION_CURRENT) {
			this.md_error = new VError({
			    'name': 'FastProtocolError',
			    'info': {
				'fastReason': 'unsupported_version',
				'foundVersion': this.md_version
			    }
			}, 'fast protocol: unsupported version %d',
			    this.md_version);
			break;
		}

		this.md_type = buf.readUInt8(FP_OFF_TYPE);
		if (this.md_type != FP_TYPE_JSON) {
			this.md_error = new VError({
			    'name': 'FastProtocolError',
			    'info': {
			        'fastReason': 'unsupported_type',
				'foundType': this.md_type
			    }
			}, 'fast protocol: unsupported type 0x%x',
			    this.md_type);
			break;
		}

		this.md_status = buf.readUInt8(FP_OFF_STATUS);
		switch (this.md_status) {
		case FP_STATUS_DATA:
		case FP_STATUS_END:
		case FP_STATUS_ERROR:
			break;
		default:
			this.md_error = new VError({
			    'name': 'FastProtocolError',
			    'info': {
			        'fastReason': 'unsupported_status',
				'foundStatus': this.md_status
			    }
			}, 'fast protocol: unsupported status 0x%x',
			    this.md_status);
			break;
		}

		if (this.md_error !== null) {
			break;
		}

		this.md_msgid = buf.readUInt32BE(FP_OFF_MSGID);
		if (this.md_msgid < 0 || this.md_msgid > FP_MSGID_MAX) {
			this.md_error = new VError({
			    'name': 'FastProtocolError',
			    'info': {
				'fastReason': 'invalid_msgid',
				'foundMsgid': this.md_msgid
			    }
			}, 'fast protocol: invalid msgid %s', this.md_msgid);
			break;
		}

		this.md_crc = buf.readUInt32BE(FP_OFF_CRC);
		this.md_datalen = buf.readUInt32BE(FP_OFF_DATALEN);

		if (this.md_havebytes < FP_HEADER_SZ + this.md_datalen) {
			/*
			 * We don't have enough bytes to continue.  Stop now.
			 * We'll end up re-parsing the header again when we have
			 * more data.  If that turns out to be expensive, we can
			 * rework this code to keep track of where we were.
			 */
			this.md_version = null;
			this.md_type = null;
			this.md_status = null;
			this.md_msgid = null;
			this.md_crc = null;
			this.md_datalen = null;
			break;
		}

		/*
		 * We have a complete message.  Consume it and update our buffer
		 * state.
		 */
		buf = this.md_buffer.slice(0, FP_HEADER_SZ + this.md_datalen);
		this.md_buffer = this.md_buffer.slice(
		    FP_HEADER_SZ + this.md_datalen);
		this.md_havebytes -= buf.length;
		msg = fastMessageDecode({
		    'version': this.md_version,
		    'type': this.md_type,
		    'status': this.md_status,
		    'msgid': this.md_msgid,
		    'crc': this.md_crc,
		    'datalen': this.md_datalen
		}, buf, this.crc_mode);
		if (msg instanceof Error) {
			this.md_error = msg;
			break;
		}

		this.md_version = null;
		this.md_type = null;
		this.md_status = null;
		this.md_msgid = null;
		this.md_crc = null;
		this.md_datalen = null;

		this.md_pushing = true;
		this.push(msg);
		this.md_pushing = false;
		this.md_nmessages++;
	}

	if (this.md_error === null && this.md_havebytes > 0 && this.md_done) {
		this.md_error = new VError({
		    'name': 'FastProtocolError',
		    'info': {
			'fastReason': 'incomplete_message'
		    }
		}, 'fast protocol: incomplete message at end-of-stream');
	}

	if (this.md_error !== null) {
		setImmediate(callback, this.md_error);
	} else {
		setImmediate(callback);
	}
};
