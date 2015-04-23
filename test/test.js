var assert = require('assert');
var telnet = require('../');
var net = require('net');
var buffer = require('buffer');

var clientToServer;
var serverToClient;
var server;
var port = 1337;

describe('telnet', function () {
  it('should export a function', function () {
    assert.equal('function', typeof telnet);
  });

  describe('create server', function () {
    beforeEach(function (done) {
      server = telnet.createServer(function (c) {
        serverToClient = c;
        done();
      });
      server.on('listening', function () {
        clientToServer = net.connect({port: port}, function () {
          // we will detect this via above connection to server.
        });
      });
      server.listen(port);
    });

    afterEach(function (done) {
      clientToServer.end(function () {
        clientToServer = null;
        server.close(function () {
          server = null;
          done();
        });
      });
    });

    it('should echo any data sent to it', function (done) {
      var stringToSend = 'test string';

      serverToClient.on('data', function (b) {
        serverToClient.write(b);
      });

      clientToServer.on('data', function (b) {
        b = b.toString('utf8');
        assert.equal(stringToSend, b);
        done();
      });

      clientToServer.write(stringToSend);
    });

    it('should capture window size events with no arguments', function (done) {
      serverToClient.on('window size', function (b) {
        assert.equal(b.command, 'do');
        assert.equal(b.data, null);
        done();
      });

      // IAC DO NAWS
      clientToServer.write(new buffer.Buffer([0xFF, 0xFD, 0x1F]));
    });
  });
});
