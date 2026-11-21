"use client";

import { Lock } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Card, Field, inputClass, Note } from "@/components/ui";
import { safeNext } from "@/lib/auth/session";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/auth/login")
      .then((r) => r.json())
      .then((data: { configured: boolean }) => setConfigured(data.configured))
      .catch(() => setConfigured(true));
    input.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not log in.");
        setPassword("");
        input.current?.focus();
        return;
      }
      // A full load, so every page and data request starts with the new session.
      window.location.assign(safeNext(new URLSearchParams(window.location.search).get("next")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="flex items-center gap-2 mb-5">
          <span className="grid place-items-center size-7 rounded-md bg-accent text-on-accent font-semibold" aria-hidden>
            P
          </span>
          <h1 className="text-[18px] font-semibold tracking-tight">Plumb</h1>
        </div>
        {configured === false ? (
          <Note>
            No password is set yet. Add <code className="font-mono">PLUMB_PASSWORD=</code> followed by a password of at least 8 characters to <code className="font-mono">.env.local</code>, then restart Plumb.
          </Note>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <Field label="Password">
              <input ref={input} type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error ? <Note tone="bad">{error}</Note> : null}
            <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!password}>
              <Lock size={14} /> Log in
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
