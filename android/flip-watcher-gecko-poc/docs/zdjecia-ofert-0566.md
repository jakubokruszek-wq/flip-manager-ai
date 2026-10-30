# 0.5.66: photo collection before OCR

The text-review queue intentionally selected unclassified posts. Reusing it for
image acquisition skipped already recognized offers without photos. Acquired
images were also checkpointed only after OCR, and a successful repeated search
could remove stored photos of retained post IDs when the feed captured none.

After a newly consented search, the automatic checkbox now explicitly selects
photo collection without OCR. A separate Uzupełnij zdjęcia ofert button also
works on retained results after opening the approved group, without a new scan.
Recognized offers missing photos precede manual candidates missing photos.
Posts already holding a local thumbnail are skipped. One confirmed rendered
image per post gives sparse offers coverage first, within 20 posts / 3 minutes.
No change to the exact post/group/media ownership checks that worked on phone
in 0.5.65; no document-wide fallback for avatars or unproven media.

Each acquired photo is durably written before opening the next post. The disk
job owns pixel copies and finishes independently of Activity cancellation.
The live thumbnail cache gets separate copies, so completed photos appear in
the current offer list and survive source cleanup. Current OCR actions also
save the image before running recognition. A repeated successful search retains
previous photos only for IDs still present in its new snapshot; new images
replace matching slots, and unrelated old IDs are not retained.

OCR is manual/separate and its prior suggestions remain. Native capture still
needs foreground/focus/consent; pause cancels further acquisition while completed
writes survive. No background browser service, new network response reader,
extra media fetch, upload, backend or collector-core change. Kasuj bazę clears
the photo counts as well as the existing database.

Coverage: queue ordering/skipping/canonical input/summary validation JVM cases;
actual GeckoView crop of an eligible offer omitted by the former text queue,
then archive persistence without running OCR; native pixel-copy ownership,
failed-save preservation, existing-photo retention through PocActivity's real
publish path, separate UI button and explicit photo-only scan consent.
