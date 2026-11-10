"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { OPEN_EVENT, type CalculatorPrefill } from "@/lib/calculator-events";

const FareCalculator = dynamic(() => import("./FareCalculator"), { ssr: false });

/** Mounts the calculator on demand when any "Calculate your fare" control fires the open event. */
export default function CalculatorHost() {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<CalculatorPrefill>({});

  useEffect(() => {
    const onOpen = (e: Event) => {
      setPrefill((e as CustomEvent<CalculatorPrefill>).detail ?? {});
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  return open ? <FareCalculator prefill={prefill} onClose={() => setOpen(false)} /> : null;
}
