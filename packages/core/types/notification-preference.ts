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

export interface NotificationPreferenceResponse {
  workspace_id: string;
  preferences: NotificationPreferences;
}
