/**
 * Grab a free TCP port from the OS. Used by every test suite so two suites
 * (or a leftover dev server) can never collide on a hardcoded port — which
 * used to cause ghost failures like the smoke test asserting against a
 * stale server's database.
 */
const net = require("net");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
