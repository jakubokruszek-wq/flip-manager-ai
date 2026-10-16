import {conditionalTax,validTaxAmount} from "./tax-arithmetic";
import {reconcileTaxCash,taxCents as c,type TaxEconomics} from "./tax-cash";
export const JDG_TAX_LABELS={
 jdgForm:"Czy liniowy PIT został skutecznie wybrany na 2026 i nadal przysługuje (także ograniczenia pracodawcy)? Wpisz LINEAR_2026_ELECTED_ELIGIBLE albo Nie wiem.",
 jdgAsset:"Czy mieszkanie jest towarem handlowym KPiR, w całości sprzedanym w tym samym roku, a nie mieszkaniowym środkiem trwałym? Wpisz TRADING_GOOD_KPIR_FULLY_SOLD.",
 jdgVat:"Czy odrębnie potwierdzono zwolnienie art.43 ust.1 pkt10, historię zasiedlenia/ulepszeń, brak wyboru VAT i brak odliczeń/korekt? Wpisz EXEMPT_43_1_10_NO_OPTION_NO_INPUT_CORRECTION.",
 jdgOccupationOn:"Jaka jest potwierdzona data pierwszego zasiedlenia po uwzględnieniu ulepszeń (RRRR-MM-DD)?",
 jdgPcc:"Czy zakup podlega zwykłemu PCC, bez zwolnienia/art.7a, a wartość rynkowa równa się cenie? Wpisz STANDARD_MARKET_PRICE.",
 jdgAnnual:"Czy jest to jedyny roczny przypadek JDG, bez innych przychodów, otwierającego/końcowego remanentu, strat, ulg i środków trwałych? Wpisz SOLE_2026_ZERO_OTHER_INVENTORY_LOSSES_RELIEFS.",
 jdgSolidarity:"Czy potwierdzono, że suma WSZYSTKICH właściwych dochodów rocznych nie przekracza progu daniny solidarnościowej? Wpisz UNDER_1M_ALL_RELEVANT.",
 jdgZus:"Czy pełny harmonogram składek 2026 i rozliczenie roczne uzgodniono, bez późniejszej dopłaty/zwrotu? Wpisz RECONCILED_2026_NO_LATER_ADJUSTMENTS. Jeśli nie, Nie wiem.",
 jdgCosts:"Czy koszty są udokumentowane i właściwie rozliczone w KPiR, a ZUS nie jest już w kosztach CFO? Społeczne/zdrowotne od dochodu, Fundusz jako koszt. Wpisz DOCUMENTED_ZUS_OUTSIDE_CFO.",
 jdgAcquisitionFees:"Ile PLN kwalifikowanych kosztów nabycia poza ceną/PCC, już w kosztach transakcji CFO? Kwota z kropką, także jawne 0.",
 jdgOperatingCosts:"Ile PLN kwalifikowanych kosztów operacyjnych już w budżecie CFO, bez ZUS, ceny i sprzedaży? Nie uznawaj automatycznie całego remontu.",
 jdgDisposalCosts:"Ile PLN kwalifikowanych kosztów sprzedaży już w CFO? Kwota z kropką, także jawne 0.",
 jdgHealthDeduction:"Ile PLN zapłaconej w 2026 składki zdrowotnej odliczyć od dochodu? Nie może być kosztem drugi raz; limit i wpłaty będą sprawdzone.",
 jdgPayments:"Podaj uzgodnione wpłaty, jedna na wiersz: DATA | SOCIAL/FUND/HEALTH/PIT | PLN. DATA to RRRR-MM-DD, kwota z kropką. Uwzględnij każdy typ, jawne 0 gdy potwierdzone; brak harmonogramu oznacza Nie wiem.",
 jdgQualificationRef:"Podaj publiczną referencję kwalifikacji i uzgodnienia (HTTPS bez parametrów, bez prywatnych dokumentów). Link nie potwierdza jej automatycznie.",
} as const;
export type JdgTaxInputs=Partial<Record<keyof typeof JDG_TAX_LABELS,string|null>>;
export const JDG_ENUMS:Partial<Record<keyof JdgTaxInputs,string>>={jdgForm:"LINEAR_2026_ELECTED_ELIGIBLE",jdgAsset:"TRADING_GOOD_KPIR_FULLY_SOLD",jdgVat:"EXEMPT_43_1_10_NO_OPTION_NO_INPUT_CORRECTION",jdgPcc:"STANDARD_MARKET_PRICE",jdgAnnual:"SOLE_2026_ZERO_OTHER_INVENTORY_LOSSES_RELIEFS",jdgSolidarity:"UNDER_1M_ALL_RELEVANT",jdgZus:"RECONCILED_2026_NO_LATER_ADJUSTMENTS",jdgCosts:"DOCUMENTED_ZUS_OUTSIDE_CFO"};
export const JDG_AMOUNTS=["jdgAcquisitionFees","jdgOperatingCosts","jdgDisposalCosts","jdgHealthDeduction"] as const;
export type JdgPayment={on:string;kind:"SOCIAL"|"FUND"|"HEALTH"|"PIT";amount:number};
function validDate(s:string){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;}
export function parseJdgPayments(value:string):JdgPayment[]|null{
 if(!value||value.length>2000)return null;
 const lines=value.trim().split(/\r?\n/);if(lines.length>64)return null;const result:JdgPayment[]=[],seen=new Set<string>();
 for(const line of lines){const parts=line.split("|").map(s=>s.trim());if(parts.length!==3)return null;const [on,kind,amount]=parts;
  if(!validDate(on)||!["SOCIAL","FUND","HEALTH","PIT"].includes(kind)||!validTaxAmount(amount)||seen.has(on+kind)||on<"2026-01-01"||on>(kind==="PIT"?"2027-04-30":"2026-12-31"))return null;
  seen.add(on+kind);result.push({on,kind:kind as JdgPayment["kind"],amount:Number(amount)});
 }
 return ["SOCIAL","FUND","HEALTH","PIT"].every(k=>result.some(r=>r.kind===k))?result:null;
}
export type JdgTaxResult={version:1;status:"UNKNOWN"|"MODELLED_ESTIMATE";missing:string[];reasons:string[];actualLiability:null;ruleCoverage:{from:string;through:string};vat:"UNKNOWN"|"EXEMPT_43_1_10_NO_DEDUCTION";taxableIncome:number|null;pit:number|null;pcc:number|null;pccReplacementDelta:number|null;social:number|null;fund:number|null;health:number|null;healthDeduction:number|null;profitAfterTaxAndContributions:number|null;fundingGap:number|null;cashFlow:Array<{on:string;phase:string;expenses:number;receipts:number;balance:number}>|null;maxBuyAfterTax:null;stressAfterTax:null};
export function jdgTaxModel(p:JdgTaxInputs,dates:{acquired?:string|null;sale?:string|null},e:TaxEconomics|null):JdgTaxResult{
 const missing=Object.keys(JDG_TAX_LABELS).filter(k=>!p[k as keyof JdgTaxInputs]);const reasons:string[]=[];
 const unknown:JdgTaxResult={version:1,status:"UNKNOWN",missing,reasons,actualLiability:null,ruleCoverage:{from:"2026-04-01",through:"2026-10-16"},vat:"UNKNOWN",taxableIncome:null,pit:null,pcc:null,pccReplacementDelta:null,social:null,fund:null,health:null,healthDeduction:null,profitAfterTaxAndContributions:null,fundingGap:null,cashFlow:null,maxBuyAfterTax:null,stressAfterTax:null};
 for(const [k,v] of Object.entries(JDG_ENUMS))if(p[k as keyof JdgTaxInputs]!==v)reasons.push(`QUALIFICATION_${k}`);
 for(const k of JDG_AMOUNTS)if(!validTaxAmount(p[k]??""))reasons.push(`INVALID_${k}`);
 try{const u=new URL(p.jdgQualificationRef??"");if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)throw Error();}catch{reasons.push("QUALIFICATION_jdgQualificationRef");}
 const a=dates.acquired??"",s=dates.sale??"",o=p.jdgOccupationOn??"";
 if(!validDate(a)||!validDate(s)||a<"2026-04-01"||s>"2026-10-16"||s<a)reasons.push("REVIEWED_DATES_REQUIRED");
 // Calendar anniversary, not 730 days: leap years must not qualify an early supply.
 if(!validDate(o)||!validDate(s)||o.endsWith("-02-29")||Number(o.slice(0,4))>9997||`${Number(o.slice(0,4))+2}${o.slice(4)}`>s)reasons.push("VAT_OCCUPATION_INTERVAL_UNCONFIRMED");
 const payments=parseJdgPayments(p.jdgPayments??"");if(!payments)reasons.push("QUALIFIED_PAYMENT_SCHEDULE_REQUIRED");
 if(!e||e.mode!=="CASH")reasons.push("CASH_COMPLETE_ECONOMICS_REQUIRED");
 if(e&&e.months.at(-1)?.month!==Math.max(1,(Number(s.slice(0,4))-Number(a.slice(0,4)))*12+Number(s.slice(5,7))-Number(a.slice(5,7))))reasons.push("CASH_DATES_CONFLICT");
 if(missing.length||reasons.length||!e||!payments)return unknown;
 const reconciled=reconcileTaxCash(e,0);if(!reconciled){reasons.push("ECONOMIC_LEDGER_CONFLICT");return unknown;}
 const sum=(kind:JdgPayment["kind"])=>payments.filter(r=>r.kind===kind).reduce((n,r)=>n+c(r.amount),0);
 const social=sum("SOCIAL"),fund=sum("FUND"),health=sum("HEALTH"),healthDed=c(Number(p.jdgHealthDeduction)),fees=c(Number(p.jdgAcquisitionFees)),operating=c(Number(p.jdgOperatingCosts)),disposal=c(Number(p.jdgDisposalCosts));
 const operatingBudget=c(e.sale)-c(e.projectProfit)-c(e.purchase)-c(e.purchaseCosts)-c(e.saleCosts);
 if(fees>c(e.purchaseCosts)-c(e.embeddedPcc)||operating>operatingBudget||disposal>c(e.saleCosts)||healthDed>health||healthDed>1410000){reasons.push("COST_OR_HEALTH_DEDUCTION_NOT_QUALIFIED");return unknown;}
 const pcc=conditionalTax("PCC2",e.purchase.toFixed(2))!.amountPLN,delta=c(pcc)-c(e.embeddedPcc);
 const beforeHealth=c(e.sale)-c(e.purchase)-c(pcc)-fees-operating-disposal-fund-social;
 if(beforeHealth>=100000000){reasons.push("SOLIDARITY_REASSESSMENT_REQUIRED");return unknown;}
 const income=beforeHealth-healthDed,pit=conditionalTax("JDG_LINEAR19",(Math.max(0,income)/100).toFixed(2))!.amountPLN;
 if(sum("PIT")!==c(pit)){reasons.push("PIT_ADVANCE_ANNUAL_RECONCILIATION_REQUIRED");return unknown;}
 const adjusted=reconcileTaxCash(e,delta);if(!adjusted){reasons.push("ECONOMIC_LEDGER_CONFLICT");return unknown;}
 const cash:Array<{on:string;phase:string;expenses:number;receipts:number;balance:number;order:number}>=[];
 for(const [i,r] of adjusted.ledger.entries()){
  let on=a;if(r.receipts>0||r.phase.includes("Wyposażenie"))on=s;
  else if(r.month>1){const d=new Date(a);d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+r.month-1);on=d.toISOString().slice(0,10);}
  cash.push({on,phase:r.phase,expenses:r.expenses,receipts:r.receipts,balance:0,order:i});
 }
 for(const r of payments)cash.push({on:r.on,phase:r.kind,expenses:r.amount,receipts:0,balance:0,order:-1});
 cash.sort((x,y)=>x.on.localeCompare(y.on)||x.order-y.order);let balance=c(e.equity),minimum=balance;
 for(const r of cash){balance+=c(r.receipts)-c(r.expenses);minimum=Math.min(minimum,balance);r.balance=balance/100;}
 const net=c(e.projectProfit)-delta-social-fund-health-c(pit);
 if(balance!==c(e.equity)+net){reasons.push("CASH_PROFIT_RECONCILIATION_REQUIRED");return unknown;}
 return {...unknown,status:"MODELLED_ESTIMATE",reasons:["DECLARED_QUALIFICATION_NOT_CERTIFICATION","DOCUMENTED_CONTRIBUTIONS_NOT_AUTOMATIC_ZUS_CALCULATION","COSTS_AND_PCC_RECONCILED_ONCE"],vat:"EXEMPT_43_1_10_NO_DEDUCTION",taxableIncome:income/100,pit,pcc,pccReplacementDelta:delta/100,social:social/100,fund:fund/100,health:health/100,healthDeduction:healthDed/100,profitAfterTaxAndContributions:net/100,fundingGap:Math.max(0,c(e.liquidityReserve)-minimum)/100,cashFlow:cash.map(r=>({on:r.on,phase:r.phase,expenses:r.expenses,receipts:r.receipts,balance:r.balance}))};
}
export function jdgTaxReason(reason:string):string{
 const field=reason.replace(/^(QUALIFICATION_|INVALID_)/,"") as keyof typeof JDG_TAX_LABELS;
 if(JDG_TAX_LABELS[field])return JDG_TAX_LABELS[field];
 const text:Record<string,string>={REVIEWED_DATES_REQUIRED:"Daty są poza sprawdzonym wariantem.",VAT_OCCUPATION_INTERVAL_UNCONFIRMED:"Historia zasiedlenia i wymagany okres VAT nie są potwierdzone.",QUALIFIED_PAYMENT_SCHEDULE_REQUIRED:"Potrzebny kompletny, uzgodniony harmonogram składek i PIT.",CASH_COMPLETE_ECONOMICS_REQUIRED:"Potrzebny kompletny model gotówkowy CFO.",CASH_DATES_CONFLICT:"Horyzont CFO nie zgadza się z datami.",ECONOMIC_LEDGER_CONFLICT:"Koszty i przepływy CFO nie uzgadniają się.",COST_OR_HEALTH_DEDUCTION_NOT_QUALIFIED:"Koszt/odliczenie przekracza budżet, wpłaty lub limit.",SOLIDARITY_REASSESSMENT_REQUIRED:"Konieczna ponowna ocena daniny solidarnościowej.",PIT_ADVANCE_ANNUAL_RECONCILIATION_REQUIRED:"Wpłaty PIT nie uzgadniają się z wynikiem rocznym; potrzebne rozliczenie zaliczek/zwrotu.",CASH_PROFIT_RECONCILIATION_REQUIRED:"Saldo nie uzgadnia się z wynikiem; obliczenie zatrzymane.",DECLARED_QUALIFICATION_NOT_CERTIFICATION:"Wynik jest warunkowy; kwalifikacja i zobowiązanie nie są certyfikowane.",DOCUMENTED_CONTRIBUTIONS_NOT_AUTOMATIC_ZUS_CALCULATION:"Wpłaty ZUS pochodzą z podanego uzgodnienia. System nie dobiera kategorii składek.",COSTS_AND_PCC_RECONCILED_ONCE:"PCC i wydatki rozliczono raz; odliczenie zdrowotne zmniejsza podstawę, nie jest dodatkową gotówką."};
 return text[reason]??"Wymagane wyjaśnienie wariantu JDG.";
}
