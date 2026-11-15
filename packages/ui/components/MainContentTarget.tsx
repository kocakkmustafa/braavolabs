"use client";
import { usePathname } from "next/navigation";
import { ownsMain } from "../lib/mainContent";

/** 404/hata ekranı: kabuk bu yolda id vermiyorsa (`ownsMain`) skip-link hedefini kendisi taşır; aksi halde kabuk verir (tek id). */
export default function MainContentTarget({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  return ownsMain(pathname) ? <div id="main-content" tabIndex={-1}>{children}</div> : <>{children}</>;
}
