
/**
 * Telnet server implementation.
 *
 * References:
 *  - http://support.microsoft.com/kb/231866
 *
 */

var net = require('net')
  , Stream = require('stream')
  , assert = require('assert')
  , Buffers = require('buffers')
  , Binary = require('binary')

/*var CONTROL = {
    NUL: 0 // null
  , BEL: 7 // bell
  , BS:  8 // backspace
  , HT:  9 // horizontal tab
  , LF: 10 // line feed
  , VT: 11 // vertical tab
  , FF: 12 // form feed
  , CR: 13 // carriage return
}*/

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
    TRANSMIT_BINARY: 0
  , ECHO: 1
  , SUPPRESS_GO_AHEAD: 3
  , STATUS: 5
  , TIMING_MARK: 6
  , TERMINAL_TYPE: 24
  , WINDOW_SIZE: 31
  , TERMINAL_SPEED: 32
  , REMOTE_FLOW_CONTROL: 33
  , LINEMODE: 34
  , ENVIRONMENT_VARIABLES: 36
}

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




var OPTION_IMPLS = {}
OPTION_IMPLS[OPTIONS.ECHO] = function (bufs, i, event) {
  event.buf = bufs.splice(0, i).toBuffer()
  //console.error('echo:', event, bufs)
  return event
}
OPTION_IMPLS[OPTIONS.SUPPRESS_GO_AHEAD] = function (bufs, i, event) {
  event.buf = bufs.splice(0, i).toBuffer()
  //console.error('suppress go ahead:', event, bufs)
  return event
}
OPTION_IMPLS[OPTIONS.WINDOW_SIZE] = function (bufs, i, event) {
  if (event.commandCode === COMMANDS.WILL) {
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

  client.on('echo', function (event) {
    console.error('client echo event:', event)
  })

  client.on('window size', function (event) {
    console.error('client "window size" event:', event)
  })

  client.on('suppress go ahead', function (event) {
    console.error('client SGA event:', event)
  })

  client.on('end', function () {
    console.error('client "end" event:')
  })






  console.error('socket connected')

  var bufs = Buffers()
  var iacbuf = new Buffer([ COMMANDS.IAC ])

  socket.on('end', function () {
    client.emit('end')
  })

  socket.on('data', function (b) {
    console.error(0, 'data', b, b.length, b.toString('utf8'))
    bufs.push(b)

    var i
    while ((i = bufs.indexOf(iacbuf)) >= 0) {
      //console.error('got IAC byte at index', i)
      assert(bufs.length > (i+1))
      if (i > 0) {
        var data = bufs.splice(0, i).toBuffer()
        client.emit('data', data)
        //console.error(0, 'regular data', data)
      }
      i = parse(bufs)
      if (i === MORE) {
        console.error('need to wait for more...')
        break
      } else {
        //console.error('parse() result:', i)
        client.emit('event', i)
        client.emit(i.command, i)
        client.emit(i.option, i)
      }
    }
    if (i !== MORE && bufs.length > 0) {
      // we got regular data!
      var data = bufs.splice(0).toBuffer()
      client.emit('data', data)
      //console.error(0, 'regular data', data)
    }
  })

  var sga = Buffer(3)
  sga[0] = COMMANDS.IAC
  sga[1] = COMMANDS.DO
  sga[2] = OPTIONS.SUPPRESS_GO_AHEAD
  console.error('sending DO "suppress go ahead" command:', sga)
  socket.write(sga)

  var naws = Buffer(3)
  naws[0] = COMMANDS.IAC
  naws[1] = COMMANDS.DO
  naws[2] = OPTIONS.WINDOW_SIZE
  console.error('sending DO "negotiate about window size" command:', naws)
  socket.write(naws)

  var echo = Buffer(3)
  echo[0] = COMMANDS.IAC
  echo[1] = COMMANDS.WILL
  echo[2] = OPTIONS.ECHO
  console.error('sending WILL "echo" command:', echo)
  socket.write(echo)

  socket.once('data', function (b) {
    var sga = Buffer(3)
    sga[0] = COMMANDS.IAC
    sga[1] = COMMANDS.WILL
    sga[2] = OPTIONS.SUPPRESS_GO_AHEAD
    console.error('sending WILL "suppress go ahead" command:', sga)
    socket.write(sga)

    /*var echo = Buffer(3)
    echo[0] = COMMANDS.IAC
    echo[1] = COMMANDS.DO
    echo[2] = OPTIONS.ECHO
    console.error('sending DO "echo" command:', echo)
    socket.write(echo)*/
  })

}).listen(1337)
