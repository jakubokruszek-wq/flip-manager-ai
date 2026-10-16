/** Shared reconciliation of the existing CFO ledger; no new operating/finance calculator. */
export type TaxCashRow={month:number;phase:string;expenses:number;funding:number;receipts:number;debtPayment:number;balance:number};
export type TaxEconomics={mode:string;purchase:number;purchaseCosts:number;embeddedPcc:number;improvementBudget:number;sale:number;saleCosts:number;projectProfit:number;equity:number;liquidityReserve:number;months:TaxCashRow[]};
export const taxCents=(n:number)=>Math.round((n+Number.EPSILON)*100);
export function reconcileTaxCash(e:TaxEconomics,delta:number):{ledger:TaxCashRow[];balance:number;minimum:number}|null {
 if(e.mode!=="CASH"||![e.purchase,e.purchaseCosts,e.embeddedPcc,e.improvementBudget,e.sale,e.saleCosts,e.equity,e.liquidityReserve].every(n=>Number.isFinite(n)&&n>=0&&n<=100000000)||!Number.isFinite(e.projectProfit)||Math.abs(e.projectProfit)>1000000000||!e.months.length||e.months.some(r=>![r.month,r.expenses,r.funding,r.receipts,r.debtPayment,r.balance].every(n=>Number.isFinite(n)&&Math.abs(n)<=1000000000)||r.expenses<0||r.receipts<0||r.funding!==0||r.debtPayment!==0))return null;
 const purchaseIndex=e.months.findIndex(r=>r.month===1&&r.expenses>=e.purchaseCosts);if(purchaseIndex<0)return null;
 let balance=taxCents(e.equity),minimum=balance;const ledger:TaxCashRow[]=[];
 for(const [i,row] of e.months.entries()){const expenses=taxCents(row.expenses)+(i===purchaseIndex?delta:0);balance+=taxCents(row.receipts)-expenses;minimum=Math.min(minimum,balance);ledger.push({...row,expenses:expenses/100,balance:balance/100});}
 return Math.abs(balance-(taxCents(e.equity)+taxCents(e.projectProfit)-delta))>1?null:{ledger,balance,minimum};
}
