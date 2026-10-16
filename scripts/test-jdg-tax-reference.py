"""Independent algebra/ledger oracle, NOT a calculation/certification of ZUS assessment."""
from decimal import Decimal as D, ROUND_HALF_UP
from pathlib import Path
import json
import subprocess
root=Path(__file__).resolve().parents[1]
r=lambda x:x.quantize(D(1),rounding=ROUND_HALF_UP)
cases=[];expected=[]
for price in [D(200000),D(300000),D(340000),D(450000)]:
 pcc=r(price*D('.02'));sale=D(450000);profit=sale-price-pcc-D(8000)-D(70000)-D(9000)
 income=sale-price-pcc-D(8000)-D(60000)-D(9000)-D(1000)-D(12000)-D(5000);pit=r(r(max(D(0),income))*D('.19'))
 e=dict(mode='CASH',purchase=float(price),purchaseCosts=float(pcc+8000),embeddedPcc=float(pcc),improvementBudget=50000,sale=450000,saleCosts=9000,projectProfit=float(profit),equity=800000,liquidityReserve=30000,months=[dict(month=m,phase=phase,expenses=float(expense),funding=0,receipts=receipt,debtPayment=0,balance=0) for m,phase,expense,receipt in [(0,'Deposit',D(20000),0),(1,'Purchase',price-D(20000)+pcc+D(8000)+D(50000),0),(2,'Holding/equipment',D(20000),0),(6,'Sale',D(9000),450000)]])
 extra=dict(jdgOccupationOn='2020-01-01',jdgAcquisitionFees='8000',jdgOperatingCosts='60000',jdgDisposalCosts='9000',jdgHealthDeduction='5000',jdgQualificationRef='https://example.test/synthetic-assessment',jdgPayments=f'2026-05-20 | SOCIAL | 12000\n2026-05-20 | FUND | 1000\n2026-12-20 | HEALTH | 6000\n2026-11-20 | PIT | {pit}')
 cases.append([extra,dict(acquired='2026-04-01',sale='2026-10-01'),e]);expected.append((income,pit,profit-D(12000)-D(1000)-D(6000)-pit))
js='import {jdgTaxModel,JDG_ENUMS} from "./features/investment-os/jdg-tax.ts";console.log(JSON.stringify('+json.dumps(cases)+'.map(([p,d,e])=>jdgTaxModel({...JDG_ENUMS,...p},d,e))));'
run=subprocess.run(['node','--experimental-strip-types','--import','./scripts/test-alias-loader.mjs','--input-type=module','-e',js],cwd=root,check=True,capture_output=True,text=True)
for actual,(income,pit,net) in zip(json.loads(run.stdout),expected,strict=True):
 assert actual['status']=='MODELLED_ESTIMATE',actual
 assert D(str(actual['taxableIncome']))==income
 assert D(str(actual['pit']))==pit
 assert D(str(actual['profitAfterTaxAndContributions']))==net
 assert D(str(actual['cashFlow'][-1]['balance']))==D(800000)+net
 assert actual['actualLiability'] is None
print('Independent JDG algebra/cash: 4/4 PASS; supplied contribution assumptions not legally certified')
