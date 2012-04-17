
/**
 * Usage of node-telnet with node's REPL, in full-featured "terminal" mode.
 * (Requires node >= v0.7.7)
 */

var telnet = require('./')
  , repl = require('repl')

telnet.createServer(function (client) {

  client.on('window size', function (e) {
    console.error('window size:', e)
    if (e.command === 'sb') {
      // a real "resize" event; 'readline' listens for this
      client.columns = e.width
      client.rows = e.height
      client.emit('resize')
    } else {
      // 'will' or 'wont'
    }
  })

  // 'readline' will call `setRawMode` when it is a function
  client.setRawMode = function (mode) {
    if (!!mode) {
      client.do.suppress_go_ahead()
      client.will.suppress_go_ahead()
      client.will.echo()
    } else {
      client.dont.suppress_go_ahead()
      client.wont.suppress_go_ahead()
      client.wont.echo()
    }
  }

  // to have 'readline' autodetect the input for "terminal" mode
  client.isTTY = true

  // make unicode characters work properly
  client.do.transmit_binary()

  // emit 'window size' events
  client.do.window_size()

  // 'readline' will call this for us
  //client.setRawMode(true)

  // create the REPL
  var r = repl.start({
      input: client
    , output: client
    , prompt: 'telnet repl> '
    , useGlobal: false
  }).on('exit', function () {
    client.end()
  })

  r.context.r = r
  r.context.client = client
  r.context.socket = client

}).listen(1337)
