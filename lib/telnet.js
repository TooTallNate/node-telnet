/**
 * Telnet server implementation.
 *
 * References:
 *  - http://tools.ietf.org/html/rfc854
 *  - http://support.microsoft.com/kb/231866
 *  - http://www.iana.org/assignments/telnet-options
 *
 */

/**
 * Modules
 */

var net = require('net')
  , assert = require('assert')
  , EventEmitter = require('events').EventEmitter
  , Stream = require('stream').Stream
  , util = require('util');

/**
 * Constants
 */

var COMMANDS = {
  SE:   240, // end of subnegotiation parameters
  NOP:  241, // no operation
  DM:   242, // data mark
  BRK:  243, // break
  IP:   244, // suspend (a.k.a. "interrupt process")
  AO:   245, // abort output
  AYT:  246, // are you there?
  EC:   247, // erase character
  EL:   248, // erase line
  GA:   249, // go ahead
  SB:   250, // subnegotiation
  WILL: 251, // will
  WONT: 252, // wont
  DO:   253, // do
  DONT: 254, // dont
  IAC:  255  // interpret as command
};

var COMMAND_NAMES = Object.keys(COMMANDS).reduce(function(out, key) {
  var value = COMMANDS[key];
  out[value] = key.toLowerCase();
  return out;
}, {});

var OPTIONS = {
  TRANSMIT_BINARY: 0,         // http://tools.ietf.org/html/rfc856
  ECHO: 1,                    // http://tools.ietf.org/html/rfc857
  SUPPRESS_GO_AHEAD: 3,       // http://tools.ietf.org/html/rfc858
  STATUS: 5,                  // http://tools.ietf.org/html/rfc859
  TIMING_MARK: 6,             // http://tools.ietf.org/html/rfc860
  TERMINAL_TYPE: 24,          // http://tools.ietf.org/html/rfc1091
  WINDOW_SIZE: 31,            // http://tools.ietf.org/html/rfc1073
  TERMINAL_SPEED: 32,         // http://tools.ietf.org/html/rfc1079
  REMOTE_FLOW_CONTROL: 33,    // http://tools.ietf.org/html/rfc1372
  TERMINAL_SPEED: 32,         // http://tools.ietf.org/html/rfc1079
  REMOTE_FLOW_CONTROL: 33,    // http://tools.ietf.org/html/rfc1372
  LINEMODE: 34,               // http://tools.ietf.org/html/rfc1184
  X_DISPLAY_LOCATION: 35,     // http://tools.ietf.org/html/rfc1096
  AUTHENTICATION: 37,         // http://tools.ietf.org/html/rfc2941
  ENVIRONMENT_VARIABLES: 39   // http://tools.ietf.org/html/rfc1572
};

var OPTION_NAMES = Object.keys(OPTIONS).reduce(function(out, key) {
  var value = OPTIONS[key];
  out[value] = key.toLowerCase();
  return out;
}, {});

/**
 * Client
 */

function Client(input, output, server) {
  var self = this;

  if (!(this instanceof Client)) {
    return new Client(input, output, server);
  }

  if (!output) {
    output = input;
    this.socket = input;
  }

  this.input = input;
  this.output = output;
  this.server = server;

  this.open();
}

Client.prototype.__proto__ = Stream.prototype;

Client.prototype.debug = function() {
  var args = Array.prototype.slice.call(arguments)
    , msg;

  if (this.listeners('debug').length) {
    msg = util.format.apply(util.format, args);
    this.emit('debug', msg);
  }

  if (this.server && this.server.listeners('debug').length) {
    args.push('(' + this.input.remoteAddress + ')');
    msg = util.format.apply(util.format, args);
    this.server.emit('debug', msg);
  }
};

Client.prototype.open = function() {
  var self = this;

  ['DO', 'DONT', 'WILL', 'WONT'].forEach(function(commandName) {
    self[commandName.toLowerCase()] = {};
    Object.keys(OPTIONS).forEach(function(optionName) {
      var optionCode = OPTIONS[optionName];
      self[commandName.toLowerCase()][optionName.toLowerCase()] = function() {
        var buf = new Buffer(3);
        buf[0] = COMMANDS.IAC;
        buf[1] = COMMANDS[commandName];
        buf[2] = optionCode;
        return self.output.write(buf);
      }
    });
  });

  this.input.on('end', function() {
    self.emit('end');
  });

  this.input.on('close', function() {
    self.emit('close');
  });

  this.input.on('drain', function() {
    self.emit('drain');
  });

  this.input.on('error', function(err) {
    self.emit('error', err);
  });

  this.input.on('data', function(data) {
    self.parse(data);
  });
};

Client.prototype.parse = function(data) {
  var bufs = []
    , i = 0
    , l = 0
    , needsPush = false
    , cdata
    , iacCode
    , iacName
    , commandCode
    , commandName
    , optionCode
    , optionName
    , cmd
    , len;

  if (this._last) {
    data = Buffer.concat([this._last.data, data]);
    i = this._last.i;
    l = this._last.l;
    delete this._last;
  }

  for (; i < data.length; i++) {
    if (data.length - 1 - i >= 2
        && data.readUInt8(i) === COMMANDS.IAC
        && COMMAND_NAMES[data.readUInt8(i + 1)]
        && OPTION_NAMES[data.readUInt8(i + 2)]) {
      cdata = data.slice(i);

      iacCode = cdata.readUInt8(0);
      iacName = COMMAND_NAMES[iacCode];
      commandCode = cdata.readUInt8(1);
      commandName = COMMAND_NAMES[commandCode];
      optionCode = cdata.readUInt8(2);
      optionName = OPTION_NAMES[optionCode];

      cmd = {
        command: commandName, // compat
        option: optionName.replace(/_/g, ' '), // compat
        iacCode: iacCode,
        iacName: iacName,
        commandCode: commandCode,
        commandName: commandName,
        optionCode: optionCode,
        optionName: optionName,
        data: cdata
      };

      if (this[cmd.optionName]) {
        try {
          len = this[cmd.optionName](cmd);
        } catch (e) {
          if (!(e instanceof RangeError)) {
            throw e;
          }
          len = -1;
          this.debug('Not enough data to parse.');
        }
      } else {
        if (cmd.commandCode === COMMANDS.SB) {
          len = 0;
          while (cdata[len] && cdata[len] !== COMMANDS.SE) {
            len++;
          }
          if (!cdata[len]) {
            len = 3;
          }
        } else {
          len = 3;
        }
        cmd.data = cmd.data.slice(0, len);
        this.debug('Unknown option: %s', cmd.optionName);
      }

      if (len === -1) {
        this.debug('Waiting for more data.');
        this.debug(iacName, commandName, optionName, cmd.values || len);
        this._last = {
          data: data,
          i: i,
          l: l
        };
        return;
      }

      this.debug(iacName, commandName, optionName, cmd.values || len);

      this.emit('command', cmd);

      needsPush = true;
      l = i + len;
      i += len - 1;
    } else {
      if (needsPush || i === data.length - 1) {
        bufs.push(data.slice(l, i + 1));
        needsPush = false;
      }
    }
  }

  if (bufs.length) {
    this.emit('data', Buffer.concat(bufs));
  }
};

Client.prototype.echo = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('echo', cmd);
  return 3;
};

Client.prototype.status = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('status', cmd);
  return 3;
};

Client.prototype.linemode = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('linemode', cmd);
  return 3;
};

Client.prototype.transmit_binary = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('transmit binary', cmd); // compat
  this.emit('binary', cmd);
  return 3;
};

Client.prototype.authentication = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('authentication', cmd);
  return 3;
};

Client.prototype.terminal_speed = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('terminal speed', cmd); // compat
  this.emit('speed', cmd);
  return 3;
};

Client.prototype.remote_flow_control = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('remote flow control', cmd); // compat
  this.emit('flow', cmd);
  return 3;
};

Client.prototype.x_display_location = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('x display location', cmd); // compat
  this.emit('location', cmd);
  return 3;
};

Client.prototype.suppress_go_ahead = function(cmd) {
  if (cmd.data.length < 3) return -1;
  cmd.data = cmd.data.slice(0, 3);
  this.emit('suppress go ahead', cmd); // compat
  this.emit('goahead', cmd);
  return 3;
};

Client.prototype.window_size = function(cmd) {
  var data = cmd.data;
  var i = 0;

  if (cmd.commandCode !== COMMANDS.SB) {
    if (data.length < 3) return -1;
    cmd.data = cmd.data.slice(0, 3);
    this.emit('window size', cmd); // compat
    return 3;
  }

  if (data.length < 9) return -1;

  var iac1 = data.readUInt8(i);
  i += 1;
  var sb = data.readUInt8(i);
  i += 1;
  var naws = data.readUInt8(i);
  i += 1;
  var width = data.readUInt16BE(i);
  i += 2;
  var height = data.readUInt16BE(i);
  i += 2;
  var iac2 = data.readUInt8(i);
  i += 1;
  var se = data.readUInt8(i);
  i += 1;

  assert(iac1 === COMMANDS.IAC);
  assert(sb === COMMANDS.SB);
  assert(naws === OPTIONS.WINDOW_SIZE);
  assert(iac2 === COMMANDS.IAC);
  assert(se === COMMANDS.SE);

  cmd.cols = width;
  cmd.columns = width;
  cmd.width = width;
  cmd.rows = height;
  cmd.height = height;

  cmd.values = [width, height];

  cmd.data = cmd.data.slice(0, i);

  this.emit('window size', cmd); // compat
  this.emit('size', cmd);

  return i;
};

Client.prototype.environment_variables = function(cmd) {
  var data = cmd.data;
  var i = 0;

  if (cmd.commandCode !== COMMANDS.SB) {
    if (data.length < 3) return -1;
    cmd.data = cmd.data.slice(0, 3);
    this.emit('environment variables', cmd); // compat
    return 3;
  }

  if (data.length < 10) return -1;

  var iac1 = data.readUInt8(i);
  i += 1;
  var sb = data.readUInt8(i);
  i += 1;
  var newenv = data.readUInt8(i);
  i += 1;
  var send = data.readUInt8(i);
  i += 1;
  var variable = data.readUInt8(i);
  i += 1;

  var name;
  for (var s = i; i < data.length; i++) {
    if (data[i] === 1) {
      name = data.toString('ascii', s, i);
      i++;
      break;
    }
  }

  var value;
  for (var s = i; i < data.length; i++) {
    if (data[i] === 255) {
      value = data.toString('ascii', s, i);
      break;
    }
  }

  var iac2 = data.readUInt8(i);
  i += 1;
  var se = data.readUInt8(i);
  i += 1;

  assert(iac1 === COMMANDS.IAC);
  assert(sb === COMMANDS.SB);
  assert(newenv === OPTIONS.ENVIRONMENT_VARIABLES);
  assert(send === 0x02);
  assert(variable === 0x03 || variable === 0x00);
  assert(name.length > 0);
  assert(value.length > 0);
  assert(iac2 === COMMANDS.IAC);
  assert(se === COMMANDS.SE);

  cmd.name = name;
  cmd.value = value;

  // Always uppercase for some reason.
  if (cmd.name === 'TERM') {
    cmd.value = cmd.value.toLowerCase();
  }

  cmd.values = [name, value];

  cmd.data = cmd.data.slice(0, i);

  this.emit('environment variables', cmd); // compat
  this.emit('env', cmd);

  return i;
};

Client.prototype.terminal_type = function(cmd) {
  var data = cmd.data;
  var i = 0;

  if (cmd.commandCode !== COMMANDS.SB) {
    if (data.length < 3) return -1;
    cmd.data = cmd.data.slice(0, 3);
    this.emit('terminal type', cmd); // compat
    if (cmd.commandCode === COMMANDS.WILL) {
      this.output.write(new Buffer([
        COMMANDS.IAC,
        COMMANDS.SB,
        OPTIONS.TERMINAL_TYPE,
        1, // SEND
        COMMANDS.IAC,
        COMMANDS.SE
      ]));
    }
    return 3;
  }

  if (data.length < 7) return -1;

  var iac1 = data.readUInt8(i);
  i += 1;
  var sb = data.readUInt8(i);
  i += 1;
  var termtype = data.readUInt8(i);
  i += 1;
  var is = data.readUInt8(i);
  i += 1;

  var name;
  for (var s = i; i < data.length; i++) {
    if (data[i] === 255) {
      name = data.toString('ascii', s, i);
      break;
    }
  }

  var iac2 = data.readUInt8(i);
  i += 1;
  var se = data.readUInt8(i);
  i += 1;

  assert(iac1 === COMMANDS.IAC);
  assert(sb === COMMANDS.SB);
  assert(termtype === OPTIONS.TERMINAL_TYPE);
  assert(is === 0x00);
  assert(name.length > 0);
  assert(iac2 === COMMANDS.IAC);
  assert(se === COMMANDS.SE);

  // Always uppercase for some reason.
  cmd.name = name.toLowerCase();

  cmd.values = [cmd.name];

  cmd.data = cmd.data.slice(0, i);

  this.emit('terminal type', cmd); // compat
  this.emit('term', cmd);

  return i;
};

Client.prototype.__defineGetter__('readable', function() {
  return this.input.readable;
});

Client.prototype.__defineGetter__('writable', function() {
  return this.output.writable;
});

Client.prototype.__defineGetter__('destroyed', function() {
  return this.output.destroyed;
});

Client.prototype.pause = function() {
  return this.input.pause.apply(this.output, arguments);
}

Client.prototype.resume = function() {
  return this.input.resume.apply(this.output, arguments);
}

Client.prototype.write = function(b) {
  return this.output.write.apply(this.output, arguments);
};

Client.prototype.end = function() {
  return this.output.end.apply(this.output, arguments);
};

Client.prototype.destroy = function() {
  return this.output.destroy.apply(this.output, arguments);
};

Client.prototype.destroySoon = function() {
  return this.output.destroySoon.apply(this.output, arguments);
};

/**
 * Server
 */

function Server(callback) {
  var self = this;

  if (!(this instanceof Server)) {
    return new Server(callback);
  }

  this.server = net.createServer(function(socket) {
    var client = new Client(socket, null, self);
    self.emit('connection', client);
    self.emit('client', client);
    if (callback) {
      callback(client);
    }
  });

  return this;
}

Server.prototype.__proto__ = EventEmitter.prototype;

Object.keys(net.Server.prototype).forEach(function(key) {
  var value = net.Server.prototype[key];
  if (typeof value !== 'function') return;
  Server.prototype[key] = function() {
    return this.server[key].apply(this.server, arguments);
  };
}, this);

/**
 * Telnet
 */

function Telnet(input, output) {
  if ((!input || typeof input === 'function') && !output) {
    return new Server(input);
  }
  return new Client(input, output);
}

/**
 * Expose
 */

exports = Telnet;
exports.Client = Client;
exports.Server = Server;
exports.createServer = Server;

exports.COMMANDS = COMMANDS;
exports.COMMAND_NAMES = COMMAND_NAMES;
exports.OPTIONS = OPTIONS;
exports.OPTION_NAMES = OPTION_NAMES;

module.exports = exports;
