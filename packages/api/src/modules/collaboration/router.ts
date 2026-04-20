import { Router, Request, Response, NextFunction } from "express";
import { authMiddleware } from "../../middleware/auth";
import {
  UserPresence,
  CollaborationRoom,
  CollaborationEvent,
  PRESENCE_COLORS,
} from "@ai-company-os/core";

export const collaborationRouter = Router();
collaborationRouter.use(authMiddleware);

// ---------------------------------------------------------------------------
// In-memory presence store (per-tenant isolation)
// ---------------------------------------------------------------------------

/** tenantId -> userId -> UserPresence */
const presenceStore = new Map<string, Map<string, UserPresence>>();

/** roomId -> Set<userId> */
const roomMembers = new Map<string, Set<string>>();

/** roomId -> { resourceType, resourceId } */
const roomMeta = new Map<
  string,
  { resourceType: CollaborationRoom["resourceType"]; resourceId: string }
>();

/** roomId -> SSE response objects */
const sseClients = new Map<string, Set<Response>>();

/** tenantId -> recent CollaborationEvents (capped at 200) */
const activityFeed = new Map<string, CollaborationEvent[]>();

/** userId -> assigned color index (stable per session) */
const colorAssignments = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTenantPresence(tenantId: string): Map<string, UserPresence> {
  let m = presenceStore.get(tenantId);
  if (!m) {
    m = new Map();
    presenceStore.set(tenantId, m);
  }
  return m;
}

function assignColor(userId: string): string {
  let c = colorAssignments.get(userId);
  if (!c) {
    c = PRESENCE_COLORS[colorAssignments.size % PRESENCE_COLORS.length];
    colorAssignments.set(userId, c);
  }
  return c;
}

function broadcastToRoom(roomId: string, event: CollaborationEvent) {
  const clients = sseClients.get(roomId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

function pushActivity(tenantId: string, event: CollaborationEvent) {
  let feed = activityFeed.get(tenantId);
  if (!feed) {
    feed = [];
    activityFeed.set(tenantId, feed);
  }
  feed.unshift(event);
  if (feed.length > 200) feed.length = 200;
}

function parseRoomId(roomId: string): {
  resourceType: CollaborationRoom["resourceType"];
  resourceId: string;
} | null {
  const parts = roomId.split(":");
  if (parts.length !== 2) return null;
  const validTypes = ["company", "pipeline", "agent", "draft", "settings"];
  if (!validTypes.includes(parts[0])) return null;
  return {
    resourceType: parts[0] as CollaborationRoom["resourceType"],
    resourceId: parts[1],
  };
}

// ---------------------------------------------------------------------------
// Cleanup interval — mark idle/offline users every 15s
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [_tenantId, users] of presenceStore) {
    for (const [userId, presence] of users) {
      const elapsed = now - new Date(presence.lastSeen).getTime();
      if (elapsed > 90_000) {
        // Offline — remove from all rooms and delete presence
        for (const [roomId, members] of roomMembers) {
          if (members.has(userId)) {
            members.delete(userId);
            const event: CollaborationEvent = {
              type: "user_left",
              userId,
              roomId,
              data: { reason: "timeout" },
              timestamp: new Date().toISOString(),
            };
            broadcastToRoom(roomId, event);
            if (members.size === 0) {
              roomMembers.delete(roomId);
              roomMeta.delete(roomId);
            }
          }
        }
        users.delete(userId);
        colorAssignments.delete(userId);
      } else if (elapsed > 60_000 && presence.status === "online") {
        presence.status = "idle";
      }
    }
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /collaboration/presence — all online users in tenant
collaborationRouter.get(
  "/presence",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.auth!.tenantId;
      const users = getTenantPresence(tenantId);
      res.json(Array.from(users.values()));
    } catch (err) {
      next(err);
    }
  }
);

// POST /collaboration/presence/heartbeat — update current user's presence
collaborationRouter.post(
  "/presence/heartbeat",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = req.auth!;
      const { page, action, userName } = req.body as {
        page?: string;
        action?: string;
        userName?: string;
      };

      const users = getTenantPresence(tenantId);
      const existing = users.get(userId);

      const presence: UserPresence = {
        userId,
        userName: userName ?? existing?.userName ?? "User",
        avatarUrl: existing?.avatarUrl,
        color: assignColor(userId),
        currentPage: page ?? existing?.currentPage ?? "/",
        currentAction: action ?? existing?.currentAction,
        lastSeen: new Date().toISOString(),
        status: "online",
      };

      const pageMoved = existing && existing.currentPage !== presence.currentPage;
      users.set(userId, presence);

      // If the user moved pages, broadcast user_moved to rooms they are in
      if (pageMoved) {
        for (const [roomId, members] of roomMembers) {
          if (members.has(userId)) {
            const event: CollaborationEvent = {
              type: "user_moved",
              userId,
              roomId,
              data: {
                from: existing!.currentPage,
                to: presence.currentPage,
                action: presence.currentAction,
              },
              timestamp: presence.lastSeen,
            };
            broadcastToRoom(roomId, event);
            pushActivity(tenantId, event);
          }
        }
      }

      res.json(presence);
    } catch (err) {
      next(err);
    }
  }
);

// GET /collaboration/rooms/:roomId — get room participants
collaborationRouter.get(
  "/rooms/:roomId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.auth!.tenantId;
      const roomId = req.params.roomId as string;

      const members = roomMembers.get(roomId);
      const users = getTenantPresence(tenantId);
      const meta = roomMeta.get(roomId);

      const participants: UserPresence[] = [];
      if (members) {
        for (const uid of members) {
          const p = users.get(uid);
          if (p) participants.push(p);
        }
      }

      const room: CollaborationRoom = {
        roomId,
        participants,
        resourceType: meta?.resourceType ?? "company",
        resourceId: meta?.resourceId ?? roomId,
      };

      res.json(room);
    } catch (err) {
      next(err);
    }
  }
);

// GET /collaboration/rooms/:roomId/events — SSE stream
collaborationRouter.get(
  "/rooms/:roomId/events",
  (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // SSE comment to establish connection

    let clients = sseClients.get(roomId);
    if (!clients) {
      clients = new Set();
      sseClients.set(roomId, clients);
    }
    clients.add(res);

    // Send initial presence snapshot
    const members = roomMembers.get(roomId);
    const tenantId = req.auth!.tenantId;
    const users = getTenantPresence(tenantId);
    const participants: UserPresence[] = [];
    if (members) {
      for (const uid of members) {
        const p = users.get(uid);
        if (p) participants.push(p);
      }
    }
    res.write(`data: ${JSON.stringify({ type: "snapshot", participants })}\n\n`);

    // Heartbeat to keep connection alive
    const keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      clients?.delete(res);
      if (clients?.size === 0) sseClients.delete(roomId);
    });
  }
);

// POST /collaboration/rooms/:roomId/join — join a room
collaborationRouter.post(
  "/rooms/:roomId/join",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = req.auth!;
      const roomId = req.params.roomId as string;
      const { userName } = req.body as { userName?: string };

      // Parse and validate room ID
      const parsed = parseRoomId(roomId);

      // Ensure user has a presence entry
      const users = getTenantPresence(tenantId);
      if (!users.has(userId)) {
        users.set(userId, {
          userId,
          userName: userName ?? "User",
          color: assignColor(userId),
          currentPage: "/",
          lastSeen: new Date().toISOString(),
          status: "online",
        });
      }

      // Add to room
      let members = roomMembers.get(roomId);
      if (!members) {
        members = new Set();
        roomMembers.set(roomId, members);
      }
      members.add(userId);

      if (parsed) {
        roomMeta.set(roomId, {
          resourceType: parsed.resourceType,
          resourceId: parsed.resourceId,
        });
      }

      const event: CollaborationEvent = {
        type: "user_joined",
        userId,
        roomId,
        data: { userName: users.get(userId)!.userName },
        timestamp: new Date().toISOString(),
      };
      broadcastToRoom(roomId, event);
      pushActivity(tenantId, event);

      res.json({ joined: true, roomId, members: members.size });
    } catch (err) {
      next(err);
    }
  }
);

// POST /collaboration/rooms/:roomId/leave — leave a room
collaborationRouter.post(
  "/rooms/:roomId/leave",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, tenantId } = req.auth!;
      const roomId = req.params.roomId as string;

      const members = roomMembers.get(roomId);
      if (members) {
        members.delete(userId);
        if (members.size === 0) {
          roomMembers.delete(roomId);
          roomMeta.delete(roomId);
        }
      }

      const event: CollaborationEvent = {
        type: "user_left",
        userId,
        roomId,
        data: {},
        timestamp: new Date().toISOString(),
      };
      broadcastToRoom(roomId, event);
      pushActivity(tenantId, event);

      res.json({ left: true, roomId });
    } catch (err) {
      next(err);
    }
  }
);

// GET /collaboration/activity — recent collaboration activity feed
collaborationRouter.get(
  "/activity",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.auth!.tenantId;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const feed = activityFeed.get(tenantId) ?? [];
      res.json(feed.slice(0, limit));
    } catch (err) {
      next(err);
    }
  }
);
