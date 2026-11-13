import { useEffect, useState } from "react";

/** True at ≤ 760 px (the phone layout of every Contacts screen, §E.1.5). */
export function usePhone() {
  const query = "(max-width: 760px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const change = () => setPhone(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return phone;
}
