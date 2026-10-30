# 0.5.64: visible photos in boxless or nested semantic regions

Phone 0.5.63, post 1635418478276295: 45 IMG, 5 exact own Story sources,
5 without article, 0 anchorOwner/sourceOwner/foreignOwner/excludedOwner.
Ownership failed inside the source-only region path, before size/pixels.
The old report does not distinguish its remaining early-return gates.

Reproduced two actual code defects (not yet confirmed as the phone's DOM):
- display:contents main/body has no CSS box, so checkVisibility on the ancestor
  returns false while its own IMG remains visible;
- main wrapping role=main was counted as two independent visible roots.

For exact own Story sources only, a boxless ancestor can use the already-visible
IMG as evidence. Nested roots in its ancestor chain form one region. Independent
roots, comments, foreign identities and changed sources remain rejected.
Limits (20 roots, 32 ancestor steps, 200 anchors) are preserved, now explicitly
reported with count-only regionMissing/Ambiguous/Hidden/Excluded/Limit counters.
Old 9/16/17-field archive diagnoses still decode with zero new counters.

Local JS regressions fail against the former region logic and pass with the fix.
Native fixtures use the actual Gecko DOM/CSS, raster crop and bundled MLKit:
boxless main and nested main must read the PNG price; independent nested sibling
must produce no crop. No Facebook account/network fixtures, no source URL export,
no full-page OCR fallback and no backend changes.
