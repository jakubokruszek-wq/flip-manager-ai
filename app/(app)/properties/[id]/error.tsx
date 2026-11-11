"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: { reset: () => void }) { return <section className="ui-card space-y-4 p-6"><h1 className="text-xl font-semibold">Nie udało się otworzyć karty mieszkania</h1><p className="text-sm text-muted-foreground">Zapisane dane są zachowane. Sprawdź połączenie i spróbuj ponownie.</p><button className="min-h-11 rounded-xl border px-4 py-2" onClick={reset}>Spróbuj ponownie</button><Link className="block min-h-11 text-primary underline" href="/properties">Wróć do nieruchomości</Link></section>; }
