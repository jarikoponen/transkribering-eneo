"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button, FormControl, FormLabel, Input } from "@sk-web-gui/react";
import { authStatus, login } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Brand } from "@/components/Brand";

export default function LoginPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    authStatus()
      .then((s) => {
        if (s.authenticated) router.replace("/flows");
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(code);
      router.push("/flows");
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-ink-mute" />
      </main>
    );
  }

  return (
    <main className="flex flex-col flex-1 px-6 md:px-8 py-10 w-full mx-auto max-w-md md:max-w-lg md:justify-center">
      <header className="flex items-center justify-between mb-12">
        <Brand />
      </header>

      <div className="space-y-2 mb-8">
        <div className="eyebrow">v0.4 · Demo</div>
        <h1 className="text-[30px] md:text-[36px] font-semibold tracking-[-0.025em] leading-[1.05]">
          Spela in samtal — <span className="accent-em">i fickformat</span>
        </h1>
        <p className="text-[14px] text-ink-soft leading-relaxed pt-1">
          Skriv åtkomstkoden för att fortsätta.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6 mt-2">
        <FormControl id="access-code" disabled={submitting} className="w-full">
          <FormLabel className="eyebrow-sm">Åtkomstkod</FormLabel>
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            size="md"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="••••••"
            className="w-full"
          />
        </FormControl>

        {error && (
          <p className="text-sm text-accent" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          color="vattjom"
          variant="primary"
          size="md"
          loading={submitting}
          loadingText="Loggar in…"
          disabled={submitting || code.length === 0}
          className="w-full"
        >
          Logga in
        </Button>
      </form>
    </main>
  );
}
