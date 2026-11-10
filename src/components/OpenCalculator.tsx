"use client";

import { openCalculator } from "@/lib/calculator-events";

export default function OpenCalculator({ className, children }: { className?: string; children: React.ReactNode }) {
  return <button type="button" className={className} onClick={() => openCalculator()}>{children}</button>;
}
