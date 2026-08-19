"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authStatus } from "@/lib/api";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    authStatus()
      .then((s) => {
        if (!s.authenticated) {
          router.replace("/");
        } else {
          setReady(true);
        }
      })
      .catch(() => router.replace("/"));
  }, [router]);

  if (!ready) {
    return (
      <main className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-ink-mute" />
      </main>
    );
  }
  return <>{children}</>;
}
