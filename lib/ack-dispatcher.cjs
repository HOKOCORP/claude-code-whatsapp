function dispatchAck(status) {
  if (typeof status !== "number" || Number.isNaN(status)) return { event: null, target: null };
  switch (status) {
    case 0: return { event: "error",        target: "errored" };
    case 1: return { event: null,           target: null };
    case 2: return { event: "server_ack",   target: null };
    case 3: return { event: "delivery_ack", target: "acked" };
    case 4: return { event: "read",         target: "acked" };
    case 5: return { event: "played",       target: "acked" };
    default: return { event: null, target: null };
  }
}

module.exports = { dispatchAck };
