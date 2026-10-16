import { calculateUnderwriting, type UnderwritingInput, type UnderwritingSettings } from "../flip-finder/underwriting";
export const CFO_NUMERIC = {
  equity: [0,100000000,"PLN własnych środków"], liquidityReserve:[0,10000000,"PLN rezerwy płynności"], deposit:[0,10000000,"PLN zadatku — część ceny"], renovationMonths:[1,120,"miesiące remontu"], equipment:[0,10000000,"PLN wyposażenia poza remontem"], loanAmount:[0,100000000,"PLN kredytu"], loanRate:[0,100,"% nominalnie rocznie"], loanFee:[0,10000000,"PLN wszystkich prowizji/opłat"], loanTermMonths:[1,600,"miesiące okresu spłaty"], investorCapital:[0,100000000,"PLN inwestora"], investorProfitShare:[0,100,"% udziału inwestora w zysku"], investorLossShare:[0,100,"% udziału inwestora w stracie"]
} as const;
export const CFO_LABELS:Record<string,string> = {equity:"Ile własnych środków przeznaczasz na projekt?",liquidityReserve:"Jaką rezerwę płynności zachować poza kosztami?",deposit:"Jaki zadatek płacisz przed uruchomieniem finansowania?",renovationMonths:"Przez ile miesięcy płacisz za remont równymi etapami?",equipment:"Ile kosztuje wyposażenie poza budżetem remontu (wpisz 0, jeśli zawarte)?",financingMode:"Wybierz finansowanie: CASH / LOAN / INVESTOR",loanAmount:"Jaka jest kwota kredytu wypłacanego przy zakupie?",loanRate:"Jakie nominalne roczne oprocentowanie kredytu przyjąć?",loanFee:"Ile łącznie wynoszą prowizje i pozostałe opłaty kredytu (PLN)?",loanTermMonths:"Jaki okres spłaty kredytu w miesiącach?",loanSchedule:"Harmonogram kredytu: INTEREST_ONLY / ANNUITY",loanSecurity:"Jakie zabezpieczenie i warunki wypłaty potwierdzono?",investorCapital:"Ile kapitału wnosi inwestor przy zakupie?",investorProfitShare:"Jaki procent zysku otrzyma inwestor?",investorLossShare:"Jaki procent straty pokrywa inwestor?"};
export type CfoInputs = Partial<Record<keyof typeof CFO_NUMERIC,number|null>> & {financingMode?:string|null;loanSchedule?:string|null;loanSecurity?:string|null};
export type CashMonth={month:number;phase:string;expenses:number;funding:number;receipts:number;debtPayment:number;balance:number};
export type CfoScenario={mode:string;status:"MODELLED"|"UNKNOWN";missing:string[];months:CashMonth[];peakOwnCapital:number|null;fundingGap:number|null;financingCost:number|null;projectProfitBeforeTax:number|null;ownProfitBeforeTax:number|null;roiOnPeakEquity:number|null;breakEvenSale:number|null;maxBuy:number|null};
export type CfoAnalysis={version:1;inputs:CfoInputs;selected:CfoScenario|null;variants:CfoScenario[];stress:Array<{label:string;result:CfoScenario}>;missing:string[];warnings:string[];taxStatus:"UNKNOWN";netProfit:null};
const money=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
export function analyseCfo(input:UnderwritingInput,settings:UnderwritingSettings,params:CfoInputs):CfoAnalysis{
 const baseSettings={...settings,financingEnabled:false};
 const missingCommon=["equity","liquidityReserve","deposit","renovationMonths","equipment"].filter(k=>typeof params[k as keyof CfoInputs]!=="number");
 const duration=Math.ceil(input.holdingMonthsOverride ?? settings.holdingMonths);
 function simulate(mode:string,saleFactor=1,renoFactor=1,extraMonths=0,rateExtra=0,priceOverride?:number,withMax=false):CfoScenario{
  const missing=[...missingCommon];
  if(mode==="LOAN") for(const k of ["loanAmount","loanRate","loanFee","loanTermMonths","loanSchedule","loanSecurity"] as const) if(params[k]==null || params[k]==="")missing.push(k);
  if(mode==="INVESTOR")for(const k of ["investorCapital","investorProfitShare","investorLossShare"] as const)if(typeof params[k]!=="number")missing.push(k);
  const months=duration+extraMonths;
  if((params.renovationMonths??1)>months)missing.push("renovationMonths");
  if(mode==="LOAN" && !["ANNUITY","INTEREST_ONLY"].includes(params.loanSchedule??""))missing.push("loanSchedule");
  const existing=calculateUnderwriting(input,baseSettings);
  const u=calculateUnderwriting({...input,priceOverride:priceOverride??input.priceOverride,holdingMonthsOverride:months,renovationTotalOverride:existing.renovationTotal===null?null:existing.renovationTotal*renoFactor,resalePerM2Override:(input.resalePerM2Override??input.resalePerM2.base??0)*saleFactor},baseSettings);
  if(u.purchasePrice===null||u.renovationTotal===null||u.totalProjectCost===null||u.scenarios.base.resaleValue===null)missing.push("economics");
  if((params.deposit??0)>(u.purchasePrice??0))missing.push("deposit");
  if(mode==="LOAN" && (params.loanAmount??0)>(u.purchasePrice??0))missing.push("loanAmount");
  if(missing.length)return {mode,status:"UNKNOWN",missing:[...new Set(missing)],months:[],peakOwnCapital:null,fundingGap:null,financingCost:null,projectProfitBeforeTax:null,ownProfitBeforeTax:null,roiOnPeakEquity:null,breakEvenSale:null,maxBuy:null};
  const price=u.purchasePrice!,renovation=u.renovationTotal!,sale=u.scenarios.base.resaleValue!,deposit=params.deposit!,equipment=params.equipment!;
  const loan=mode==="LOAN"?params.loanAmount!:0, investor=mode==="INVESTOR"?params.investorCapital!:0;
  const rate=mode==="LOAN"?(params.loanRate!+rateExtra)/1200:0,term=params.loanTermMonths??months;
  const payment=rate===0?loan/term:loan*rate/(1-Math.pow(1+rate,-term));
  let outstanding=loan,interestTotal=0,minBalance=0,balance=0;
  const ledger:CashMonth[]=[];
  const add=(month:number,phase:string,expenses:number,funding:number,receipts:number,debtPayment:number)=>{balance=money(balance+funding+receipts-expenses-debtPayment);minBalance=Math.min(minBalance,balance);ledger.push({month,phase,expenses:money(expenses),funding:money(funding),receipts:money(receipts),debtPayment:money(debtPayment),balance:money(balance+params.equity!)});};
  add(0,"Zadatek — część zakupu",deposit,0,0,0);
  // All inherited operating costs occur exactly once; reserve is a cash requirement, not a second expense.
  const inheritedAdditional=money(u.totalProjectCost!-price-(u.purchaseTransactionCosts??0)-renovation-u.holdingCosts-(u.salesCosts??0)-(u.contingency??0));
  for(let m=1;m<=months;m++){
   const interest=money(outstanding*rate);interestTotal+=interest;
   const principal=mode==="LOAN"?(params.loanSchedule==="ANNUITY"?Math.min(outstanding,Math.max(0,payment-interest)):m>=term?outstanding:0):0;
   outstanding=money(outstanding-principal);
   const renoMonths=params.renovationMonths!;
   const renoPortion=m<=renoMonths?money(renovation*m/renoMonths)-money(renovation*(m-1)/renoMonths):0;
   const hold=money(u.holdingCosts*m/months)-money(u.holdingCosts*(m-1)/months);
   add(m,"Zakup / remont / utrzymanie",hold+renoPortion+(m===1?price-deposit+(u.purchaseTransactionCosts??0)+inheritedAdditional+(u.contingency??0)+(mode==="LOAN"?params.loanFee!:0):0),m===1?loan+investor:0,0,interest+principal);
  }
  const financingCost=money(interestTotal+(mode==="LOAN"?params.loanFee!:0));
  const profit=money(sale-u.totalProjectCost!-equipment-financingCost);
  const share=mode==="INVESTOR"?(profit>=0?params.investorProfitShare!:params.investorLossShare!)/100:0;
  const investorReturn=money(investor+profit*share);
  // Capture the pre-sale capital peak before final receipts; furniture is paid before sale.
  add(months,"Wyposażenie przed sprzedażą",equipment,0,0,0);
  add(months,"Sprzedaż / zwrot kapitału",u.salesCosts??0,0,sale,outstanding+(mode==="INVESTOR"?investorReturn:0));
  const peak=money(Math.max(0,-minBalance)),ownProfit=money(profit*(1-share));
  let maxBuy:number|null=null;
  if(withMax && u.maxPurchasePrice!==null){let lo=Math.max(params.deposit??0,mode==="LOAN"?(params.loanAmount??0):0),hi=u.maxPurchasePrice;for(let i=0;i<40;i++){const mid=(lo+hi)/2;const candidate=simulate(mode,saleFactor,renoFactor,extraMonths,rateExtra,mid,false);const p=candidate.projectProfitBeforeTax;const total=p===null?Infinity:sale-p;const pass=p!==null&&p>=settings.minimumProfitPLN&&p/sale*100>=settings.minimumMarginPercent&&p/total*100>=settings.minimumROI;if(pass)lo=mid;else hi=mid;}const final=simulate(mode,saleFactor,renoFactor,extraMonths,rateExtra,lo,false);const p=final.projectProfitBeforeTax;maxBuy=lo<=u.maxPurchasePrice && p!==null && p>=settings.minimumProfitPLN && p/sale*100>=settings.minimumMarginPercent && p/(sale-p)*100>=settings.minimumROI ? Math.floor(lo*100)/100 : null;}
  const saleRate=settings.salesCostPercent/100;
  return {mode,status:"MODELLED",missing:[],months:ledger,peakOwnCapital:peak,fundingGap:money(Math.max(0,peak+params.liquidityReserve!-params.equity!)),financingCost,projectProfitBeforeTax:profit,ownProfitBeforeTax:ownProfit,roiOnPeakEquity:peak>0?money(ownProfit/peak*100):null,breakEvenSale:saleRate<1?money((u.totalProjectCost!-(u.salesCosts??0)+equipment+financingCost)/(1-saleRate)):null,maxBuy};
 }
 const variants=["CASH","LOAN","INVESTOR"].map(mode=>simulate(mode,1,1,0,0,undefined,true));
 const selected=variants.find(v=>v.mode===params.financingMode)??null;
 const stress=selected?.status==="MODELLED"?[["Sprzedaż -5%",.95,1,0,0],["Sprzedaż -10%",.9,1,0,0],["Remont +20%",1,1.2,0,0],["Remont +30%",1,1.3,0,0],["Czas +3 mies.",1,1,3,0],["Czas +6 mies.",1,1,6,0],["Odsetki +2 pp",1,1,0,2],["Łączny: -10%, +30%, +3 mies.",.9,1.3,3,2]].map(([label,sale,reno,extra,rate])=>({label:String(label),result:simulate(selected.mode,Number(sale),Number(reno),Number(extra),Number(rate),undefined,true)})):[];
 return {version:1,inputs:params,selected,variants,stress,missing:selected?.missing??["financingMode",...missingCommon],warnings:["P2a: podatek dochodowy nieustalony; wynik przed podatkiem, nie zysk netto.","Harmonogram jest deklarowanym modelem; kredyt nie jest zatwierdzony. Stopa nominalna nie jest RRSO.","Równe miesięczne etapy remontu; rezerwa kosztowa wydatkowana przy zakupie. Wymaga potwierdzenia kosztorysem."],taxStatus:"UNKNOWN",netProfit:null};
}
