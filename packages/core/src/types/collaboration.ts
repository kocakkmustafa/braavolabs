export interface UserPresence {
  userId: string;
  userName: string;
  avatarUrl?: string;
  color: string;
  currentPage: string;
  currentAction?: string;
  lastSeen: string;
  status: "online" | "idle" | "offline";
}

export interface CollaborationRoom {
  roomId: string;
  participants: UserPresence[];
  resourceType: "company" | "pipeline" | "agent" | "draft" | "settings";
  resourceId: string;
}

export interface CollaborationEvent {
  type:
    | "user_joined"
    | "user_left"
    | "user_moved"
    | "user_action"
    | "resource_updated";
  userId: string;
  roomId: string;
  data: Record<string, any>;
  timestamp: string;
}

export const PRESENCE_COLORS = [
  "#00d1ff",
  "#6d11ad",
  "#34d399",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#06b6d4",
  "#84cc16",
  "#e879f9",
  "#22d3ee",
  "#a3e635",
  "#fb923c",
];
