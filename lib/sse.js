const sseClients = [];

export function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function addSseClient(req, res, clerkId) {
  const client = { req, res, clerkId };
  sseClients.push(client);

  req.on("close", () => {
    const index = sseClients.indexOf(client);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
}

export function broadcastBalanceUpdate(clerkId, data) {
  sseClients.slice().forEach((client) => {
    if (client.clerkId !== clerkId) return;
    try {
      sendSseEvent(client.res, "balance-update", data);
    } catch (error) {
      const index = sseClients.indexOf(client);
      if (index !== -1) {
        sseClients.splice(index, 1);
      }
    }
  });
}
