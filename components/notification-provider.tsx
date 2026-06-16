"use client";

import { useDesktopNotifications } from "@/lib/hooks/use-notifications";

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  useDesktopNotifications();
  return <>{children}</>;
}
