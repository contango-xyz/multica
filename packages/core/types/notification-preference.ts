export type NotificationGroupKey =
  | "assignments"
  | "status_changes"
  | "comments"
  | "mentions"
  | "updates"
  | "agent_activity"
  | "system_notifications";

export type NotificationGroupValue = "all" | "muted";

export type NotificationPreferences = Partial<Record<NotificationGroupKey, NotificationGroupValue>> & {
  /** When the person works (contango): "<IANA zone>|<days>|<HH:MM-HH:MM>"; "" or absent = not set. */
  work_hours?: string;
};

/** Notification levels (contango patch 39). */
export type NotificationLevel = "low" | "normal" | "high" | "critical";

/** One notification category with its workspace-default level, as the server lists them. */
export interface NotificationCategory {
  key: string;
  label: string;
  default: NotificationLevel;
}

export interface NotificationPreferenceResponse {
  workspace_id: string;
  preferences: NotificationPreferences;
  /** The categories notification levels apply to; absent from older servers. */
  categories?: NotificationCategory[];
}
