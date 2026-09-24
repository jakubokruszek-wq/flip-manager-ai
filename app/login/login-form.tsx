"use client";

import { useActionState } from "react";

import { loginOperator, type LoginState } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const INITIAL_STATE: LoginState = { error: null };

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [state, action, pending] = useActionState(loginOperator, INITIAL_STATE);
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="returnTo" value={returnTo} />
      <div className="space-y-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required maxLength={320} autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Hasło</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
      </div>
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Logowanie…" : "Zaloguj się"}</Button>
    </form>
  );
}
