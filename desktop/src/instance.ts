import { createConnection, createServer, type Server } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";

function notifyExisting(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path);
    let reply = "";
    client.setTimeout(2000);
    client.on("connect", () => client.end("activate"));
    client.on("data", (data) => {
      reply += data.toString();
      if (reply === "ok") resolve(true);
    });
    client.on("timeout", () => client.destroy(new Error("Existing Planwerk is not responding")));
    client.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    client.on("end", () => {
      if (reply !== "ok") reject(new Error("Existing Planwerk did not acknowledge activation"));
    });
  });
}

export async function claimInstance(path: string, activate: () => void): Promise<Server | null> {
  const server = createServer({ allowHalfOpen: true }, (client) => {
    client.setTimeout(2000, () => client.destroy());
    let command = "";
    client.on("data", (data) => {
      command += data.toString();
      if (command.length > 32) client.destroy();
    });
    client.on("end", () => {
      if (command === "activate") {
        activate();
        client.end("ok");
      } else client.end();
    });
    client.on("error", (error) => console.warn("[desktop:instance]", error.message));
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const previous = await lstat(path);
    if (!previous.isSocket()) throw new Error(`Refusing to replace non-socket: ${path}`);
    if (await notifyExisting(path)) return null;
    const current = await lstat(path);
    if (previous.ino !== current.ino) throw new Error("Another Planwerk instance is starting; retry launch");
    await unlink(path);
    await listen();
  }
  await chmod(path, 0o600);
  server.on("error", (error) => console.error("[desktop:instance]", error));
  return server;
}
