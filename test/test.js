var assert = require('assert');
var telnet = require('../');
var net = require('net');

var client_responder = null;
var client = null;
var server = null;
var port = 1337;

describe('telnet', function () {
  it('should export a function', function () {
    assert.equal('function', typeof telnet);
  });

  describe('create server', function () {
    before(function (done) {
      server = telnet.createServer(function (c) {
        c.on('data', function (b) {
          c.write(b);
        });
      });
      server.listen(port);
      server.on('listening', function () {
        done();
      });
    });

    after(function (done) {
      client.end(function () {
        client = null;
        server.close(function () {
          server = null;
          done();
        });
      });
    });

    it('should be listening on port ' + port, function (done) {
      client = net.connect({port: port}, function () {
        done();
      });
    });

    it('should echo any data sent to it', function (done) {
      var stringToSend = 'test string';
      client.on('data', function (b) {
        b = b.toString('utf8');
        assert.equal(stringToSend, b);
        done();
      });

      client.write(stringToSend);
    });
  });
});
