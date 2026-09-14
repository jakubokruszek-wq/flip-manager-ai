import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Deal Room is a presentation over CanonicalDeal and does not add a second write path", () => {
  const view = read("features/investment-os/components/deal-room-view.tsx");
  assert.match(view, /type \{ CanonicalDeal, DealFactOverrides, DirectorOutput, InformationRequest \}/);
  assert.match(view, /deal\.ceo\.result/);
  assert.match(view, /deal\.underwriting\.result/);
  assert.match(view, /deal\.informationRequests/);
  assert.match(view, /deal\.evidenceFabric/);
  assert.doesNotMatch(view, /fetch\(|\/api\//);
  assert.match(view, /Oczekuje na zapisane wyniki/);
  assert.match(view, /Rekomendacja systemu/);
  assert.doesNotMatch(view, /Brak zapisanej rekomendacji CEO/);
  assert.match(view, /Kompletność danych oferty/);
  assert.match(view, /Co zmieni rekomendację systemu\?/);
  assert.doesNotMatch(view, /Kompletność analizy/);
  assert.match(view, /Pokaż pełną historię/);
  assert.doesNotMatch(view, /Zapisano wynik dyrektora|Zapisano dowód/);
  assert.match(view, /function DirectorDetails/);
  assert.match(view, /Nie tworzymy pozorowanej historii/);
});

test("canonical listing route keeps GET read-only and exposes initialization only as an explicit NOT_COMPUTED action", () => {
  const route = read("app/(app)/deals/[listingId]/page.tsx");
  const desk = read("features/investment-os/components/investment-desk.tsx");
  const client = read("features/investment-os/investment-client.ts");
  const getRoute = read("app/api/flip-finder/listings/[id]/investment/route.ts");
  assert.match(route, /<InvestmentDesk result=\{\{ id: listingId \}\} room \/>/);
  assert.match(desk, /if \(room\) return <DealRoomView/);
  assert.match(desk, /loadInvestmentDeal\(result\.id\)/);
  assert.match(client, /InvestmentDealNotComputedError/);
  assert.match(desk, /notComputed/);
  assert.match(getRoute, /investmentDealReadResponse\(\(await params\)\.id, getInvestmentDeal\)/);
  assert.doesNotMatch(getRoute, /initializeInvestmentDeal|method:\s*["']POST["']/);
  assert.match(desk, /if \(!notComputed \|\| initializationInFlight\.current\) return/);
  assert.match(desk, /\/investment\/initialize/);
  assert.match(desk, /method: "POST"/);
  assert.match(desk, /data-initialize-deal/);
  assert.match(desk, /onClick=\{\(\) => void initialize\(\)\}/);
  const mountEffect = desk.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[load\]\);/);
  assert.ok(mountEffect);
  assert.doesNotMatch(mountEffect[1], /initialize|POST/);
});

test("property Deal Room link is available only for an existing canonical listing id", () => {
  const manualPage = read("features/properties/components/new-property-page.tsx");
  const propertyDialog = read("features/properties/components/property-dialog.tsx");
  const propertyService = read("services/properties.service.ts");
  assert.doesNotMatch(manualPage, /response\.dealRoomUrl/);
  assert.match(propertyService, /listingId: stringOrNull\(row\.listing_id\)/);
  assert.match(propertyDialog, /property\.listingId \? <Button[^>]+render=\{<Link href=\{`\/deals\/\$\{encodeURIComponent\(property\.listingId\)\}`\}/);
  assert.match(propertyDialog, /Brak powiązanego ogłoszenia\. Deal Room nie jest dostępny/);
});
