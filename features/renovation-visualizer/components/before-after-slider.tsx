"use client";

import Image from "next/image";
import { useState } from "react";

export function BeforeAfterSlider({ before, after }: { before: string; after: string }) {
  const [position, setPosition] = useState(50);
  return <div><div className="relative aspect-[16/10] overflow-hidden rounded-[1.35rem] border border-white/10 bg-black/20 shadow-2xl shadow-black/20"><Image alt="Oryginał" className="object-cover" fill sizes="(max-width: 1024px) 100vw, 900px" src={before} unoptimized /><div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${position}%` }}><div className="relative h-full" style={{ width: `${10000 / Math.max(position, 1)}%` }}><Image alt="Wizualizacja po remoncie" className="object-cover" fill sizes="(max-width: 1024px) 100vw, 900px" src={after} unoptimized /></div></div><div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_18px_rgba(0,0,0,.65)]" style={{ left: `${position}%` }}><span className="absolute left-1/2 top-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/50 bg-black/55 text-sm text-white backdrop-blur">↔</span></div><span className="absolute left-4 top-4 rounded-full bg-black/55 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white backdrop-blur">After</span><span className="absolute right-4 top-4 rounded-full bg-black/55 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white backdrop-blur">Before</span></div><input aria-label="Before / After" className="mt-4 h-2 w-full cursor-ew-resize accent-[#c8a96b]" max="100" min="0" onChange={(event) => setPosition(Number(event.target.value))} type="range" value={position} /></div>;
}
