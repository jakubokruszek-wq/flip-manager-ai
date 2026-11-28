"use client";
import { useEffect, useState } from 'react';
import type { RcnDistrictSummary, RcnAreaBand } from './districts';
const money = (n: number | null) => n === null ? 'Za mało danych' : new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 }).format(n);
const number = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(n);
const date = (value: string) => new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('pl-PL');
export function DistrictRadarPanel() {
  const [area, setArea] = useState<RcnAreaBand>('all'); const [attempt, setAttempt] = useState(0); const [expanded, setExpanded] = useState<string | null>(null);
  const key = `${area}:${attempt}`;
  const [state, setState] = useState<{ key: string; data?: RcnDistrictSummary; error?: string } | null>(null);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setAttempt(value => value + 1); };
    const timer = setInterval(refresh, 300000); window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    void fetch(`/api/price-radar/rcn/districts?area=${area}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Nie udało się pobrać podsumowania dzielnic.');
      if (active) setState({ key, data });
    }).catch((error: unknown) => { if (active && !controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : 'Nie udało się pobrać podsumowania.' }); });
    return () => { active = false; controller.abort(); };
  }, [area, key]);
  const current = state?.key === key ? state : null;
  return <section aria-label="Radar dzielnic" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm font-medium">Metraż mieszkań<select aria-label="Metraż mieszkań" value={area} onChange={event => { setArea(event.target.value as RcnAreaBand); setExpanded(null); }} className="mt-2 block min-h-11 rounded-lg border bg-background px-3">{[['all','Wszystkie metraże'],['small','Poniżej 35 m²'],['medium','35–49,99 m²'],['large','50–69,99 m²'],['extra','Od 70 m²']].map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label><button type="button" onClick={() => setAttempt(value => value + 1)} className="min-h-11 rounded-lg border px-4 text-sm">Odśwież dane</button></div>
    <p className="text-xs leading-relaxed text-muted-foreground">Łódź · rynek wtórny przy zakupie i sprzedaży · odsprzedaż w ciągu maksymalnie roku · wzrost ceny ≥30% · końcowa sprzedaż z ostatnich 24 miesięcy. Statystyki dotyczą wyłącznie takich przypadków, a nie wszystkich mieszkań w dzielnicy.</p>
    <div aria-live="polite" aria-busy={!current}>
      {!current ? <p className="text-sm text-muted-foreground">Aktualizowanie podsumowań dzielnic…</p> : current.error ? <p role="alert" className="text-sm">{current.error}</p> : current.data ? <>
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {current.data.districts.map(group => <article key={group.district} className="min-w-0 rounded-2xl border bg-card p-4">
            <h2 className="text-lg font-bold">{group.district}</h2><p className="mt-1 text-sm"><strong>{group.count}</strong> możliwych flipów ≥30%</p>
            {group.smallSample ? <p className="mt-3 text-xs text-muted-foreground">Do porównania średnich i median potrzeba co najmniej 5 przypadków.</p> : <dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">Mediana zakupu / m²</dt><dd className="mt-1 font-semibold">{money(group.medianBuyPerM2)}</dd></div><div><dt className="text-xs text-muted-foreground">Mediana sprzedaży / m²</dt><dd className="mt-1 font-semibold">{money(group.medianSellPerM2)}</dd></div><div><dt className="text-xs text-muted-foreground">Średnia zakupu / m²</dt><dd>{money(group.averageBuyPerM2)}</dd></div><div><dt className="text-xs text-muted-foreground">Średnia sprzedaży / m²</dt><dd>{money(group.averageSellPerM2)}</dd></div><div><dt className="text-xs text-muted-foreground">Typowy czas</dt><dd>{number(group.medianMonths)} mies.</dd></div><div><dt className="text-xs text-muted-foreground">Mediana wzrostu</dt><dd>+{number(group.medianIncreasePct)}%</dd></div></dl>}
            <button type="button" aria-expanded={expanded === group.district} onClick={() => setExpanded(value => value === group.district ? null : group.district)} className="mt-4 min-h-11 rounded-lg border px-3 text-sm">{expanded === group.district ? 'Ukryj przypadki' : 'Pokaż przypadki'}</button>
            {expanded === group.district ? <div className="mt-3 space-y-3">{group.examples.length ? group.examples.map(row => <div key={row.id} className="rounded-lg bg-muted/40 p-3 text-xs leading-relaxed"><p className="font-semibold">{row.street} {row.building} · {number(row.area)} m²</p><p>Zakup {date(row.buyDate)}: {money(row.buyPrice)} · {money(row.buyPricePerM2)}/m²</p><p>Sprzedaż {date(row.sellDate)}: {money(row.sellPrice)} · {money(row.sellPricePerM2)}/m²</p><p>Około {number(row.approxMonths)} mies. · +{number(row.priceIncreasePct)}% · różnica {money(row.priceIncrease)}</p></div>) : <p className="text-xs">Brak dopasowanych przypadków.</p>}{group.count > group.examples.length ? <p className="text-xs text-muted-foreground">Pokazano {group.examples.length} najnowszych z {group.count} przypadków.</p> : null}</div> : null}
          </article>)}
        </div>
        <div className="mt-4 space-y-2 text-xs leading-relaxed text-muted-foreground"><p>Import: {date(current.data.importedAt)} · najnowsza wersja wpisu w zbiorze: {date(current.data.latestRegistryVersion)}. Przeanalizowano {current.data.observationCount.toLocaleString('pl-PL')} obserwacji lokali z {current.data.archiveCount} plików urzędu. Pominięto {current.data.unlocatedCandidateCount} dopasowanych par bez jednoznacznej lokalizacji.</p><p>Pliki urzędu sprawdzamy codziennie; sam rejestr jest publikowany okresowo. Widok odświeża się co 5 minut i po powrocie do aplikacji.</p><p>Źródła: <a className="underline" href={current.data.sourceUrl} target="_blank" rel="noopener noreferrer">RCN Łódź</a> · <a className="underline" href={current.data.boundarySourceUrl} target="_blank" rel="noopener noreferrer">oficjalne granice dzielnic</a>.</p></div>
      </> : null}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">To możliwe flipy, nie potwierdzone remonty. Wzrost ceny nie jest zyskiem netto i nie uwzględnia remontu, podatków, finansowania ani pozostałych kosztów. Braki w rejestrze mogą uniemożliwiać połączenie części sprzedaży.</p>
  </section>;
}
