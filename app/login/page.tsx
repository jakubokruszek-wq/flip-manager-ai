"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(null); const { error: authError } = await createClient().auth.signInWithPassword({ email: email.trim(), password }); if (authError) { setError("Nie udało się zalogować. Sprawdź email i hasło."); setBusy(false); return; } router.replace("/dashboard"); router.refresh(); }
  return <main className="flex min-h-screen items-center justify-center px-4"><form className="w-full max-w-md space-y-5 rounded-2xl border bg-card p-6 shadow-xl" onSubmit={submit}><div><h1 className="text-2xl font-semibold">Zaloguj się</h1><p className="mt-1 text-sm text-muted-foreground">Dostęp do Flip Manager wymaga aktywnej sesji.</p></div><label className="grid gap-1 text-sm">Email<input className="h-11 rounded-lg border bg-background px-3" autoComplete="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="grid gap-1 text-sm">Hasło<input className="h-11 rounded-lg border bg-background px-3" autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error ? <p className="text-sm text-destructive">{error}</p> : null}<Button className="w-full" disabled={busy} type="submit">{busy ? "Logowanie…" : "Zaloguj się"}</Button></form></main>;
}
