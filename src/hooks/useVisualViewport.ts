import { useEffect, useState } from "react";
import { isKeyboardOpen } from "../lib/phoneTabs";

export type ViewportBox = { height: number | null; top: number; keyboardOpen: boolean };

/**
 * The part of the screen the user can actually see. On phones the on-screen
 * keyboard shrinks the visual viewport but not the layout one, so the phone
 * shell sizes itself to this box: the composer stays above the keyboard and
 * the tab bar hides while it is open.
 */
export function useVisualViewport(): ViewportBox {
  const read = (): ViewportBox => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return { height: null, top: 0, keyboardOpen: false };
    return { height: Math.round(vv.height), top: Math.round(vv.offsetTop), keyboardOpen: isKeyboardOpen(window.innerHeight, vv.height) };
  };
  const [box, setBox] = useState<ViewportBox>(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBox(read());
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return box;
}
