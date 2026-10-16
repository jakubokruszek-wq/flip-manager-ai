"""Independent full-transaction Decimal oracle. Synthetic inputs; no DB or network."""
from decimal import Decimal as D, ROUND_HALF_UP
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parents[1]
cent = lambda n: n.quantize(D(".01"), rounding=ROUND_HALF_UP)
whole = lambda n: n.quantize(D(1), rounding=ROUND_HALF_UP)
num = lambda n: float(n)
facts = dict(privateActivity="NON_BUSINESS", privateTitle="PAID_SOLE_OWNER", privateVat="OUTSIDE_VAT_NO_DEDUCTION", privateExclusions="STANDARD_ONLY", privatePcc="STANDARD_MARKET_PRICE", privateSaleMarket="MARKET_PRICE", privateCostEvidence="DOCUMENTED", privateAcquisitionFees="8000", privateDisposalCosts="9000", privateQualificationRef="https://example.test/synthetic-qualification")
cases, expected = [], []
for price in [D("300000"), D("300025.01")]:
 for sale in [D("300000"), D("450000"), D("500000")]:
  for improvement in [D(0), D(40000)]:
   embedded=cent(price*D(".02")); pcc=whole(whole(price)*D(".02"))
   costs=embedded+D(8000); profit=sale-price-costs-D(50000)-D(20000)-D(9000)
   acquisition=price+pcc+D(8000); revenue=sale-D(9000); income=revenue-acquisition-improvement
   pit=whole(whole(max(D(0),income))*D(".19")); net=profit-(pcc-embedded)-pit
   rows=[dict(month=0,phase="Deposit",expenses=30000,funding=0,receipts=0,debtPayment=0,balance=470000),dict(month=1,phase="Purchase",expenses=num(price-D(30000)+costs+D(50000)),funding=0,receipts=0,debtPayment=0,balance=0),dict(month=2,phase="Hold/equipment",expenses=20000,funding=0,receipts=0,debtPayment=0,balance=0),dict(month=6,phase="Sale",expenses=9000,funding=0,receipts=num(sale),debtPayment=0,balance=0)]
   e=dict(mode="CASH",purchase=num(price),purchaseCosts=num(costs),embeddedPcc=num(embedded),improvementBudget=50000,sale=num(sale),saleCosts=9000,projectProfit=num(profit),equity=500000,liquidityReserve=30000,months=rows)
   cases.append([dict(facts,privateImprovements=str(improvement)),dict(acquired="2026-04-01",sale="2026-10-01"),e])
   expected.append(dict(pcc=pcc,taxRevenue=revenue,acquisitionBasis=acquisition,taxableIncome=income,pit=pit,profitAfterPit=net,ending=D(500000)+net))
js='import {privateTaxModel} from "./features/investment-os/private-tax.ts";console.log(JSON.stringify('+json.dumps(cases)+'.map(args=>privateTaxModel(...args))));'
p=subprocess.run(["node","--experimental-strip-types","--import","./scripts/test-alias-loader.mjs","--input-type=module","-e",js],cwd=root,check=True,capture_output=True,text=True)
for actual, oracle in zip(json.loads(p.stdout),expected,strict=True):
 assert actual["status"]=="MODELLED_ESTIMATE", actual
 for k,v in oracle.items():
  got=actual["cashFlow"][-1]["balance"] if k=="ending" else actual[k]
  assert D(str(got))==v,(k,got,v)
 assert actual["actualLiability"] is None
print(f"Independent full PRIVATE model: {len(cases)}/{len(cases)} PASS; qualified synthetic assumptions only")
