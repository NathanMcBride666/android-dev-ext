const D = console.log.bind(console);
const E = console.error.bind(console);
const W = console.warn.bind(console);

Array.first = function (arr, fn, defaultvalue) {
	var idx = Array.indexOfFirst(arr, fn);
	return idx < 0 ? defaultvalue : arr[idx];
}

Array.indexOfFirst = function (arr, fn) {
	if (!Array.isArray(arr)) return -1;
	for (var i = 0; i < arr.length; i++)
		if (fn(arr[i], i, arr))
			return i;
	return -1;
}

function isEmptyObject(o) {
	return typeof (o) === 'object' && !Object.keys(o).length;
}

function leftpad(char, len, s) {
	while (s.length < len)
		s = char + s;
	return s;
}

function intToHex(i, minlen) {
	var s = i.toString(16);
	if (minlen) s = leftpad('0', minlen, s);
	return s;
}

function intFromHex(s, maxlen, defaultvalue) {
	s = s.slice(0, maxlen);
	if (!/^[0-9a-fA-F]+$/.test(s)) return defaultvalue;
	return parseInt(s, 16);
}

var fdcache = [];

var index_of_file_fdn = function (n) {
	if (n <= 0) return -1;
	for (var i = 0; i < fdcache.length; i++) {
		if (fdcache[i] && fdcache[i].n === n)
			return i;
	}
	return -1;
}

var remove_fd_from_cache = function (fd) {
	if (!fd) return;
	var idx = index_of_file_fdn(fd.n);
	if (idx >= 0) fdcache.splice(idx, 1);
}

// add an offset so we don't conflict with tcp socketIds
var min_fd_num = 100000;
var _new_fd_count = 0;
this.new_fd = function (name, raw) {
	var rwpipe = raw ? new Uint8Array(0) : [];
	var fd = {
		name: name,
		n: min_fd_num + (++_new_fd_count),
		raw: !!raw,
		readpipe: rwpipe,
		writepipe: rwpipe,
		reader: null,
		readerlen: 0,
		kickingreader: false,
		total: { read: 0, written: 0 },
		duplex: null,
		closed: '',
		read: function (cb) {
			if (this.raw)
				throw 'Cannot read from raw fd';
			if (this.reader && this.reader !== cb)
				throw 'multiple readers?';
			this.reader = cb;
			this._kickreader();
		},
		write: function (data) {
			if (this.closed) {
				D('Ignoring attempt to write to closed file: %o', this);
				return;
			}
			if (this.raw) {
				D('Ignoring attempt to write object to raw file: %o', this);
				return;
			}
			this.writepipe.push(data);
			if (this.duplex) {
				this.duplex._kickreader();
			}
		},

		readbytes: function (len, cb) {
			if (!this.raw)
				throw 'Cannot readbytes from non-raw fd';
			if (this.reader)
				throw 'multiple readers?';
			this.reader = cb;
			this.readerlen = len;
			this._kickreader();
		},

		writebytes: function (buffer) {
			if (this.closed) {
				D('Ignoring attempt to write to closed file: %o', this);
				return;
			}
			if (!this.raw) {
				D('Ignoring attempt to write bytes to non-raw file: %o', this);
				return;
			}
			if (!buffer || !buffer.byteLength) {
				// kick the reader when writing 0 bytes
				this._kickreaders();
				return;
			}
			this.total.written += buffer.byteLength;
			var newbuf = new Uint8Array(this.writepipe.byteLength + buffer.byteLength);
			newbuf.set(this.writepipe);
			newbuf.set(buffer, this.writepipe.byteLength);
			this.writepipe = newbuf;
			if (this.duplex)
				this.duplex.readpipe = newbuf;
			else
				this.readpipe = newbuf;
			D('new buffer size: %d (fd:%d)', this.writepipe.byteLength, this.n);
			this._kickreaders();
		},

		cancelread: function (flushfirst) {
			if (flushfirst)
				this.flush();
			this.reader = null;
			this.readerlen = 0;
		},

		write_eof: function () {
			this.flush();
			// eof is only relevant for read-until-close readers
			if (this.raw && this.reader && this.readerlen === -1) {
				this.reader({ err: 'eof' });
			}
		},

		flush: function () {
			this._doread();
		},

		close: function () {
			if (this.closed)
				return;
			console.trace('Closing file %d: %o', this.n, this);
			this.closed = 'closed';
			if (this.duplex)
				this.duplex.close();
			// last kick to finish off any read-until-close readers
			this._kickreaders();
			// remove this entry from the cache
			remove_fd_from_cache(this);
		},

		_kickreaders: function () {
			if (this.duplex)
				this.duplex._kickreader();
			else
				this._kickreader();
		},

		_kickreader: function () {
			if (!this.reader) return;
			if (this.kickingreader) return;
			var t = this;
			t.kickingreader = setTimeout(function () {
				t.kickingreader = false;
				t._doreadcheckclose();
			}, 0);
		},

		_doreadcheckclose: function () {
			var cs = this.closed;
			this._doread();
			if (cs) {
				// they've had one last read - no more
				var rucreader = this.readerlen === -1;
				var rucreadercb = this.reader;
				this.reader = null;
				this.readerlen = 0;
				if (rucreader && rucreadercb) {
					// terminate the read-until-close reader
					D('terminating ruc reader. fd: %o', this);
					rucreadercb({ err: 'File closed' });
				}
			}
		},

		_doread: function () {
			if (this.raw) {
				if (!this.reader) return;
				if (this.readerlen > this.readpipe.byteLength) return;
				if (this.readerlen && !this.readpipe.byteLength) return;
				var cb = this.reader, len = this.readerlen;
				this.reader = null, this.readerlen = 0;
				var data;
				if (len) {
					var readlen = len > 0 ? len : this.readpipe.byteLength;
					data = this.readpipe.subarray(0, readlen);
					this.readpipe = this.readpipe.subarray(readlen);
					if (this.duplex)
						this.duplex.writepipe = this.readpipe;
					else
						this.writepipe = this.readpipe;
					this.total.read += readlen;
				} else {
					data = new Uint8Array(0);
				}

				data.asString = function () {
					return uint8ArrayToString(this);
				};
				data.intFromHex = function (len) {
					len = len || this.byteLength;
					var x = this.asString().slice(0, len);
					if (!/^[0-9a-fA-F]+/.test(x)) return -1;
					return parseInt(x, 16);
				}
				cb(null, data);

				if (len < 0) {
					// reset the reader
					this.readbytes(len, cb);
				}
				return;
			}
			if (this.reader && this.readpipe.length) {
				var cb = this.reader;
				this.reader = null;
				cb(this.readpipe.shift());
			}
		}
	}

	fdcache.push(fd);
	return fd;
}

var uint8ArrayToString = function (a) {
	var s = new Array(a.byteLength);
	for (var i = 0; i < a.byteLength; i++)
		s[i] = a[i];
	return String.fromCharCode.apply(String, s);
}

/**
 * Convert from an ArrayBuffer to a string.
 * @param {ArrayBuffer} buffer The array buffer to convert.
 * @return {string} The textual representation of the array.
 */
function arrayBufferToString(buffer) {
	var array = new Uint8Array(buffer);
	var str = '';
	for (var i = 0; i < array.length; ++i) {
		str += String.fromCharCode(array[i]);
	}
	return str;
};

/**
 * Convert a string to an ArrayBuffer.
 * @param {string} string The string to convert.
 * @return {ArrayBuffer} An array buffer whose bytes correspond to the string.
 */
var stringToArrayBuffer = exports.stringToArrayBuffer = function (string) {
	var buffer = new ArrayBuffer(string.length);
	var bufferView = new Uint8Array(buffer);
	for (var i = 0; i < string.length; i++) {
		bufferView[i] = string.charCodeAt(i);
	}
	return buffer;
};

function str2u8arr(s) {
	return new Uint8Array(stringToArrayBuffer(s));
}

function getutf8bytes(str) {
	var utf8 = [];
	for (var i = 0; i < str.length; i++) {
		var charcode = str.charCodeAt(i);
		if (charcode < 0x80) utf8.push(charcode);
		else if (charcode < 0x800) {
			utf8.push(0xc0 | (charcode >> 6),
				0x80 | (charcode & 0x3f));
		}
		else if (charcode < 0xd800 || charcode >= 0xe000) {
			utf8.push(0xe0 | (charcode >> 12),
				0x80 | ((charcode >> 6) & 0x3f),
				0x80 | (charcode & 0x3f));
		}
		// surrogate pair
		else {
			i++;
			// UTF-16 encodes 0x10000-0x10FFFF by
			// subtracting 0x10000 and splitting the
			// 20 bits of 0x0-0xFFFFF into two halves
			charcode = 0x10000 + (((charcode & 0x3ff) << 10)
				| (str.charCodeAt(i) & 0x3ff));
			utf8.push(0xf0 | (charcode >> 18),
				0x80 | ((charcode >> 12) & 0x3f),
				0x80 | ((charcode >> 6) & 0x3f),
				0x80 | (charcode & 0x3f));
		}
	}
	return utf8;
}

function fromutf8bytes(array) {
	var out, i, len, c;
	var char2, char3;

	out = "";
	len = array.length;
	i = 0;
	while (i < len) {
		c = array[i++];
		switch (c >> 4) {
			case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
				// 0xxxxxxx
				out += String.fromCharCode(c);
				break;
			case 12: case 13:
				// 110x xxxx   10xx xxxx
				char2 = array[i++];
				out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F));
				break;
			case 14:
				// 1110 xxxx  10xx xxxx  10xx xxxx
				char2 = array[i++];
				char3 = array[i++];
				out += String.fromCharCode(((c & 0x0F) << 12) |
					((char2 & 0x3F) << 6) |
					((char3 & 0x3F) << 0));
				break;
		}
	}

	return out;
}

exports.arraybuffer_concat = function () {
	var bufs = [], total = 0;
	for (var i = 0; i < arguments.length; i++) {
		var a = arguments[i];
		if (!a || !a.byteLength) continue;
		bufs.push(a);
		total += a.byteLength;
	}
	switch (bufs.length) {
		case 0: return new Uint8Array(0);
		case 1: return new Uint8Array(bufs[0]);
	}
	var res = new Uint8Array(total);
	for (var i = 0, j = 0; i < bufs.length; i++) {
		res.set(bufs[i], j);
		j += bufs[i].byteLength;
	}
	return res;
}

function remove_from_list(arr, item, searchfn) {
	if (!searchfn) searchfn = function (a, b) { return a === b; };
	for (var i = 0; i < arr.length; i++) {
		var found = searchfn(arr[i], item);
		if (found) {
			return {
				item: arr.splice(i, 1)[0],
				index: i,
			}
		}
	}
	D('Object %o not removed from list %o', item, arr);
}

function dumparr(arr, offset, count) {
	offset = offset || 0;
	count = count || (count === 0 ? 0 : arr.length);
	if (count > arr.length - offset)
		count = arr.length - offset;
	var s = '';
	while (count--) {
		s += ' ' + ('00' + arr[offset++].toString(16)).slice(-2);
	}
	return s.slice(1);
}

function btoa(arr) {
	return new Buffer(arr, 'binary').toString('base64');
}

function atob(base64) {
	return new Buffer(base64, 'base64').toString('binary');
}

module.exports = {
	arrayBufferToString,
	ab2str: arrayBufferToString,
	atob,
	btoa,
	dumparr,
	D,E,W,
	fromutf8bytes,
	getutf8bytes,
	intFromHex,
	intToHex,
	isEmptyObject,
	leftpad,
	remove_from_list,
	str2ab: stringToArrayBuffer,
	str2u8arr,
};
