import type { CfoAnalysis } from "../cfo";
const pln=(v:number|null)=>v===null?"nieustalone":`${v.toLocaleString("pl-PL",{maximumFractionDigits:2})} zł`;
export function CfoPanel({model}:{model:CfoAnalysis}){
 const balances=model.selected?.months.map(m=>m.balance)??[]; const minimum=Math.min(0,...balances), maximum=Math.max(1,...balances);
 return <section className="min-w-0 space-y-4 rounded-2xl border border-white/10 p-4" aria-label="CFO cash-flow">
 <h3 className="font-semibold">CFO — płynność i finansowanie</h3><p>Scenariusze deklarowane na tej samej bazie oferty. Podatek dochodowy: NIEUSTALONY. Pokazujemy wynik przed podatkiem, nie zysk netto.</p>
 <div className="grid gap-3 md:grid-cols-3">{model.variants.map(v=><article key={v.mode} className="min-w-0 rounded-xl border p-3"><h4>{v.mode}{model.selected?.mode===v.mode?" — wybrany":""}</h4><p>Stan: {v.status}</p>{v.missing.length?<p>Brakuje: {v.missing.join(", ")}</p>:<><p>Szczyt kapitału: {pln(v.peakOwnCapital)}</p><p>Luka: {pln(v.fundingGap)}</p><p>Finansowanie: {pln(v.financingCost)}</p><p>Projekt przed podatkiem: {pln(v.projectProfitBeforeTax)}</p><p>Właściciel przed podatkiem: {pln(v.ownProfitBeforeTax)}</p><p>ROI na szczytowym kapitale: {v.roiOnPeakEquity??"nieustalone"}%</p><p>Break-even sprzedaży: {pln(v.breakEvenSale)}</p><p>Max Buy wariantu: {pln(v.maxBuy)}</p></>}</article>)}</div>
 {model.selected?.months.map((m,i)=><div key={i} className="min-w-0 text-xs"><p>M{m.month}: {m.phase} · wypływy {pln(m.expenses+m.debtPayment)} · finansowanie {pln(m.funding)} · sprzedaż {pln(m.receipts)} · saldo {pln(m.balance)}</p><meter className="w-full" aria-label={`Saldo M${m.month}`} min={minimum} max={maximum} value={m.balance}/></div>)}
 <h4>Stres-testy</h4>{model.stress.map(s=><p key={s.label}>{s.label}: wynik właściciela przed podatkiem {pln(s.result.ownProfitBeforeTax)} · luka {pln(s.result.fundingGap)} · Max Buy {pln(s.result.maxBuy)}</p>)}
 {model.warnings.map(w=><p key={w} className="text-xs">{w}</p>)}<ol className="list-decimal pl-5"><li>Odpowiedz na brakujące pytania CFO poniżej.</li><li>Potwierdź kosztorys i harmonogram wraz z wyposażeniem/VAT.</li><li>Potwierdź warunki finansowania i podatki przed decyzją zakupu.</li></ol>
 </section>;
}
