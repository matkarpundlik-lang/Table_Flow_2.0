import type { Response } from 'express';

interface SseClient {
  id: string;
  restaurantId: number;
  tableId?: number;
  res: Response;
}

const clients = new Map<string, SseClient>();

export function registerSseClient(
  id: string,
  restaurantId: number,
  res: Response,
  tableId?: number,
) {
  clients.set(id, { id, restaurantId, tableId, res });
}

export function removeSseClient(id: string) {
  clients.delete(id);
}

export function broadcastToRestaurant(
  restaurantId: number,
  event: string,
  data: Record<string, unknown>,
  targetTableId?: number,
) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, ts: Date.now() })}\n\n`;
  for (const client of clients.values()) {
    if (client.restaurantId !== restaurantId) continue;
    if (client.tableId && targetTableId && client.tableId !== targetTableId) continue;
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client.id);
    }
  }
}
