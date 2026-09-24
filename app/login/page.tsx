import { LoginForm } from "@/app/login/login-form";
import { Logo } from "@/components/ui/logo";
import { safeReturnTo } from "@/features/auth/return-to";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const params = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <section className="w-full max-w-sm rounded-2xl border border-border/80 bg-surface/90 p-7 shadow-2xl">
        <div className="mb-7 space-y-4">
          <Logo />
          <div>
            <h1 className="text-xl font-semibold">Logowanie operatora</h1>
            <p className="mt-1 text-sm text-muted-foreground">Zaloguj się do panelu Flip Manager.</p>
          </div>
        </div>
        <LoginForm returnTo={safeReturnTo(params.returnTo)} />
      </section>
    </main>
  );
}
