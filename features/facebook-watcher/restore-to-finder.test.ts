import test from "node:test";
import assert from "node:assert/strict";
import { classifyFacebookRestore } from "./restore-to-finder.ts";
import type { SearchFilter } from "@/features/flip-finder";

const filter = { id: "f1", name: "Facebook", sources: ["facebook"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: 32, areaMax: 58, rooms: [1, 2, 3, 4], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: true, buildingTypes: [], ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 7000, requiredKeywords: [], excludedKeywords: [], minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" } satisfies SearchFilter;
const candidate = { price: 305000, area: 44.93, pricePerSqm: 6788.3374, rooms: 2, floor: null, city: "Łódź", district: "Widzew", title: "Mieszkanie", locationText: "Widzew, Łódź", buildingType: null, sellerType: null, ownership: null, marketType: null };

test("the real archived Widzew listing restores as REVIEW under the current filter", () => { const result = classifyFacebookRestore(candidate, [filter]); assert.equal(result.bucket, "REVIEW"); assert.deepEqual(result.decision?.unknownFields, ["topFloor"]); });
test("a listing failing every active filter is not restorable", () => { assert.equal(classifyFacebookRestore({ ...candidate, price: 900000, pricePerSqm: 20000 }, [filter]).bucket, "REJECTED"); });
