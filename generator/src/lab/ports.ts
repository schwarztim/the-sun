/**
 * OS-assigned ("dynamic") port allocation for the Lab's harness and its
 * capture/mock backends. Binding port 0 and reading back the assigned port
 * is the standard Node.js way to get a free ephemeral port without a race
 * against another process — the OS won't hand out the same port again
 * until this process closes the listening socket.
 */
import net from "node:net";

export function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        srv.close(() => reject(new Error("failed to allocate a free port")));
      }
    });
  });
}
