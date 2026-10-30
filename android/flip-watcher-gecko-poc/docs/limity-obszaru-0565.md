# 0.5.65: confirmed own images blocked by DOM work limits

Phone 0.5.64, post 1634717548346388: 73 IMG, 5 exact own Story sources,
5 without article, 0 accepted, 5 regionLimit; all other region rejection reasons
zero. The phone evidence proves a workload gate, but does not distinguish its
three former thresholds (20 semantic roots, 32 ancestor nodes, 200 anchors).

The source-only path now permits 512 semantic roots, 512 ancestor nodes and 4096
anchors. The full permitted ancestry and anchor list are inspected; there is no
prefix/truncation acceptance. Over-budget documents still fail closed. Foreign
IDs/links after the former thresholds still reject, as do comments, independent
regions, source changes, missing consent and context loss. Only exact own Story
sources can use this path. Article/alias/explicit-link proof rules are unchanged.

The existing regionLimit counter is retained and split into bounded numeric
rootLimit/depthLimit/anchorLimit counts (sum <= regionLimit). Diagnoses with
9/16/17/22 fields remain readable; the new schema has 25 numeric fields. No URLs,
HTML or OCR text are added to stored diagnostics. Package/signature/core and
local database behavior remain unchanged.

JS regressions exercise each former limit and show failure at former thresholds;
positive cases must capture, while a foreign ancestor beyond depth 32 or foreign
link after 300 harmless links must reject for identity, not the work limit.
Upper-bound cases above 512/512/4096 still reject with the correct limit kind.

Native fixtures use 73 IMG / 5 exact own sources: 80 nested DIV wrappers, 300
links or 25 hidden semantic roots must produce an actual crop and MLKit price.
Foreign ID beyond 80 wrappers and foreign link after 300 links must not crop.
These are local GeckoView emulator tests, not a real Facebook account/device.
