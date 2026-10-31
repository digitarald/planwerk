import { EventEmitter } from "node:events";

const shared = globalThis as typeof globalThis & { __planwerkGoalEvents?: EventEmitter };
const events = shared.__planwerkGoalEvents ??= new EventEmitter();
events.setMaxListeners(0);

export const coordinatorGoalEvents = {
  publish(hostUrl: string) { events.emit("changed", hostUrl); },
  subscribe(listener: (hostUrl: string) => void) {
    events.on("changed", listener);
    return () => { events.off("changed", listener); };
  },
};
