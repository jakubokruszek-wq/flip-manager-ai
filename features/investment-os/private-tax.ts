import { conditionalTax, validTaxAmount } from "./tax-arithmetic";
/** A complete conditional transaction model; never infers legal facts from a listing.
 * See docs/deal-room-private-tax-model.md for the bounded legal and time contract. */
export const PRIVATE_TAX_LABELS = {
 privateActivity: "Czy potwierdzono, że sprzedaż NIE następuje w działalności gospodarczej? Wpisz NON_BUSINESS tylko po odrębnej kwalifikacji; inaczej Nie wiem.",
 privateTitle: "Czy jesteś jedynym właścicielem mieszkania nabytego odpłatnie zwykłą umową kupna? Wpisz PAID_SOLE_OWNER; spadek, darowizna i podział majątku wymagają innego modelu.",
 privateVat: "Czy odrębnie ustalono zakup i sprzedaż poza VAT, bez odliczeń? Wpisz OUTSIDE_VAT_NO_DEDUCTION; samo PRIVATE nie wystarcza.",
 privateExclusions: "Czy potwierdzono: polski rezydent, jedyna taka sprzedaż w roku, brak ulg, amortyzacji i historycznego użycia w firmie? Wpisz STANDARD_ONLY; inaczej Nie wiem.",
 privatePcc: "Czy zakup podlega standardowemu PCC, bez zwolnienia i art. 7a, a wartość rynkowa równa jest cenie? Wpisz STANDARD_MARKET_PRICE; inaczej Nie wiem.",
 privateSaleMarket: "Czy cena sprzedaży odpowiada wartości rynkowej, bez sporu/korekty organu? Wpisz MARKET_PRICE; inaczej Nie wiem.",
 privateCostEvidence: "Czy poniższe koszty mają dokumenty nabycia, faktury VAT/opłaty nakładów zwiększających wartość i dowody kosztów zbycia? Wpisz DOCUMENTED; nie uznawaj całego budżetu za podatkowy.",
 privateAcquisitionFees: "Ile PLN udokumentowanych kosztów nabycia POZA ceną i PCC? Wpisz kwotę z kropką (0 też wymaga potwierdzenia). Muszą już być w kosztach transakcji CFO.",
 privateImprovements: "Ile PLN faktycznie udokumentowanych nakładów zwiększających wartość w czasie posiadania? Kwota z kropką; bez mebli, własnej pracy i automatycznego uznania całego remontu.",
 privateDisposalCosts: "Ile PLN udokumentowanych kosztów odpłatnego zbycia? Kwota z kropką; muszą już być w kosztach sprzedaży CFO.",
 privateQualificationRef: "Podaj publiczny HTTPS bez parametrów jako referencję odrębnej kwalifikacji. Nie wklejaj prywatnych dokumentów. Sam link nie jest weryfikacją; wynik pozostaje warunkowy.",
} as const;
export type PrivateTaxInputs = Partial<Record<keyof typeof PRIVATE_TAX_LABELS,string|null>>;
export const PRIVATE_ENUMS:Partial<Record<keyof PrivateTaxInputs,string>>={privateActivity:"NON_BUSINESS",privateTitle:"PAID_SOLE_OWNER",privateVat:"OUTSIDE_VAT_NO_DEDUCTION",privateExclusions:"STANDARD_ONLY",privatePcc:"STANDARD_MARKET_PRICE",privateCostEvidence:"DOCUMENTED",privateSaleMarket:"MARKET_PRICE"};
export const PRIVATE_AMOUNTS = ["privateAcquisitionFees","privateImprovements","privateDisposalCosts"] as const;
export type PrivateLedgerRow={month:number;phase:string;expenses:number;funding:number;receipts:number;debtPayment:number;balance:number};
export type PrivateEconomics={mode:string;purchase:number;purchaseCosts:number;embeddedPcc:number;improvementBudget:number;sale:number;saleCosts:number;projectProfit:number;equity:number;months:PrivateLedgerRow[]};
export type PrivateTaxResult={
 version:1;status:"UNKNOWN"|"MODELLED_ESTIMATE";scenario:"PRIVATE";missing:string[];reasons:string[];
 ruleCoverage:{from:"2026-04-01";through:"2026-10-16";reviewedOn:"2026-10-16"};
 qualification:"DECLARED_NOT_INDEPENDENTLY_VERIFIED";actualLiability:null;
 taxRevenue:number|null;acquisitionBasis:number|null;improvementBasis:number|null;taxableIncome:number|null;pit:number|null;pcc:number|null;pccReplacementDelta:number|null;
 economicProfitBeforePit:number|null;profitAfterPit:number|null;profitAvailableAfterTaxReserve:number|null;roiOnPeakEquity:number|null;
 cashFlow:PrivateLedgerRow[]|null;taxPayment:{on:"2027-04-30";amount:number}|null;maxBuyAfterTax:null;stressAfterTax:null;
};
const cents=(n:number)=>Math.round((n+Number.EPSILON)*100);
const pln=(n:number)=>n/100;
function validDate(s:string):boolean{return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;}
export function privateTaxModel(inputs:PrivateTaxInputs,dates:{acquired?:string|null;sale?:string|null},e:PrivateEconomics|null):PrivateTaxResult{
 const missing=Object.keys(PRIVATE_TAX_LABELS).filter(k=>!inputs[k as keyof PrivateTaxInputs]);
 const reasons:string[]=[];
 for(const [k,v] of Object.entries(PRIVATE_ENUMS))if(inputs[k as keyof PrivateTaxInputs]!==v)reasons.push(`QUALIFICATION_${k}`);
 for(const k of PRIVATE_AMOUNTS)if(!validTaxAmount(inputs[k]??""))reasons.push(`INVALID_${k}`);
 try{const u=new URL(inputs.privateQualificationRef??"");if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)throw Error();}catch{reasons.push("QUALIFICATION_REFERENCE_REQUIRED");}
 const a=dates.acquired??"",s=dates.sale??"";
 if(!validDate(a)||!validDate(s)||a<"2026-04-01"||s>"2026-10-16"||s<a||a.slice(0,4)!==s.slice(0,4))reasons.push("OUTSIDE_REVIEWED_SAME_YEAR_WINDOW");
 if(!e||e.mode!=="CASH")reasons.push("CASH_COMPLETE_ECONOMICS_REQUIRED");
 if(e) {
  const expectedMonths=Math.max(1,(Number(s.slice(0,4))-Number(a.slice(0,4)))*12+Number(s.slice(5,7))-Number(a.slice(5,7)));
  if(e.months.at(-1)?.month!==expectedMonths||e.months.some((r,i)=>!Number.isInteger(r.month)||r.month<0||(i>0&&r.month<e.months[i-1].month)||r.expenses<0||r.receipts<0))reasons.push("CASH_DATES_OR_AMOUNTS_CONFLICT");
 }
 const result:PrivateTaxResult={version:1,status:"UNKNOWN",scenario:"PRIVATE",missing,reasons,ruleCoverage:{from:"2026-04-01",through:"2026-10-16",reviewedOn:"2026-10-16"},qualification:"DECLARED_NOT_INDEPENDENTLY_VERIFIED",actualLiability:null,taxRevenue:null,acquisitionBasis:null,improvementBasis:null,taxableIncome:null,pit:null,pcc:null,pccReplacementDelta:null,economicProfitBeforePit:null,profitAfterPit:null,profitAvailableAfterTaxReserve:null,roiOnPeakEquity:null,cashFlow:null,taxPayment:null,maxBuyAfterTax:null,stressAfterTax:null};
 if(reasons.length||missing.length||!e)return result;
 // Defensive boundary for callers outside Q&A: no NaN, impossible budget or hidden funding.
 if(![e.purchase,e.purchaseCosts,e.embeddedPcc,e.improvementBudget,e.sale,e.saleCosts,e.equity].every(n=>Number.isFinite(n)&&n>=0&&n<=100000000)||!Number.isFinite(e.projectProfit)||!e.months.length||e.months.some(r=>![r.month,r.expenses,r.funding,r.receipts,r.debtPayment,r.balance].every(Number.isFinite)||r.funding!==0||r.debtPayment!==0)) {reasons.push("INVALID_ECONOMICS");return result;}
 const fees=cents(Number(inputs.privateAcquisitionFees)),improvements=cents(Number(inputs.privateImprovements)),disposal=cents(Number(inputs.privateDisposalCosts));
 if(fees>cents(e.purchaseCosts)-cents(e.embeddedPcc)||improvements>cents(e.improvementBudget)||disposal>cents(e.saleCosts)||disposal>cents(e.sale)){reasons.push("TAX_COST_NOT_PRESENT_IN_ECONOMIC_LEDGER");return result;}
 const pcc=conditionalTax("PCC2",e.purchase.toFixed(2))!.amountPLN;
 const delta=cents(pcc)-cents(e.embeddedPcc);
 const revenue=cents(e.sale)-disposal,acquisition=cents(e.purchase)+cents(pcc)+fees;
 const income=revenue-acquisition-improvements;
 // A loss is zero tax in this no-relief, single-disposal model, NOT a cash refund/loss carryforward.
 const pit=conditionalTax("PRIVATE_PIT19",pln(Math.max(0,income)).toFixed(2))!.amountPLN;
 let balance=cents(e.equity),minimum=balance;const ledger:PrivateLedgerRow[]=[];
 const purchaseIndex=e.months.findIndex(r=>r.month===1&&r.expenses>=e.purchaseCosts);
 if(purchaseIndex<0){reasons.push("PURCHASE_CASH_ROW_REQUIRED");return result;}
 for(const [i,row] of e.months.entries()){
  const expenses=cents(row.expenses)+(i===purchaseIndex?delta:0);
  balance+=cents(row.receipts)-expenses;minimum=Math.min(minimum,balance);
  ledger.push({...row,expenses:pln(expenses),balance:pln(balance)});
 }
 const expectedEnd=cents(e.equity)+cents(e.projectProfit)-delta;
 if(Math.abs(balance-expectedEnd)>1){reasons.push("CASH_PROFIT_RECONCILIATION_FAILED");return result;}
 const before=cents(e.projectProfit)-delta,net=before-cents(pit);
 balance-=cents(pit);minimum=Math.min(minimum,balance);
 const taxMonth=(2027-Number(a.slice(0,4)))*12+4-Number(a.slice(5,7));
 ledger.push({month:taxMonth,phase:"Rezerwa PIT / zapłata do 2027-04-30",expenses:pit,funding:0,receipts:0,debtPayment:0,balance:pln(balance)});
 const peak=cents(e.equity)-Math.min(cents(e.equity),minimum);
 return {...result,status:"MODELLED_ESTIMATE",reasons:["CONDITIONAL_ON_DECLARED_QUALIFICATION","PCC_REPLACED_NOT_ADDED","NO_COMPANY_DIVIDEND_FOR_PRIVATE_OWNER","POST_TAX_MAX_BUY_AND_STRESS_REQUIRE_NEW_COST_QUALIFICATION"],taxRevenue:pln(revenue),acquisitionBasis:pln(acquisition),improvementBasis:pln(improvements),taxableIncome:pln(income),pit,pcc,pccReplacementDelta:pln(delta),economicProfitBeforePit:pln(before),profitAfterPit:pln(net),profitAvailableAfterTaxReserve:pln(net),roiOnPeakEquity:peak>0?Math.round(net/peak*10000)/100:null,cashFlow:ledger,taxPayment:{on:"2027-04-30",amount:pit}};
}
