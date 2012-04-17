
/**
 * Telnet server implementation.
 *
 * References:
 *  - http://support.microsoft.com/kb/231866
 *
 */

var net = require('net')
  , assert = require('assert')
  , debug = require('debug')('telnet')
  , Stream = require('stream')
  , Buffers = require('buffers')
  , Binary = require('binary')

var COMMANDS = {
    SE:  240 // end of subnegotiation parameters
  , NOP: 241 // no operation
  , DM:  242 // data mark
  , BRK: 243 // break
  , IP:  244 // suspend (a.k.a. "interrupt process")
  , AO:  245 // abort output
  , AYT: 246 // are you there?
  , EC:  247 // erase character
  , EL:  248 // erase line
  , GA:  249 // go ahead
  , SB:  250 // subnegotiation
  , WILL:251 // will
  , WONT:252 // wont
  , DO:  253 // do
  , DONT:254 // dont
  , IAC: 255 // interpret as command
}

var OPTIONS = {
    TRANSMIT_BINARY: 0         // http://tools.ietf.org/html/rfc856
  , ECHO: 1                    // http://tools.ietf.org/html/rfc857
  , SUPPRESS_GO_AHEAD: 3       // http://tools.ietf.org/html/rfc858
  , STATUS: 5                  // http://tools.ietf.org/html/rfc859
  , TIMING_MARK: 6             // http://tools.ietf.org/html/rfc860
  , TERMINAL_TYPE: 24          // http://tools.ietf.org/html/rfc1091
  , WINDOW_SIZE: 31            // http://tools.ietf.org/html/rfc1073
  , TERMINAL_SPEED: 32         // http://tools.ietf.org/html/rfc1079
  , REMOTE_FLOW_CONTROL: 33    // http://tools.ietf.org/html/rfc1372
  , LINEMODE: 34               // http://tools.ietf.org/html/rfc1184
  , ENVIRONMENT_VARIABLES: 39  // http://tools.ietf.org/html/rfc1572
}

var IAC_BUF = new Buffer([ COMMANDS.IAC ])

var COMMAND_NAMES = Object.keys(COMMANDS).reduce(function (names, name) {
  names[COMMANDS[name]] = name.toLowerCase()
  return names
}, {})

var OPTION_NAMES = Object.keys(OPTIONS).reduce(function (names, name) {
  names[OPTIONS[name]] = name.toLowerCase().replace(/_/g, ' ')
  return names
}, {})





var COMMAND_IMPLS = {}
;['do','dont','will','wont'].forEach(function (command) {
  var code = COMMANDS[command.toUpperCase()]
  COMMAND_IMPLS[code] = function (bufs, i, event) {
    // needs to read 1 byte, for the command
    //console.error(command, bufs)
    if (bufs.length < (i+1)) return MORE
    return parseOption(bufs, i, event)
  }
})

// subnegotiation
COMMAND_IMPLS[COMMANDS.SB] = function (bufs, i, event) {
  return parseOption(bufs, i, event)
}

// IAC
//   this will happen in "binary" mode, two IAC bytes needs to be translated
//   into 1 "data" event with a 1-length Buffer of value 255.
COMMAND_IMPLS[COMMANDS.IAC] = function (bufs, i, event) {
  event.buf = bufs.splice(0, i).toBuffer()
  event.data = event.buf.splice(1)
  return event
}




var OPTION_IMPLS = {}
// these ones don't take any arguments
OPTION_IMPLS[OPTIONS.ECHO] =
OPTION_IMPLS[OPTIONS.TRANSMIT_BINARY] =
OPTION_IMPLS[OPTIONS.SUPPRESS_GO_AHEAD] = function (bufs, i, event) {
  event.buf = bufs.splice(0, i).toBuffer()
  return event
}

OPTION_IMPLS[OPTIONS.WINDOW_SIZE] = function (bufs, i, event) {
  if (event.commandCode !== COMMANDS.SB) {
    event.buf = bufs.splice(0, i).toBuffer()
  } else {
    // receiving a "resize" event
    if (bufs.length < 9) return MORE
    event.buf = bufs.splice(0, 9).toBuffer()
    Binary.parse(event.buf)
      .word8('iac1')
      .word8('sb')
      .word8('naws')
      .word16bu('width')
      .word16bu('height')
      .word8('iac2')
      .word8('se')
      .tap(function (vars) {
        //console.error(vars)
        assert(vars.iac1 === COMMANDS.IAC)
        assert(vars.iac2 === COMMANDS.IAC)
        assert(vars.sb === COMMANDS.SB)
        assert(vars.se === COMMANDS.SE)
        assert(vars.naws === OPTIONS.WINDOW_SIZE)
        event.width = vars.width
        event.height = vars.height
      })
  }
  //console.error('window size:', event, bufs)
  return event
}




var MORE = -123132

function parse(bufs) {
  assert(bufs.length >= 2) // IAC byte and whatever follows it
  assert(bufs.get(0) === COMMANDS.IAC)
  return parseCommand(bufs, 1, {})
}

function parseCommand (bufs, i, event) {
  var command = bufs.get(i)
  event.commandCode = command
  event.command = COMMAND_NAMES[command]
  return COMMAND_IMPLS[command](bufs, i + 1, event)
}

function parseOption (bufs, i, event) {
  var option = bufs.get(i)
  event.optionCode = option
  event.option = OPTION_NAMES[option]
  return OPTION_IMPLS[option](bufs, i + 1, event)
}





net.createServer(function (socket) {

  // user API
  var client = new Stream
  client.pipe(socket)

  client.on('data', function (b) {
    console.error(0, 'client data:', b, b.toString())
  })

  client.on('event', function (event) {
    console.error('client "%s" event:', event.option, event)
  })

  client.on('end', function () {
    console.error('client "end" event:')
  })






  var bufs = Buffers()

  // proxy "end"
  socket.on('end', function () {
    client.emit('end')
  })

  socket.on('data', function (b) {
    debug('incoming "data" event', b, b.toString('utf8'))
    bufs.push(b)

    var i
    while ((i = bufs.indexOf(IAC_BUF)) >= 0) {
      assert(bufs.length > (i+1))
      if (i > 0) {
        var data = bufs.splice(0, i).toBuffer()
        client.emit('data', data)
      }
      i = parse(bufs)
      if (i === MORE) {
        debug('need to wait for more...')
        break
      } else {
        client.emit('event', i)
        client.emit(i.command, i)
        if (i.option) {
          client.emit(i.option, i)
        }
        if (i.data) {
          client.emit('data', i.data)
        }
      }
    }
    if (i !== MORE && bufs.length > 0) {
      // we got regular data!
      var data = bufs.splice(0).toBuffer()
      client.emit('data', data)
    }
  })

  var sga = Buffer(3)
  sga[0] = COMMANDS.IAC
  sga[1] = COMMANDS.DO
  sga[2] = OPTIONS.SUPPRESS_GO_AHEAD
  debug('sending DO "suppress go ahead" command:', sga)
  socket.write(sga)

  var sga = Buffer(3)
  sga[0] = COMMANDS.IAC
  sga[1] = COMMANDS.DO
  sga[2] = OPTIONS.TRANSMIT_BINARY
  debug('sending DO "suppress go ahead" command:', sga)
  socket.write(sga)

  var naws = Buffer(3)
  naws[0] = COMMANDS.IAC
  naws[1] = COMMANDS.DO
  naws[2] = OPTIONS.WINDOW_SIZE
  debug('sending DO "negotiate about window size" command:', naws)
  socket.write(naws)

  var echo = Buffer(3)
  echo[0] = COMMANDS.IAC
  echo[1] = COMMANDS.WILL
  echo[2] = OPTIONS.ECHO
  debug('sending WILL "echo" command:', echo)
  socket.write(echo)

  var sga = Buffer(3)
  sga[0] = COMMANDS.IAC
  sga[1] = COMMANDS.WILL
  sga[2] = OPTIONS.SUPPRESS_GO_AHEAD
  debug('sending WILL "suppress go ahead" command:', sga)
  socket.write(sga)

}).listen(1337)
