window.zmq = {};

(function(zmq) {
    "use strict"

    function pack_hu64(n) {
        bytes = [];
        for (let i = 0; i < 8; i++) {
            bytes.push(n & 0xff);
            n = n >>> 8;
        }

        bytes.reverse();
        return bytes;
    }

    function merge_arrays(a, b) {
        let c = new a.constructor(a.length + b.length);
        c.set(a);
        c.set(b, a.length);

        return c;
    }

    function arrays_equal(a, b) {
        if (a.byteLength != b.byteLength) {
            return false;
        }
        const ba = new Uint8Array(a);
        const bb = new Uint8Array(b);
        for (let i = 0; i < a.byteLength; i++) {
            if (ba[i] != bb[i]) {
                return false;
            }
        }
        return true;
    }

    function isIterable(obj) {
        // checks for null and undefined
        if (obj == null) {
            return false;
        }
        return typeof obj[Symbol.iterator] === 'function';
    }

    function to_bytes(s) {
        let bytes = []

        if (Number.isInteger(s) && s < 256) {
            return [s];
        }

        if (isIterable(s) || Array.isArray(s)) {
            for (let b of s) {
                if (Number.isInteger(b) && b < 256) {
                    bytes.push(b);
                } else {
                    bytes = [];
                    break;
                }
            }
        }

        if (bytes.length) {
            return bytes;
        }

        for (let c of s) {
            const b = c.charCodeAt(0);
            if (b < 256) {
                bytes.push(b);
            } else {
                bytes.concat([b & 0xff, b >>> 8]);
            }
        }

        return bytes;
    }

    function b(strings, ...literals) {
        let buffer = new Uint8Array([]);
        buffer = merge_arrays(buffer, to_bytes(strings[0]));
        literals.forEach((value, i) => {
            buffer = merge_arrays(buffer, to_bytes(value).concat(to_bytes(strings[i + 1])));
        });

        return buffer;
    }

    const text_decoder = new TextDecoder("utf-8");
    zmq.b2s = function(bs) {
        return text_decoder.decode(bs);
    }

    zmq.Client = function() {
        this._websocket = null;
        this._state = null;
        this._message_buffer = [];
        this._events_handlers = {
            'message': [],
            'connecting': [],
            'ready': [],
        };

        this.topics = []
        this.connected = false;
        this.uri = null;

        this.on('ready', this._subscribes);
    };

    zmq.Client.prototype = {
        open: function(uri) {
            this.uri = uri;
            if (this._websocket !== null) {
                throw 'Connection already open';
            }
            this._fire_event('connecting', this.uri);
            this._open();
        },

        close: function() {
            if (this._websocket) {
                this._websocket.close();
                this._websocket = null;
            }
        },

        subscribe: function(topic) {
            this.topics.push(topic);
            if (this.connected) {
                this._send_subscribe(topic);
            }
        },

        unsubscribe: function(topic) {
            this.topics.splice(this.topics.indexOf(topic), 1);
            if (this.connected) {
                this._send_subscribe(topic, true);
            }
        },

        on: function(event, callback) {
            this._events_handlers[event].push(callback);
        },

        _open: function() {
            this._websocket = new Websock();
            this._websocket.open(this.uri, 'binary');
            this._websocket.on('open', this._on_open.bind(this));
            this._websocket.on('close', this._on_close.bind(this));
            this._websocket.on('error', this._on_close.bind(this));
        },

        _fire_event: function(event, ...args) {
            for (let callback of this._events_handlers[event]) {
                try {
                    callback.apply(this, args);
                } catch (e) {
                    console.error(`Exception raised from "${event}" event handler: `, e);
                }
            }
        },

        // Transition to new state.
        _to_state: function(new_state, recv_size) {
            if (this._websocket.rQlen() >= recv_size) {
                new_state.call(this, recv_size);
            } else {
                this._websocket.on('message', () => {
                    if (this._websocket.rQlen() >= recv_size) {
                        new_state.call(this, recv_size);
                    }
                });
            }
        },

        // Handle new/closing connections.
        _on_open: function() {
            this._to_state(this._do_greeting, 10);
        },

        _on_close: function(e) {
            if (this._websocket !== null) {
                if (this.connected) {
                    console.error('Connection closed: ', e);
                    this._fire_event('connecting');
                }
                window.setTimeout(() => this._open(), 5000);
            }
            this.connected = false;
            this._websocket = null;
            this._state = null;
            this._message_buffer = new Uint8Array([]);
        },

        _on_error: function(e) {
            console.error('Error: ', e);
        },

        // Connections states.
        _do_greeting: function() {
            const partial_greeting = this._websocket.rQshiftBytes(10);
            if (partial_greeting[0] != 0xff ||
                partial_greeting[9] != 0x7f) {
                throw `Invalid greeting: ${partial_greeting}`;
            }

            this._websocket.send([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f])
            this._websocket.send([3, 0])

            this._to_state(this._do_version, 2);
        },

        _do_version: function() {
            const major_version = this._websocket.rQshift8();
            if (major_version != 3) {
                throw `Unsupported version: ${major_version}`;
            }

            const _minor_version = this._websocket.rQshift8();
            this._to_state(this._do_null_auth, 52);
        },

        _do_null_auth: function() {
            const mechanism = this._websocket.rQshiftStr(20).slice(0, 5);
            const as_server = this._websocket.rQshift8();
            const _filler = this._websocket.rQshiftBytes(31);
            if (mechanism !== "NULL\x00") {
                throw `Unsupported auth method: ${mechanism}`;
            } else if (as_server === 1) {
                throw `Expected zero value for as-server: ${as_server}`;
            }

            this._websocket.send_string("NULL");
            this._websocket.send(Array(48).fill(0));
            this._to_state(this._read_frame, 1);
        },

        _read_frame: function() {
            const flag = this._websocket.rQshift8();
            const command = flag & 0x4;
            const long_size = flag & 0x2;
            const more = flag & 0x1;

            const next = command ? this._read_command : this._read_message.bind(this, !more);
            const size = long_size ? 8 : 1;

            this._to_state(this._read_size.bind(this, !!long_size, next), size);
        },

        _read_size: function(long_size, next) {
            let size = null;
            if (long_size) {
                size = this._websocket.rQshift32();
                if (this._websocket.rQshift32() != 0) {
                    throw `Message size greater than 32 bits are unsupported`;
                }
            } else {
                size = this._websocket.rQshift8();
            }

            console.debug('Packet size: ', size)
            this._to_state(next, size);
        },

        _read_message: function(last, size) {
            const chunk = this._websocket.rQshiftBytes(size);
            this._message_buffer.push(chunk);
            if (last) {
                console.debug('Message: ', this._message_buffer);
                this._fire_event.apply(this, ['message'].concat(this._message_buffer));
                this._message_buffer = []
            } else {
                console.debug('Message chunk: ', chunk);
            }

            this._to_state(this._read_frame, 1);
        },

        _read_command: function(size) {
            if (size == 0) {
                throw 'Expected size greater than 0';
            }
            const command_name_size = this._websocket.rQshift8();

            if (size < command_name_size + 1) {
                throw `Expected size greater or equal than ${command_name_size + 1}`;
            }
            const command_name = this._websocket.rQshiftStr(command_name_size);
            let size_left = size - command_name_size - 1;
            let properties = {};
            while (size_left > 0) {
                const name_size = this._websocket.rQshift8();
                const name = this._websocket.rQshiftStr(name_size);
                const value_size = this._websocket.rQshift32();
                const value = this._websocket.rQshiftBytes(value_size);
                size_left -= 1 + name_size + 4 + value_size;
                properties[name] = value;

                if (size_left < 0) {
                    throw 'Invalid size';
                }
            }

            console.debug('Command: ', command_name, properties);
            if (command_name == 'READY') {
                this._on_null_ready(properties);
            } else if (command_name == 'ERROR') {
                this._on_null_error(properties);
            }

            this._to_state(this._read_frame, 1);
        },

        _on_null_ready: function(properties) {
            console.debug('Null READY: ', properties);
            if (!arrays_equal(properties['Socket-Type'], b `PUB`)) {
                throw 'Only PUB sockets are supported';
            }

            this._send_ready();
            this._fire_event('ready');
            this.connected = true;
        },

        _on_null_error: function(properties) {
            console.error('Authentication error: ', properties);
        },

        _send_frame: function(data, command, more) {
            let flags = 0;
            if (command) {
                flags |= 0x4;
            }

            let size = [data.length];
            if (data.length > 255) {
                flags |= 0x2;
                size = pack_hu64(data.length);
            }

            if (more) {
                flags |= 1;
            }

            console.debug('Sending frame: ', flags, size, data);
            this._websocket.send([flags]);
            this._websocket.send(size);
            this._websocket.send(data);
        },

        _send_ready: function() {
            this._send_frame(b `${5}READY${11}Socket-Type${[0,0,0,3]}SUB`, true);
        },

        _send_subscribe: function(topic, unsub) {
            if (unsub) {
                this._send_frame(b `${0}${topic}`, false, false);
            } else {
                this._send_frame(b `${1}${topic}`, false, false);
            }
        },

        _subscribes: function() {
            for (let topic of this.topics) {
                this._send_subscribe(topic);
            }
        },

    };

})(window.zmq);
