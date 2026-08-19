"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { logout } from "@/lib/api";
import { Brand } from "@/components/Brand";

interface Props {
  initials?: string;
  // Children kept for back-compat with previous breadcrumb usage; not rendered.
  children?: React.ReactNode;
}

export function AppHeader({ initials = "A" }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function onLogout() {
    setOpen(false);
    try {
      await logout();
    } finally {
      router.replace("/");
    }
  }

  return (
    <header className="px-6 md:px-8 pt-5 pb-6 md:pt-7 flex items-center justify-between">
      <Brand href="/flows" />

      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Konto"
          className="grid h-[40px] w-[40px] place-items-center rounded-full bg-accent text-paper text-[15px] font-semibold transition-transform active:scale-95"
        >
          {initials}
        </button>
        {open && (
          <>
            <button
              aria-hidden
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div className="absolute right-0 top-full z-20 mt-2 w-44 rounded-xl bg-paper border border-rule-soft shadow-lg overflow-hidden">
              <button
                type="button"
                onClick={onLogout}
                className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left text-[13px] text-ink-soft hover:bg-bg-2 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                Logga ut
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
