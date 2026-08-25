import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "KVKK Aydınlatma Metni — Braavolabs",
  description:
    "Braavolabs KVKK aydınlatma metni: kişisel verilerin işlenmesi, hukuki dayanakları, saklama süreleri ve 6698 sayılı KVKK kapsamındaki haklarınız.",
  alternates: { canonical: "https://www.braavolabs.com/kvkk" },
  openGraph: {
    title: "Braavolabs KVKK Aydınlatma Metni",
    description:
      "Kişisel verilerin işlenmesi, hukuki dayanakları, saklama süreleri ve KVKK kapsamındaki haklarınız.",
    url: "https://www.braavolabs.com/kvkk",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Braavolabs" }],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
