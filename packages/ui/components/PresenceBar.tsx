"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useAppStore } from "../lib/store";
import { api } from "../lib/api";

interface UserPresence {
  userId: string;
  userName: string;
  avatarUrl?: string;
  color: string;
  currentPage: string;
  currentAction?: string;
  lastSeen: string;
  status: "online" | "idle" | "offline";
}

/** Derive a room ID from the current pathname */
function deriveRoomId(pathname: string): string | null {
  // /companies/:id -> company:<id>
  const companyMatch = pathname.match(/^\/companies\/([a-zA-Z0-9_-]+)/);
  if (companyMatch) return `company:${companyMatch[1]}`;

  // /pipelines/:id -> pipeline:<id>
  const pipelineMatch = pathname.match(/^\/pipelines\/([a-zA-Z0-9_-]+)/);
  if (pipelineMatch) return `pipeline:${pipelineMatch[1]}`;

  // /agents/:id -> agent:<id>
  const agentMatch = pathname.match(/^\/agents\/([a-zA-Z0-9_-]+)/);
  if (agentMatch) return `agent:${agentMatch[1]}`;

  // /drafts/:id -> draft:<id>
  const draftMatch = pathname.match(/^\/drafts\/([a-zA-Z0-9_-]+)/);
  if (draftMatch) return `draft:${draftMatch[1]}`;

  // /settings -> settings:global
  if (pathname.startsWith("/settings")) return "settings:global";

  return null;
}

/** Get initials from a user name */
function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export default function PresenceBar() {
  const token = useAppStore((s) => s.token);
  const theme = useAppStore((s) => s.theme);
  const pathname = usePathname();
  const [users, setUsers] = useState<UserPresence[]>([]);
  const [hoveredUser, setHoveredUser] = useState<string | null>(null);
  const currentRoomRef = useRef<string | null>(null);
  const isDark = theme === "dark";

  // Heartbeat: send presence every 30s
  useEffect(() => {
    if (!token) return;

    const sendHeartbeat = () => {
      api.collaborationHeartbeat(token, { page: pathname }).catch(() => {});
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30_000);
    return () => clearInterval(interval);
  }, [token, pathname]);

  // Join/leave rooms based on pathname
  useEffect(() => {
    if (!token) return;

    const newRoom = deriveRoomId(pathname);
    const oldRoom = currentRoomRef.current;

    if (oldRoom && oldRoom !== newRoom) {
      api.collaborationLeaveRoom(token, oldRoom).catch(() => {});
    }

    if (newRoom && newRoom !== oldRoom) {
      api.collaborationJoinRoom(token, newRoom).catch(() => {});
    }

    currentRoomRef.current = newRoom;

    return () => {
      if (currentRoomRef.current) {
        api.collaborationLeaveRoom(token, currentRoomRef.current).catch(() => {});
        currentRoomRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pathname]);

  // Fetch presence list every 10s
  const fetchPresence = useCallback(() => {
    if (!token) return;
    api
      .collaborationPresence(token)
      .then((data) => {
        if (Array.isArray(data)) setUsers(data.filter((u) => u.status !== "offline"));
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    fetchPresence();
    const interval = setInterval(fetchPresence, 10_000);
    return () => clearInterval(interval);
  }, [fetchPresence]);

  if (!token || users.length === 0) return null;

  const containerStyle: React.CSSProperties = {
    position: "fixed",
    top: 16,
    right: 112, // offset to leave room for NotificationBell
    zIndex: 99,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px 4px 12px",
    borderRadius: 12,
    background: isDark ? "rgba(29,32,38,0.85)" : "rgba(255,255,255,0.85)",
    border: isDark
      ? "1px solid rgba(255,255,255,0.08)"
      : "1px solid rgba(0,0,0,0.1)",
    backdropFilter: "blur(12px)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.2)",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 500,
    color: isDark ? "#859399" : "#4a5568",
    whiteSpace: "nowrap",
    marginRight: 2,
  };

  return (
    <div style={containerStyle}>
      <span style={labelStyle}>
        {users.length} online
      </span>

      <div style={{ display: "flex", alignItems: "center" }}>
        {users.slice(0, 8).map((user, i) => (
          <div
            key={user.userId}
            style={{ position: "relative", marginLeft: i === 0 ? 0 : -6 }}
            onMouseEnter={() => setHoveredUser(user.userId)}
            onMouseLeave={() => setHoveredUser(null)}
          >
            {/* Avatar circle */}
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: user.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                color: "#fff",
                border: `2px solid ${isDark ? "#0a0d14" : "#f0f5ff"}`,
                cursor: "default",
                position: "relative",
                zIndex: 8 - i,
                letterSpacing: 0.5,
              }}
              title={`${user.userName} — ${user.currentAction ?? user.currentPage}`}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.userName}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: "50%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                getInitials(user.userName)
              )}

              {/* Status dot */}
              <span
                style={{
                  position: "absolute",
                  bottom: -1,
                  right: -1,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    user.status === "online" ? "#34d399" : "#f59e0b",
                  border: `1.5px solid ${isDark ? "#0a0d14" : "#f0f5ff"}`,
                }}
              />
            </div>

            {/* Tooltip */}
            {hoveredUser === user.userId && (
              <div
                style={{
                  position: "absolute",
                  top: 36,
                  left: "50%",
                  transform: "translateX(-50%)",
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: isDark ? "#191c22" : "#fff",
                  border: isDark
                    ? "1px solid rgba(255,255,255,0.1)"
                    : "1px solid rgba(0,0,0,0.1)",
                  boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                  whiteSpace: "nowrap",
                  zIndex: 200,
                  minWidth: 120,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: isDark ? "#e1e2eb" : "#1a202c",
                    marginBottom: 2,
                  }}
                >
                  {user.userName}
                </div>
                {user.currentAction && (
                  <div
                    style={{
                      fontSize: 11,
                      color: user.color,
                      marginBottom: 2,
                    }}
                  >
                    {user.currentAction}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 10,
                    color: isDark ? "#859399" : "#718096",
                  }}
                >
                  {user.currentPage}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Overflow indicator */}
        {users.length > 8 && (
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: isDark
                ? "rgba(255,255,255,0.08)"
                : "rgba(0,0,0,0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 600,
              color: isDark ? "#859399" : "#4a5568",
              border: `2px solid ${isDark ? "#0a0d14" : "#f0f5ff"}`,
              marginLeft: -6,
            }}
          >
            +{users.length - 8}
          </div>
        )}
      </div>
    </div>
  );
}
