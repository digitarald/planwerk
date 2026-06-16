"use client";

import { useLiveSessions } from "@/lib/hooks/use-live-sessions";

export function LiveSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useLiveSessions();
  return <>{children}</>;
}
