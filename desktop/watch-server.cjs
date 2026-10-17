const path = require("node:path");
const { spawn } = require("node:child_process");

const parentPid = Number(process.env.PLANWERK_PARENT_PID);
if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
  throw new Error("A valid desktop parent PID is required");
}
let stopping = false;
function stopGroup() {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  // Stay alive independently of Next's shutdown handler to reap stubborn children.
  setTimeout(() => process.kill(-process.pid, "SIGKILL"), 3000);
  process.kill(-process.pid, "SIGTERM");
}
process.on("SIGTERM", stopGroup);
process.on("SIGINT", stopGroup);

const watchdog = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error("[desktop:watchdog]", error);
      return;
    }
    console.error("[desktop:watchdog] Shell exited; stopping owned process group");
    stopGroup();
  }
}, 2000).unref();

const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  stdio: "inherit",
  env: process.env,
});
server.on("error", (error) => {
  console.error("[desktop:server]", error);
  stopGroup();
});
server.on("exit", (code, signal) => {
  if (!stopping) console.error("[desktop:server] Server exited", signal ?? code);
  stopGroup();
});
