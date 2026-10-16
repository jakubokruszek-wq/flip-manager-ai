"""Synthetic arithmetic oracle only: this does not certify legal eligibility."""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parents[1]
values = ["0", "0.03", "100.49", "100.50", "102.50", "100000", "300000", "123000", "108000", "100000000.00"]
rates = {"PRIVATE_PIT19": 19, "JDG_LINEAR19": 19, "COMPANY_CIT19": 19, "DIVIDEND_PIT19": 19, "PCC2": 2, "PCC6": 6, "VAT_GROSS23": 23, "VAT_GROSS8": 8}
cases = [[rule, amount] for rule in rates for amount in values]
script = 'import {conditionalTax} from "./features/investment-os/tax-arithmetic.ts";console.log(JSON.stringify(' + json.dumps(cases) + '.map(([rule,amount])=>conditionalTax(rule,amount))));'
run = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", script], cwd=root, text=True, check=True, capture_output=True)
results = json.loads(run.stdout)
for (rule, value), actual in zip(cases, results, strict=True):
    gross = Decimal(value)
    percent = Decimal(rates[rule])
    if rule.startswith("VAT_"):
        expected = (gross * percent / (100 + percent)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        assert Decimal(str(actual["netInvoicePLN"])) + expected == gross
    else:
        base = gross.quantize(Decimal(1), rounding=ROUND_HALF_UP)
        expected = (base * percent / 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        assert Decimal(str(actual["roundedBasePLN"])) == base
    assert Decimal(str(actual["amountPLN"])) == expected, (rule, value, actual, expected)
    assert actual["actualLiabilityPLN"] is None
print(f"Independent Decimal oracle: {len(cases)}/{len(cases)} PASS (arithmetic, not qualification)")
